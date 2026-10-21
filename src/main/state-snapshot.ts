import { deriveColor } from '../process-manager.js';
import { makeActionId, makeCommandId } from '../compound-id.js';
import type {
  GlobalSettings,
  Group,
  ProcessState,
  Workflow,
  WorkflowRunRecord,
} from '../domain-types.js';
import { runnableScriptCount } from '../pipeline-graph.js';
import { nextWorkflowRun } from '../scheduler.js';
import { workflowScheduleKey } from './schedule-runner.js';
import type {
  GroupState,
  TrayColor,
  WorkflowEntry,
  WorkflowRunState,
} from '../ipc-contract.js';

/**
 * The two payloads every broadcast carries: the per-group runtime state and
 * the workflow list rows. Both are pure reads over the config store, the
 * process manager and the workflow runner — no Electron — so the aggregation
 * rules (which command tints a group, when a schedule fires next) can be
 * tested directly.
 */

interface SnapshotConfigStore {
  listGroups: () => Group[];
  getGlobalSettings: () => GlobalSettings;
  listWorkflows: () => Workflow[];
  getWorkflowRuns: () => Record<string, WorkflowRunRecord>;
  getScheduleLastRun: (key: string) => string | null;
}

interface SnapshotProcessManager {
  getState: (id: string) => ProcessState;
}

export interface StateSnapshotDeps {
  configStore: SnapshotConfigStore;
  processManager: SnapshotProcessManager;
  workflowRunner: {
    runState: (workflowId: string) => WorkflowRunState | null;
    isRunning: (workflowId: string) => boolean;
  };
  /** Group-level transient errors (not persisted). */
  groupErrors: ReadonlyMap<string, string | null>;
  now?: () => number;
}

export interface StateSnapshots {
  snapshotGroupStates: () => GroupState[];
  workflowEntries: () => WorkflowEntry[];
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
  const { configStore, processManager, workflowRunner, groupErrors } = deps;
  const now = deps.now ?? Date.now;

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

    workflowEntries(): WorkflowEntry[] {
      const runs = configStore.getWorkflowRuns();
      const at = new Date(now());
      return configStore.listWorkflows().map((workflow) => {
        const { trigger } = workflow;
        const next =
          trigger.kind === 'schedule' && workflow.enabled
            ? nextWorkflowRun(
                trigger.schedule,
                configStore.getScheduleLastRun(
                  workflowScheduleKey(workflow.id),
                ),
                at,
              )
            : null;
        const live = workflowRunner.isRunning(workflow.id)
          ? workflowRunner.runState(workflow.id)
          : null;
        return {
          workflow,
          lastRun: runs[workflow.id] ?? null,
          nextRunAt: next ? next.getTime() : null,
          scriptCount: runnableScriptCount(workflow.graph),
          running: live
            ? {
                runId: live.runId,
                doneScripts: live.doneScripts,
                totalScripts: live.totalScripts,
                startedAt: live.startedAt,
              }
            : null,
        };
      });
    },
  };
}
