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
import type { Selection } from '../line-selection.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

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
}

export const buffer: LogBuffer = {
  entries: [],
  visible: [],
  winStart: 0,
  winEnd: -1,
  selected: new Set<number>(),
  anchorEntry: null,
};

export function recomputeVisible(
  filterRe: RegExp | null,
  levels: ReadonlySet<SilenceLevel>,
): void {
  buffer.visible = [];
  for (let i = 0; i < buffer.entries.length; i += 1) {
    const entry = buffer.entries[i];
    if (entry && matchesFilter(entry, filterRe, levels)) buffer.visible.push(i);
  }
}

/** Point the buffer at a fresh set of lines (a scope switch or a snapshot). */
export function replaceEntries(
  next: LogEntry[],
  filterRe: RegExp | null,
  levels: ReadonlySet<SilenceLevel>,
): void {
  buffer.entries = next;
  buffer.selected.clear();
  buffer.anchorEntry = null;
  recomputeVisible(filterRe, levels);
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
): Trim | null {
  const drop = buffer.entries.length - cap;
  if (drop <= 0) return null;
  // How far the window has to slide, and whether it was following the tail —
  // decided BEFORE the shift, while the old indices still mean something.
  const droppedVisible = buffer.visible.filter((index) => index < drop).length;
  const wasFollowing = buffer.winEnd >= buffer.visible.length - 1;

  buffer.entries = buffer.entries.slice(drop);
  const rebased = new Set<number>();
  for (const index of buffer.selected) {
    if (index - drop >= 0) rebased.add(index - drop);
  }
  buffer.selected.clear();
  for (const index of rebased) buffer.selected.add(index);
  buffer.anchorEntry =
    buffer.anchorEntry === null || buffer.anchorEntry - drop < 0
      ? null
      : buffer.anchorEntry - drop;
  recomputeVisible(filterRe, levels);
  return { droppedVisible, wasFollowing };
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
