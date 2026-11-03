import type { Group, LogEntry, ProcessState } from '../../domain-types.js';
import type {
  GroupState,
  WorkflowEntry,
  WorkflowRunState,
} from '../../ipc-contract.js';
import type { WindowRegistry } from '../renderer-bus.js';
import { record } from '../remote/validate.js';
import {
  createRuntimeActions,
  type RuntimeActions,
  type RuntimeActionsDeps,
} from '../runtime-actions.js';

/**
 * Everything the MCP tools read and drive, assembled from collaborators
 * main.ts already has — the same process manager, confirmation gate,
 * runtime actions and snapshots the windows and «Control remoto» use, so an
 * assistant can never start something a window could not, nor skip a
 * command's own «Confirmar antes de arrancar».
 */

type Outcome = { ok: boolean; error?: string | undefined };

export interface McpRuntime {
  listGroups(): Group[];
  groupStates(): GroupState[];
  workflowEntries(): WorkflowEntry[];
  workflowRunState(workflowId: string): WorkflowRunState | null;
  /** The group's git branch, asked now: the snapshots never carry it. */
  currentBranch(groupId: string): Promise<string | null>;
  logs(processId: string): readonly LogEntry[];
  processState(
    processId: string,
  ): Pick<
    ProcessState,
    'status' | 'lastExitCode' | 'lastFinishedAt' | 'startedAt'
  >;
  startProcess: RuntimeActions['startProcess'];
  stopProcess: RuntimeActions['stopProcess'];
  runAction: RuntimeActions['runAction'];
  /** Resolves when the run ends. */
  runWorkflow(workflowId: string): Promise<unknown>;
  stopWorkflow(workflowId: string): Outcome;
  /** Groups or workflows changed (status, ports, config): the bus' pulse. */
  onChange(listener: (what: 'groups' | 'workflows') => void): () => void;
}

/** The slice of main.ts's collaborators this is built from. */
export interface McpRuntimeWiring extends Omit<
  RuntimeActionsDeps,
  'processManager' | 'workflowRunner'
> {
  configStore: RuntimeActionsDeps['configStore'];
  processManager: Omit<RuntimeActionsDeps['processManager'], 'getState'> & {
    getLogs(id: string): LogEntry[];
    getState(id: string): ProcessState;
  };
  workflowRunner: RuntimeActionsDeps['workflowRunner'] & {
    runState(workflowId: string): WorkflowRunState | null;
  };
  snapshots: {
    snapshotGroupStates(): GroupState[];
    workflowEntries(): WorkflowEntry[];
  };
  registry: WindowRegistry;
}

export function mcpRuntime(app: McpRuntimeWiring): McpRuntime {
  const actions = createRuntimeActions(app);
  const listeners = new Set<(what: 'groups' | 'workflows') => void>();
  // The MCP sessions hear the renderer stream as one more bus listener.
  app.registry.listeners.add({
    send: (channel) => {
      const what =
        channel === 'groups:update'
          ? 'groups'
          : channel === 'workflows:update'
            ? 'workflows'
            : null;
      if (what) for (const listener of listeners) listener(what);
    },
  });
  return {
    listGroups: () => app.configStore.listGroups(),
    groupStates: () => app.snapshots.snapshotGroupStates(),
    workflowEntries: () => app.snapshots.workflowEntries(),
    workflowRunState: (id) => app.workflowRunner.runState(id),
    currentBranch: async (groupId) => {
      // git owns its failures (ok: false); a rejection reads the same way.
      const answer = record(
        await actions.currentBranch(groupId).catch(() => null),
      );
      return answer?.ok === true && typeof answer.branch === 'string'
        ? answer.branch
        : null;
    },
    logs: (id) => app.processManager.getLogs(id),
    processState: (id) => app.processManager.getState(id),
    startProcess: (id) => actions.startProcess(id),
    stopProcess: (id) => actions.stopProcess(id),
    runAction: (groupId, actionId) => actions.runAction(groupId, actionId),
    runWorkflow: (id) => actions.runWorkflow(id),
    stopWorkflow: (id) => actions.stopWorkflow(id),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
