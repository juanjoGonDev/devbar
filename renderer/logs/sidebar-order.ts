/**
 * In what order a group's services are listed, and which of them fold away.
 *
 * What is running is what you came for, so it goes first; what is stopped
 * follows, dimmed. A group with many stopped services would otherwise bury
 * the few that matter under a column of grey, so past a handful the rest
 * fold into «+ N parados» until the reader opens them.
 *
 * Pure: the order is a function of the services and whether the fold is open,
 * so it is checked here without building a tree.
 */
import type { LogListItem } from '../../src/ipc-contract.js';

/** Stopped services shown before the rest fold away. */
export const SHOWN_STOPPED = 3;

/** Doing something: running, or on its way in or out. */
export function isActive(item: LogListItem): boolean {
  return (
    item.status === 'running' ||
    item.status === 'starting' ||
    item.status === 'stopping'
  );
}

export interface GroupArrangement {
  /** Every service id, in the order the rows are listed. */
  order: string[];
  /** The ids hidden behind «+ N parados» (empty once it is opened). */
  folded: string[];
}

export function arrangeGroup(
  items: readonly LogListItem[],
  unfolded: boolean,
): GroupArrangement {
  const active = items.filter(isActive).map((item) => item.id);
  const stopped = items
    .filter((item) => !isActive(item))
    .map((item) => item.id);
  const folded =
    unfolded || stopped.length <= SHOWN_STOPPED
      ? []
      : stopped.slice(SHOWN_STOPPED);
  return { order: [...active, ...stopped], folded };
}

/** «1/11»: how many of the group's services are doing something. */
export function runningOfTotal(items: readonly LogListItem[]): string {
  return `${items.filter(isActive).length}/${items.length}`;
}
