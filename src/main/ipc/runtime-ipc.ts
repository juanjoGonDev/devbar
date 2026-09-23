import type { IpcMainInvokeEvent } from 'electron';
import {
  makeActionId,
  makeCommandId,
  parseProcessId,
} from '../../compound-id.js';
import {
  ipcConfirmDecision,
  ipcRecord,
  ipcString,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';
import type {
  Action,
  Command,
  Group,
  ProcessState,
} from '../../domain-types.js';
import type {
  PipelineState,
  PrescriptConfirmContext,
} from '../../ipc-contract.js';
import type { ConfirmDecision } from '../ipc-validators.js';

/**
 * Starting and stopping things: commands, actions, the pre-script pipeline,
 * and the branch switch that has to stop and restart a group's services around
 * it. Every start that carries a confirmation goes through the SAME gate, so
 * manual, scheduled and pipeline starts cannot diverge.
 */

export interface RuntimeIpcDeps {
  configStore: { getGroup(id: string): Group | null };
  processManager: {
    start: (processId: string) => { ok: boolean; error?: string | undefined };
    stop: (id: string) => Promise<{ ok: boolean; error?: string | undefined }>;
    getState: (id: string) => Pick<ProcessState, 'status'>;
  };
  preScriptRunner: {
    run: () => Promise<unknown>;
    cancel: () => { ok: boolean; error?: string | undefined };
  };
  gitManager: {
    listBranches: (repoPath: string) => Promise<unknown>;
    currentBranch: (repoPath: string) => Promise<unknown>;
    switchBranch: (
      repoPath: string,
      branch: string,
    ) => Promise<{ ok: boolean; error?: string | undefined }>;
    /**
     * Catch `refs/remotes` up with the forge in the background. Reports
     * `changed: true` only when something really moved, and never fails:
     * every network problem reads as "nothing changed".
     */
    refreshRemotes: (repoPath: string) => Promise<{ changed: boolean }>;
  };
  confirms: {
    confirmIfNeeded: (
      target: Command | Action | null | undefined,
      group: Group | null,
    ) => Promise<boolean>;
    getContext: (token: string) => PrescriptConfirmContext | null;
    resolveConfirm: (token: string, decision: ConfirmDecision) => void;
  };
  snapshots: { snapshotPipelineState(): PipelineState };
  groupErrors: Map<string, string | null>;
  broadcast: () => void;
  /** Tell the renderers that a repository's branch list is out of date. */
  branchesChanged: (repoPath: string) => void;
}

/**
 * Kick the remote catch-up and forget about it. Nothing awaits this: the
 * branch list has already been answered from local refs, and a fetch is a
 * network round trip that may sit there for its whole timeout.
 *
 * The announcement is conditional on purpose. `branches:changed` makes the
 * renderer drop the cached branch list of EVERY group and reload the ones on
 * screen, so emitting on every dropdown open would turn one selector's
 * housekeeping into a full reload of all of them — the very cost this feature
 * exists to avoid.
 */
function announceRemoteChanges(deps: RuntimeIpcDeps, repoPath: string): void {
  void deps.gitManager.refreshRemotes(repoPath).then(
    ({ changed }) => {
      if (changed) deps.branchesChanged(repoPath);
    },
    () => {
      // refreshRemotes owns its failures and reports them as "nothing
      // changed". If it ever breaks that promise, drop it here rather than
      // let an unhandled rejection end the main process over a branch list
      // nobody is waiting for.
    },
  );
}

export function registerRuntimeIpc(
  ipc: IpcRegistrar,
  deps: RuntimeIpcDeps,
): void {
  const { configStore, processManager, broadcast } = deps;

  ipc.handle(
    'actions:run',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const actionId = ipcStringField(payload, 'actionId');
      const pid = makeActionId(groupId, actionId);
      const group = configStore.getGroup(groupId);
      const action =
        group && (group.actions || []).find((a) => a.id === actionId);
      if (!(await deps.confirms.confirmIfNeeded(action, group))) {
        return { ok: false, cancelled: true, processId: pid };
      }
      const res = processManager.start(pid);
      broadcast();
      return { ok: res.ok, processId: pid, error: res.error };
    },
  );

  // One global pipeline: run/cancel take no groupId.
  ipc.handle('prescripts:run', () => deps.preScriptRunner.run());
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

  ipc.handle(
    'process:start',
    async (_e: IpcMainInvokeEvent, rawProcessId: unknown) => {
      const processId = ipcString(rawProcessId, 'processId');
      const parsed = parseProcessId(processId);
      if (parsed.kind === 'unknown')
        return { ok: false, error: 'Invalid process id' };

      // Optional confirmation gate (commands only here; actions go via
      // actions:run).
      if (parsed.kind === 'command') {
        const grp = configStore.getGroup(parsed.groupId);
        const cmd =
          grp && (grp.commands || []).find((c) => c.id === parsed.commandId);
        if (!(await deps.confirms.confirmIfNeeded(cmd, grp))) {
          return { ok: false, cancelled: true };
        }
      }

      // Single-mode: stop other running commands in the same group first. The
      // group is re-read AFTER the confirmation: the modal can stay open
      // indefinitely, and the mode may have been edited while it was up.
      if (parsed.kind === 'command') {
        const group = configStore.getGroup(parsed.groupId);
        if (group && group.mode === 'single') {
          const running = (group.commands || [])
            .map((c) => makeCommandId(group.id, c.id))
            .filter(
              (pid) =>
                pid !== processId &&
                processManager.getState(pid).status === 'running',
            );
          for (const pid of running) await processManager.stop(pid);
        }
      }

      const res = processManager.start(processId);
      broadcast();
      return res;
    },
  );

  ipc.handle(
    'process:stop',
    async (_e: IpcMainInvokeEvent, rawProcessId: unknown) => {
      const res = await processManager.stop(
        ipcString(rawProcessId, 'processId'),
      );
      broadcast();
      return res;
    },
  );

  // ── Git group-level ────────────────────────────────────────────────────
  ipc.handle(
    'git:listBranches',
    async (_e: IpcMainInvokeEvent, rawGroupId: unknown) => {
      const group = configStore.getGroup(ipcString(rawGroupId, 'groupId'));
      if (!group) return { ok: false, error: 'Group not found' };
      // Answer from local refs first, at local speed. `refs/remotes` only
      // holds what the last fetch brought, so a branch pushed five minutes ago
      // is invisible until something fetches — that catch-up happens behind
      // this answer, never in front of it.
      const branches = await deps.gitManager.listBranches(group.path);
      announceRemoteChanges(deps, group.path);
      return branches;
    },
  );

  ipc.handle(
    'git:currentBranch',
    async (_e: IpcMainInvokeEvent, rawGroupId: unknown) => {
      const group = configStore.getGroup(ipcString(rawGroupId, 'groupId'));
      if (!group) return { ok: false, error: 'Group not found' };
      return deps.gitManager.currentBranch(group.path);
    },
  );

  ipc.handle(
    'git:switchBranch',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const branch = ipcStringField(payload, 'branch');
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };

      // Stop every running command in the group and await each exit, so the
      // checkout never races a build watching the working tree.
      const runningPids = (group.commands || [])
        .map((c) => makeCommandId(group.id, c.id))
        .filter((pid) => processManager.getState(pid).status === 'running');
      await Promise.all(runningPids.map((pid) => processManager.stop(pid)));

      const result = await deps.gitManager.switchBranch(group.path, branch);
      if (!result.ok) {
        deps.groupErrors.set(groupId, result.error ?? 'Unknown git error');
        broadcast();
        return result;
      }
      deps.groupErrors.set(groupId, null);
      // Restart commands that were running.
      for (const pid of runningPids) processManager.start(pid);
      broadcast();
      return { ok: true };
    },
  );
}
