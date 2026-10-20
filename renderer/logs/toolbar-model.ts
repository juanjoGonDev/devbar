/**
 * What the toolbar says, worked out without touching it: the breadcrumb, the
 * run-state pill and the per-level counts behind the chips in the search box.
 *
 * `renderToolbar` repaints once a second for the ticking uptime, so these are
 * plain functions of the state handed in — cheap, and checkable without a
 * window.
 */
import { isRunning, runtimeOf } from '../log-status.js';
import { levelOf } from './filters.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { LogListItem } from '../../src/ipc-contract.js';

export interface Crumbs {
  /** The group, muted, before the separator; null when there is nothing to qualify. */
  group: string | null;
  /** What is on screen, in bold. */
  name: string;
}

export interface CrumbSource {
  processId: string | null;
  mergedIsAll: boolean;
  mergedGroupId: string | null;
  groupName: string;
  displayName: string;
}

/**
 * «Grupo › Servicio» for one service; just the group for a whole group merged,
 * and «Todo» for everything.
 */
export function crumbsFor(source: CrumbSource): Crumbs {
  if (source.processId) {
    const name = source.displayName || source.processId;
    return { group: source.groupName || null, name };
  }
  if (source.mergedIsAll) return { group: null, name: 'Todo' };
  if (source.mergedGroupId) return { group: null, name: source.groupName };
  return { group: null, name: 'Logs (sin proceso)' };
}

type PillTone = 'running' | 'stopped' | 'error';

export interface RunPill {
  tone: PillTone;
  text: string;
  /** The last run's length, for a stopped service — kept off the pill itself. */
  title: string;
}

/** «● En marcha · 8m 26s», «Parado», «Con errores»… */
export function runPillFor(
  item: LogListItem,
  now: number = Date.now(),
): RunPill {
  const runtime = runtimeOf(item, now);
  if (isRunning(item)) {
    const text =
      item.status === 'starting'
        ? 'Arrancando'
        : runtime
          ? `En marcha · ${runtime.text}`
          : 'En marcha';
    return { tone: 'running', text, title: 'Tiempo en ejecución' };
  }
  const title = runtime ? `Última ejecución: ${runtime.text}` : '';
  if (item.status === 'error')
    return { tone: 'error', text: 'Con errores', title };
  if (item.status === 'stopping')
    return { tone: 'stopped', text: 'Parando', title };
  if (item.status === 'done')
    return { tone: 'stopped', text: 'Terminado', title };
  return { tone: 'stopped', text: 'Parado', title };
}

export interface LevelTally {
  warn: number;
  error: number;
  /** Held lines a silence rule swallowed, for the footer. */
  silenced: number;
}

/**
 * How many held lines each level chip would leave on screen. Counted the way
 * the level filter matches — silenced lines included — so pressing a chip
 * shows exactly the number it promised.
 */
export function tallyLevels(entries: readonly LogEntry[]): LevelTally {
  const tally: LevelTally = { warn: 0, error: 0, silenced: 0 };
  for (const entry of entries) addToTally(tally, entry);
  return tally;
}

export function addToTally(tally: LevelTally, entry: LogEntry): void {
  const level = levelOf(entry);
  if (level === 'warn') tally.warn += 1;
  else if (level === 'error') tally.error += 1;
  if (entry.silenced) tally.silenced += 1;
}
