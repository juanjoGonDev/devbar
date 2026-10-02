import { makeActionId, makeCommandId, parseProcessId } from '../compound-id.js';
import type { Action, Command, Group, ProcessState } from '../domain-types.js';

/**
 * Starting and stopping things — commands, actions, the pre-script pipeline —
 * and the branch switch that has to stop and restart a group's services
 * around it. The IPC handlers (src/main/ipc/runtime-ipc.ts) and the
 * «Control remoto» API (src/main/remote/control-api.ts) both call these, so a
 * start from the tray and a start from a phone go through the SAME
 * confirmation gate and the same single-mode rule.
 *
 * Stateless: every bit of state lives in the collaborators, so each caller may
 * build its own instance over the same deps.
 */

type Outcome = { ok: boolean; error?: string | undefined };

export interface RuntimeActionsDeps {
  configStore: {
    getGroup(id: string): Group | null;
    listGroups(): Group[];
  };
  processManager: {
    start: (processId: string) => Outcome;
    stop: (id: string) => Promise<Outcome>;
    getState: (id: string) => Pick<ProcessState, 'status'>;
  };
  preScriptRunner: { run: () => Promise<unknown> };
  gitManager: {
    listBranches: (repoPath: string) => Promise<unknown>;
    currentBranch: (repoPath: string) => Promise<unknown>;
    switchBranch: (repoPath: string, branch: string) => Promise<Outcome>;
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
  };
  groupErrors: Map<string, string | null>;
  broadcast: () => void;
  /** Tell the renderers that a repository's branch list is out of date. */
  branchesChanged: (repoPath: string) => void;
}

export interface RuntimeActions {
  runAction(
    groupId: string,
    actionId: string,
  ): Promise<Outcome & { processId: string; cancelled?: boolean }>;
  startProcess(processId: string): Promise<Outcome & { cancelled?: boolean }>;
  stopProcess(processId: string): Promise<Outcome>;
  /** Stops every running command service; one broadcast at the end. */
  stopAll(): Promise<{ ok: boolean; stopped: number }>;
  runPipeline(): Promise<unknown>;
  listBranches(groupId: string): Promise<unknown>;
  currentBranch(groupId: string): Promise<unknown>;
  switchBranch(groupId: string, branch: string): Promise<Outcome>;
  /** Whether starting this command or action waits on its confirmation. */
  needsConfirm(processId: string): boolean;
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
function announceRemoteChanges(
  deps: RuntimeActionsDeps,
  repoPath: string,
): void {
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

/** The command or action a process id names, when it still exists. */
export function findRunnable(
  getGroup: (id: string) => Group | null,
  processId: string,
):
  | { kind: 'command'; target: Command }
  | { kind: 'action'; target: Action }
  | null {
  const parsed = parseProcessId(processId);
  if (parsed.kind !== 'command' && parsed.kind !== 'action') return null;
  const group = getGroup(parsed.groupId);
  if (!group) return null;
  if (parsed.kind === 'command') {
    const target = (group.commands || []).find(
      (c) => c.id === parsed.commandId,
    );
    return target ? { kind: 'command', target } : null;
  }
  const target = (group.actions || []).find((a) => a.id === parsed.actionId);
  return target ? { kind: 'action', target } : null;
}

export function createRuntimeActions(deps: RuntimeActionsDeps): RuntimeActions {
  const { configStore, processManager, broadcast } = deps;
  const running = (pid: string): boolean =>
    processManager.getState(pid).status === 'running';

  return {
    runAction: async (groupId, actionId) => {
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

    startProcess: async (processId) => {
      const parsed = parseProcessId(processId);
      if (parsed.kind === 'unknown')
        return { ok: false, error: 'Invalid process id' };

      // Optional confirmation gate (commands only here; actions go via
      // runAction).
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
          const siblings = (group.commands || [])
            .map((c) => makeCommandId(group.id, c.id))
            .filter((pid) => pid !== processId && running(pid));
          for (const pid of siblings) await processManager.stop(pid);
        }
      }

      const res = processManager.start(processId);
      broadcast();
      return res;
    },

    stopProcess: async (processId) => {
      const res = await processManager.stop(processId);
      broadcast();
      return res;
    },

    stopAll: async () => {
      const ids = configStore
        .listGroups()
        .flatMap((group) =>
          (group.commands || []).map((c) => makeCommandId(group.id, c.id)),
        )
        .filter(running);
      const results = await Promise.all(
        ids.map((pid) => processManager.stop(pid)),
      );
      broadcast();
      return { ok: results.every((r) => r.ok), stopped: ids.length };
    },

    runPipeline: () => deps.preScriptRunner.run(),

    listBranches: async (groupId) => {
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };
      // Answer from local refs first, at local speed. `refs/remotes` only
      // holds what the last fetch brought, so a branch pushed five minutes ago
      // is invisible until something fetches — that catch-up happens behind
      // this answer, never in front of it.
      const branches = await deps.gitManager.listBranches(group.path);
      announceRemoteChanges(deps, group.path);
      return branches;
    },

    currentBranch: async (groupId) => {
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };
      return deps.gitManager.currentBranch(group.path);
    },

    switchBranch: async (groupId, branch) => {
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };

      // Stop every running command in the group and await each exit, so the
      // checkout never races a build watching the working tree.
      const runningPids = (group.commands || [])
        .map((c) => makeCommandId(group.id, c.id))
        .filter(running);
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

    needsConfirm: (processId) =>
      findRunnable((id) => configStore.getGroup(id), processId)?.target
        .confirm === true,
  };
}
