import type { IpcMainInvokeEvent } from 'electron';
import type * as configStoreModule from '../../config-store.js';
import { makePreScriptId } from '../../compound-id.js';
import type { PreStepScriptRef, WorkflowTrigger } from '../../domain-types.js';
import type { WorkflowEntry } from '../../ipc-contract.js';
import type { WorkflowRunner } from '../../workflow-runner.js';
import {
  ipcBooleanField,
  ipcNumber,
  ipcRecord,
  ipcString,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';

/**
 * The workflows over IPC: their configuration (list, save, create, delete,
 * enable, the startup trigger), their runs (run, stop, retry, run state, per
 * script logs) and the tray-only group visibility the same screens set. Each
 * handler narrows its payload; every write broadcasts. Validation of a whole
 * workflow happens in the store (src/workflows.ts): a refused one throws its
 * user-facing reason back to the renderer and nothing is stored.
 */

export interface WorkflowsIpcDeps {
  configStore: Pick<
    typeof configStoreModule,
    | 'saveWorkflow'
    | 'createWorkflow'
    | 'deleteWorkflow'
    | 'setWorkflowEnabled'
    | 'makeStartupWorkflow'
    | 'setGroupHiddenInTray'
  >;
  workflowRunner: Pick<
    WorkflowRunner,
    | 'run'
    | 'stop'
    | 'retryFrom'
    | 'runStates'
    | 'runState'
    | 'scriptLog'
    | 'isRunning'
  >;
  /** The list rows the renderers show (see state-snapshot.ts). */
  workflowEntries: () => WorkflowEntry[];
  broadcast: () => void;
  /** The logs window, on one process id. */
  openLogs: (processId: string) => void;
  /** The settings window, on its Workflows section. */
  openWorkflowsConfig: () => void;
}

function ipcRef(value: unknown): PreStepScriptRef {
  const raw = ipcRecord(value, 'ref');
  return {
    groupId: ipcString(raw.groupId, 'groupId'),
    scriptId: ipcString(raw.scriptId, 'scriptId'),
  };
}

/** Only the shape: `createWorkflow` normalizes the rest of the trigger. */
function ipcTrigger(value: unknown): WorkflowTrigger {
  const raw = ipcRecord(value, 'trigger');
  ipcString(raw.kind, 'trigger.kind');
  return raw as unknown as WorkflowTrigger;
}

export function registerWorkflowsIpc(
  ipc: IpcRegistrar,
  deps: WorkflowsIpcDeps,
): void {
  const { configStore, workflowRunner: runner, broadcast } = deps;
  const workflowId = (payload: unknown): string =>
    ipcStringField(payload, 'workflowId');
  /** Runs a store write and broadcasts only once it went through. */
  const write = <T>(apply: () => T): T => {
    const result = apply();
    broadcast();
    return result;
  };

  ipc.handle('workflows:list', () => deps.workflowEntries());
  ipc.handle('workflows:save', (_e: IpcMainInvokeEvent, payload: unknown) =>
    write(() => configStore.saveWorkflow(ipcRecord(payload).workflow)),
  );
  ipc.handle('workflows:create', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const name = ipcString(raw.name, 'name');
    const trigger = ipcTrigger(raw.trigger);
    return write(() => configStore.createWorkflow(name, trigger));
  });
  ipc.handle('workflows:delete', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const id = workflowId(payload);
    // Never orphan a run: its scripts would keep going with no workflow.
    if (runner.isRunning(id)) runner.stop(id);
    write(() => configStore.deleteWorkflow(id));
    return { ok: true };
  });
  ipc.handle(
    'workflows:setEnabled',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const id = workflowId(payload);
      const enabled = ipcBooleanField(payload, 'enabled');
      return write(() => configStore.setWorkflowEnabled(id, enabled));
    },
  );
  ipc.handle(
    'workflows:makeStartup',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const id = workflowId(payload);
      return write(() => configStore.makeStartupWorkflow(id));
    },
  );

  // ── Runs ─────────────────────────────────────────────────────────────
  // A run from a window is always a manual one: it is what asks first when
  // the workflow says so.
  ipc.handle('workflows:run', (_e: IpcMainInvokeEvent, payload: unknown) =>
    runner.run(workflowId(payload), 'manual'),
  );
  ipc.handle('workflows:stop', (_e: IpcMainInvokeEvent, payload: unknown) =>
    runner.stop(workflowId(payload)),
  );
  ipc.handle(
    'workflows:retryFrom',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      runner.retryFrom(workflowId(payload), ipcStringField(payload, 'blockId')),
  );
  ipc.handle('workflows:runState', () => runner.runStates());
  ipc.handle(
    'workflows:scriptLog',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const runId =
        raw.runId === 'latest' ? 'latest' : ipcNumber(raw.runId, 'runId');
      return runner.scriptLog(workflowId(payload), runId, ipcRef(raw.ref));
    },
  );
  ipc.handle(
    'workflows:openLog',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      if (raw.ref !== null && raw.ref !== undefined) {
        const ref = ipcRef(raw.ref);
        deps.openLogs(makePreScriptId(ref.groupId, ref.scriptId));
        return { ok: true };
      }
      const state = runner.runState(workflowId(payload));
      if (!state) return { ok: false, error: 'not_run' };
      deps.openLogs(state.aggregatorId);
      return { ok: true };
    },
  );
  ipc.handle('workflows:openConfig', () => {
    deps.openWorkflowsConfig();
    return { ok: true };
  });

  // ── Groups in the tray ───────────────────────────────────────────────
  ipc.handle(
    'groups:setHiddenInTray',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const hidden = ipcBooleanField(payload, 'hidden');
      return write(() => configStore.setGroupHiddenInTray(groupId, hidden));
    },
  );
}
