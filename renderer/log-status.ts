import { formatUptime } from './format-uptime.js';
import type { LogListItem } from '../src/ipc-contract.js';

const RUNNING: ReadonlySet<string> = new Set(['running', 'starting']);

export interface Runtime {
  text: string;
  live: boolean;
}

export function isRunning(item: LogListItem | null): boolean {
  return !!item && RUNNING.has(item.status);
}

/** Commands and actions can be launched from the logs window; logs cannot. */
export function canRun(item: LogListItem | null): boolean {
  return !!item && (item.type === 'command' || item.type === 'action');
}

/** Status dot colour: warnings and errors outrank plain "running". */
export function dotClass(item: LogListItem): string {
  if (item.status === 'starting' || item.status === 'stopping')
    return item.status;
  if (!RUNNING.has(item.status)) return '';
  if (item.errorCount > 0) return 'error';
  if (item.warnCount > 0) return 'warn';
  return 'running';
}

/** Loudest state first — a group is only as healthy as its worst member. */
const DOT_SEVERITY: Readonly<Record<string, number>> = {
  starting: 1,
  stopping: 1,
  running: 2,
  warn: 3,
  error: 4,
};

/**
 * The dot a group header shows: the worst state among its items. This is what
 * keeps a COLLAPSED group honest — a failing service can't hide behind a
 * folded header.
 */
export function groupDotClass(items: readonly LogListItem[]): string {
  let worst = '';
  let severity = 0;
  for (const item of items) {
    const candidate = dotClass(item);
    const rank = DOT_SEVERITY[candidate] ?? 0;
    if (rank > severity) {
      severity = rank;
      worst = candidate;
    }
  }
  return worst;
}

/**
 * How long an item has been running, or how long its last run lasted.
 * `live` marks a still-ticking duration; a finished run is frozen.
 * Returns null when the item never ran, or when `lastFinishedAt` belongs to an
 * older run than `startedAt` (a restart that has not finished yet).
 */
export function runtimeOf(
  item: LogListItem | null,
  now: number = Date.now(),
): Runtime | null {
  if (!item || !item.startedAt) return null;
  if (isRunning(item))
    return { text: formatUptime(now - item.startedAt), live: true };
  if (!item.lastFinishedAt || item.lastFinishedAt < item.startedAt) return null;
  return {
    text: formatUptime(item.lastFinishedAt - item.startedAt),
    live: false,
  };
}
