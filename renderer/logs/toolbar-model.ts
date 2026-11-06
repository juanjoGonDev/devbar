/**
 * What the toolbar says, worked out without touching it: the breadcrumb, the
 * run-state pill and the per-level counts behind the chips in the find widget.
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
  /** What the pill reads: just the uptime while running, the state otherwise. */
  text: string;
  /**
   * The state spelled out, plus the run's length: the tooltip, and all a
   * narrow toolbar keeps once the pill shrinks to its dot.
   */
  title: string;
}

/** Stopped states, with the last run's length kept off the pill itself. */
function stoppedPill(
  tone: PillTone,
  state: string,
  runtime: string | null,
): RunPill {
  const title = runtime ? `${state} · última ejecución: ${runtime}` : state;
  return { tone, text: state, title };
}

/** «● 8m 26s», «Parado», «Con errores»… */
export function runPillFor(
  item: LogListItem,
  now: number = Date.now(),
): RunPill {
  const runtime = runtimeOf(item, now)?.text ?? null;
  if (isRunning(item)) {
    if (item.status === 'starting')
      return { tone: 'running', text: 'Arrancando', title: 'Arrancando' };
    return runtime
      ? { tone: 'running', text: runtime, title: `En marcha · ${runtime}` }
      : { tone: 'running', text: 'En marcha', title: 'En marcha' };
  }
  if (item.status === 'error')
    return stoppedPill('error', 'Con errores', runtime);
  if (item.status === 'stopping')
    return stoppedPill('stopped', 'Parando', runtime);
  if (item.status === 'done')
    return stoppedPill('stopped', 'Terminado', runtime);
  return stoppedPill('stopped', 'Parado', runtime);
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
