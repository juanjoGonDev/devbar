import type { IpcMainInvokeEvent } from 'electron';
import {
  ipcConfirmDecision,
  ipcRecord,
  ipcString,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';
import type {
  PipelineState,
  PrescriptConfirmContext,
} from '../../ipc-contract.js';
import type { ConfirmDecision } from '../ipc-validators.js';
import {
  createRuntimeActions,
  type RuntimeActionsDeps,
} from '../runtime-actions.js';

/**
 * Starting and stopping things over IPC: commands, actions, the pre-script
 * pipeline, and the branch switch. Each handler narrows its payload and hands
 * it to src/main/runtime-actions.ts — the same module «Control remoto» calls —
 * so a start from a window and one from a phone cannot diverge.
 */

export interface RuntimeIpcDeps extends RuntimeActionsDeps {
  preScriptRunner: RuntimeActionsDeps['preScriptRunner'] & {
    cancel: () => { ok: boolean; error?: string | undefined };
  };
  confirms: RuntimeActionsDeps['confirms'] & {
    getContext: (token: string) => PrescriptConfirmContext | null;
    resolveConfirm: (token: string, decision: ConfirmDecision) => void;
  };
  snapshots: { snapshotPipelineState(): PipelineState };
}

export function registerRuntimeIpc(
  ipc: IpcRegistrar,
  deps: RuntimeIpcDeps,
): void {
  const runtime = createRuntimeActions(deps);

  ipc.handle('actions:run', (_e: IpcMainInvokeEvent, payload: unknown) =>
    runtime.runAction(
      ipcStringField(payload, 'groupId'),
      ipcStringField(payload, 'actionId'),
    ),
  );

  // One global pipeline: run/cancel take no groupId.
  ipc.handle('prescripts:run', () => runtime.runPipeline());
  ipc.handle('prescripts:cancel', () => deps.preScriptRunner.cancel());
  ipc.handle('pipeline:state', () => deps.snapshots.snapshotPipelineState());

  ipc.handle(
    'prescriptConfirm:getContext',
    (_e: IpcMainInvokeEvent, rawToken: unknown) =>
      deps.confirms.getContext(ipcString(rawToken, 'token')),
  );
  ipc.handle(
    'prescriptConfirm:resolve',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      deps.confirms.resolveConfirm(
        ipcString(raw.token, 'token'),
        ipcConfirmDecision(raw.decision),
      );
      return { ok: true };
    },
  );

  ipc.handle('process:start', (_e: IpcMainInvokeEvent, rawProcessId: unknown) =>
    runtime.startProcess(ipcString(rawProcessId, 'processId')),
  );
  ipc.handle('process:stop', (_e: IpcMainInvokeEvent, rawProcessId: unknown) =>
    runtime.stopProcess(ipcString(rawProcessId, 'processId')),
  );

  // ── Git group-level ────────────────────────────────────────────────────
  ipc.handle(
    'git:listBranches',
    (_e: IpcMainInvokeEvent, rawGroupId: unknown) =>
      runtime.listBranches(ipcString(rawGroupId, 'groupId')),
  );
  ipc.handle(
    'git:currentBranch',
    (_e: IpcMainInvokeEvent, rawGroupId: unknown) =>
      runtime.currentBranch(ipcString(rawGroupId, 'groupId')),
  );
  ipc.handle('git:switchBranch', (_e: IpcMainInvokeEvent, payload: unknown) =>
    runtime.switchBranch(
      ipcStringField(payload, 'groupId'),
      ipcStringField(payload, 'branch'),
    ),
  );
}
