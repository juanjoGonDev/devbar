/**
 * The lines the window holds, and the arithmetic over them.
 *
 * Lines live in `entries`; only a window of them is ever in the DOM.
 *
 * Before, every retained line was a row, so the retention setting doubled as a
 * DOM budget and 20 000 lines locked the window up. Now retention is memory —
 * cheap — and the DOM holds a few hundred rows around where you are looking,
 * extended at whichever edge you approach. `visible` is the filtered view of
 * `entries`, so filtering searches everything held rather than only what
 * happens to be drawn.
 *
 * Nothing here touches the DOM. That is the point: dropping the oldest lines
 * has to rebase every index that pointed at them — the selection, the anchor,
 * the drawn window — and that is where the off-by-ones live, so it is checked
 * directly instead of through a rendered pane.
 */
import { matchesFilter } from './filters.js';
import { fmtTime } from './format.js';
import { stripAnsi } from './ansi.js';
import { replacedIndex } from '../../src/log-replace.js';
import type { Selection } from '../line-selection.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel, SourcedLogEntry } from '../../src/ipc-contract.js';

export interface LogBuffer {
  entries: LogEntry[];
  /** Indices into `entries` that pass the current filters, in order. */
  visible: number[];
  /** Rendered slice of `visible`, inclusive; -1/-2 means nothing rendered. */
  winStart: number;
  winEnd: number;
  /** Selection survives re-rendering because it is keyed by entry, not by row. */
  selected: Set<number>;
  anchorEntry: number | null;
  /**
   * Bumped by every redraw swapped in place (`swapRewritten`): `visible` kept
   * its shape, but a line in it changed its time and maybe its level, so
   * whatever was counted from them has to be counted again.
   */
  redraws: number;
}

/** An empty buffer: every log view holds its own. */
export function createBuffer(): LogBuffer {
  return {
    entries: [],
    visible: [],
    winStart: 0,
    winEnd: -1,
    selected: new Set<number>(),
    anchorEntry: null,
    redraws: 0,
  };
}

/**
 * The logs window's buffer. The functions that every view shares work on it
 * unless handed another view's (`target`); the selection is the window's own.
 */
export const buffer: LogBuffer = createBuffer();

export function recomputeVisible(
  filterRe: RegExp | null,
  levels: ReadonlySet<SilenceLevel>,
  target: LogBuffer = buffer,
): void {
  target.visible = [];
  for (let i = 0; i < target.entries.length; i += 1) {
    const entry = target.entries[i];
    if (entry && matchesFilter(entry, filterRe, levels)) target.visible.push(i);
  }
}

/** Point the buffer at a fresh set of lines (a scope switch or a snapshot). */
export function replaceEntries(
  next: LogEntry[],
  filterRe: RegExp | null,
  levels: ReadonlySet<SilenceLevel>,
  target: LogBuffer = buffer,
): void {
  target.entries = next;
  target.selected.clear();
  target.anchorEntry = null;
  recomputeVisible(filterRe, levels, target);
}

/** What the caller has to redraw after the oldest lines were dropped. */
export interface Trim {
  /** How far the drawn window has to slide to stay over the same lines. */
  droppedVisible: number;
  /** Whether the window was at the tail — the only case that may jump. */
  wasFollowing: boolean;
}

/**
 * Drop the oldest lines once memory is past its cap, in one batch so the
 * re-indexing below is rare. Every index in `visible`, in the selection and in
 * the window shifts, so they are all rebased together. Null means nothing to
 * drop, and so nothing to redraw.
 */
export function trimBuffer(
  cap: number,
  filterRe: RegExp | null,
  levels: ReadonlySet<SilenceLevel>,
  target: LogBuffer = buffer,
): Trim | null {
  const drop = target.entries.length - cap;
  if (drop <= 0) return null;
  // How far the window has to slide, and whether it was following the tail —
  // decided BEFORE the shift, while the old indices still mean something.
  const droppedVisible = target.visible.filter((index) => index < drop).length;
  const wasFollowing = target.winEnd >= target.visible.length - 1;

  target.entries = target.entries.slice(drop);
  const rebased = new Set<number>();
  for (const index of target.selected) {
    if (index - drop >= 0) rebased.add(index - drop);
  }
  target.selected.clear();
  for (const index of rebased) target.selected.add(index);
  target.anchorEntry =
    target.anchorEntry === null || target.anchorEntry - drop < 0
      ? null
      : target.anchorEntry - drop;
  recomputeVisible(filterRe, levels, target);
  return { droppedVisible, wasFollowing };
}

/**
 * Where in `list` the line a redraw rewrites sits (a carriage return redrew
 * it: a progress bar), or -1. In a merged view every service counts its own
 * lines, so only a line of the redraw's own source can match.
 */
export function rewrittenIndex(
  list: readonly LogEntry[],
  entry: LogEntry,
): number {
  const source = (entry as SourcedLogEntry).srcId;
  return replacedIndex(
    list,
    entry.replaces,
    (held) => (held as SourcedLogEntry).srcId === source,
  );
}

/**
 * Put a redraw in the place of the line it rewrites. Nothing moves, so the
 * selection — keyed by index — stays on it. Null when the buffer no longer
 * holds that line: the redraw is then an ordinary new line.
 */
export function swapRewritten(
  entry: LogEntry,
  target: LogBuffer = buffer,
): { index: number; previous: LogEntry } | null {
  const index = rewrittenIndex(target.entries, entry);
  const previous = index < 0 ? undefined : target.entries[index];
  if (!previous) return null;
  target.entries[index] = entry;
  target.redraws += 1;
  return { index, previous };
}

/*
 * Selection is keyed by ENTRY, not by row: rows come and go as the window
 * moves, so a DOM-based selection would silently lose whatever scrolled out.
 * Positions handed to applySelection are positions in `visible`, which is what
 * "the line above this one" means to someone reading a filtered log.
 */
export function selectionAsPositions(): Selection {
  const positions = new Set<number>();
  for (let pos = 0; pos < buffer.visible.length; pos += 1) {
    const index = buffer.visible[pos];
    if (index !== undefined && buffer.selected.has(index)) positions.add(pos);
  }
  const anchor =
    buffer.anchorEntry === null
      ? null
      : (() => {
          const pos = buffer.visible.indexOf(buffer.anchorEntry);
          return pos < 0 ? null : pos;
        })();
  return { selected: positions, anchor };
}

export function commitSelection(next: Selection): void {
  buffer.selected.clear();
  for (const pos of next.selected) {
    const index = buffer.visible[pos];
    if (index !== undefined) buffer.selected.add(index);
  }
  buffer.anchorEntry =
    next.anchor === null ? null : (buffer.visible[next.anchor] ?? null);
}

/** Copy text for entry indices, straight from the buffer. */
export function entriesToText(indices: readonly number[]): string {
  return indices
    .map((index) => {
      const entry = buffer.entries[index];
      if (!entry) return '';
      return `${fmtTime(entry.ts)} ${stripAnsi(entry.line)}`;
    })
    .filter(Boolean)
    .join('\n');
}
