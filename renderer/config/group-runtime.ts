import type { ProcessStatus } from '../../src/domain-types.js';
import type { GroupState } from '../../src/ipc-contract.js';

/**
 * What the settings window knows about each group's live processes: main's
 * last `GroupState` snapshot (read once at boot, then every `onUpdate`). The
 * group editor only reads it — how many items are in progress, which branch
 * the folder is on, whether one item is running — and never writes back.
 */
export interface GroupRuntime {
  set(states: readonly GroupState[]): void;
  /** Commands and actions of the group that are starting or running. */
  runningCount(groupId: string): number;
  /** The folder's checked-out branch, or null when main reports none. */
  branch(groupId: string): string | null;
  isRunning(groupId: string, itemId: string): boolean;
}

function inProgress(status: ProcessStatus | 'idle' | undefined): boolean {
  return status === 'running' || status === 'starting';
}

export function createGroupRuntime(): GroupRuntime {
  const byGroup = new Map<string, GroupState>();

  function liveIds(groupId: string): string[] {
    const found = byGroup.get(groupId);
    if (!found) return [];
    return [
      ...(found.commands ?? [])
        .filter((c) => inProgress(c.status))
        .map((c) => c.commandId),
      ...(found.actions ?? [])
        .filter((a) => inProgress(a.status))
        .map((a) => a.actionId),
    ];
  }

  return {
    set: (states) => {
      byGroup.clear();
      for (const entry of states) byGroup.set(entry.groupId, entry);
    },
    runningCount: (groupId) => liveIds(groupId).length,
    branch: (groupId) => byGroup.get(groupId)?.currentBranch ?? null,
    isRunning: (groupId, itemId) => liveIds(groupId).includes(itemId),
  };
}
