import { deriveColor } from '../process-manager.js';
import { makeActionId, makeCommandId } from '../compound-id.js';
import type {
  GlobalSettings,
  Group,
  PreStep,
  ProcessState,
} from '../domain-types.js';
import type { GroupState, PipelineState, TrayColor } from '../ipc-contract.js';

/**
 * The two payloads every broadcast carries: the per-group runtime state and
 * the ONE global pre-script pipeline's state. Both are pure reads over the
 * config store, the process manager and the runner — no Electron — so the
 * aggregation rules (which command tints a group, which run id survives a
 * cleared badge) can be tested directly.
 */

interface SnapshotConfigStore {
  listGroups: () => Group[];
  getGlobalSettings: () => GlobalSettings;
  getPreSteps: () => PreStep[];
}

interface SnapshotProcessManager {
  getState: (id: string) => ProcessState;
}

interface SnapshotRunState {
  status: PipelineState['status'];
  currentStep: number;
  totalSteps: number;
  runId: number;
  startedAt: number;
}

interface SnapshotRecentResult {
  status: 'done' | 'error';
  error: string | null;
  runId: number;
}

interface SnapshotRunner {
  getRunState: () => SnapshotRunState | null;
  getRecentResult: () => SnapshotRecentResult | null;
}

export interface StateSnapshotDeps {
  configStore: SnapshotConfigStore;
  processManager: SnapshotProcessManager;
  preScriptRunner: SnapshotRunner;
  /** Group-level transient errors (not persisted). */
  groupErrors: ReadonlyMap<string, string | null>;
}

export interface StateSnapshots {
  snapshotGroupStates: () => GroupState[];
  snapshotPipelineState: () => PipelineState;
  /** After `stopAll` wiped every buffer, a stale run id must not linger. */
  forgetPipelineRunId: () => void;
}

/** Aggregate group colour: worst over running commands. */
function aggregateGroupColor(
  commandStates: readonly {
    status: string;
    color: TrayColor;
    lastError: unknown;
  }[],
): TrayColor {
  let groupColor: TrayColor = 'stopped';
  for (const cs of commandStates) {
    if (cs.status === 'running') {
      if (cs.color === 'error') {
        groupColor = 'error';
        break;
      }
      if (cs.color === 'warn') groupColor = 'warn';
      else if (cs.color === 'running' && groupColor === 'stopped')
        groupColor = 'running';
    }
  }
  // Check lastError on running commands too
  if (groupColor === 'stopped' && commandStates.some((cs) => cs.lastError))
    groupColor = 'error';
  return groupColor;
}

export function createStateSnapshots(deps: StateSnapshotDeps): StateSnapshots {
  const { configStore, processManager, preScriptRunner, groupErrors } = deps;
  // Kept beyond the recent-result badge TTL so the tray can still open that
  // run's (still-retained) log buffer.
  let lastPipelineRunId: string | null = null;

  return {
    snapshotGroupStates(): GroupState[] {
      const globals = configStore.getGlobalSettings();
      return configStore.listGroups().map((group) => {
        const commandStates = (group.commands || []).map((cmd) => {
          const pid = makeCommandId(group.id, cmd.id);
          const state = processManager.getState(pid);
          return {
            commandId: cmd.id,
            processId: pid,
            status: state.status,
            warnCount: state.warnCount,
            errorCount: state.errorCount,
            lastError: state.lastError,
            startedAt: state.startedAt,
            color: deriveColor(state, cmd, group, globals),
            muteWarn: !!(
              globals.silenceWarnings ||
              group.silenceWarnings ||
              cmd.silenceWarnings
            ),
            muteErr: !!(
              globals.silenceErrors ||
              group.silenceErrors ||
              cmd.silenceErrors
            ),
          };
        });
        const actionStates = (group.actions || []).map((act) => {
          const pid = makeActionId(group.id, act.id);
          const state = processManager.getState(pid);
          return {
            actionId: act.id,
            processId: pid,
            status: state.status || 'idle',
            lastExitCode: state.lastExitCode,
            lastFinishedAt: state.lastFinishedAt,
            startedAt: state.startedAt,
          };
        });
        return {
          groupId: group.id,
          group,
          currentBranch: null, // populated async by renderer via git:currentBranch
          color: aggregateGroupColor(commandStates),
          commands: commandStates,
          actions: actionStates,
          lastError: groupErrors.get(group.id) || null,
        };
      });
    },

    snapshotPipelineState(): PipelineState {
      const runState = preScriptRunner.getRunState();
      const recentResult = preScriptRunner.getRecentResult();
      const status = runState
        ? runState.status
        : recentResult
          ? recentResult.status
          : 'idle';
      const lastError =
        recentResult && recentResult.status === 'error'
          ? recentResult.error
          : null;
      // The live run id (running / within the recent-result TTL). Persisted
      // beyond both so the tray's "ver logs del pipeline" button survives after
      // the status badge clears — the aggregator log buffer itself outlives it.
      const liveRunId = runState
        ? String(runState.runId)
        : recentResult
          ? String(recentResult.runId)
          : null;
      if (liveRunId) lastPipelineRunId = liveRunId;
      return {
        status,
        currentStep: runState ? runState.currentStep : null,
        totalSteps: runState
          ? runState.totalSteps
          : configStore.getPreSteps().length,
        lastError,
        lastRunId: liveRunId || lastPipelineRunId,
        startedAt: runState ? runState.startedAt : null,
      };
    },

    forgetPipelineRunId(): void {
      lastPipelineRunId = null;
    },
  };
}
