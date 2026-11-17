/**
 * The logs window's log pane: the pane every log view shares
 * (`renderer/log-view/pane.ts`) bound to the window's own view, buffer and
 * elements, plus the chrome only the window has — the level chips and their
 * counts, the counts strip, the live button, and re-reading which held lines
 * a silence rule swallows.
 *
 * Everything the pane does to the lines — the drawn window, the arriving
 * line, the redraw of a progress bar, the trim, following the tail — is the
 * shared engine's; the workflow terminal under the canvas draws with another
 * instance of it.
 */
import { createPane, EDGE_CHUNK } from '../log-view/pane.js';
import { stripAnsi } from './ansi.js';
import { clientMatchesPattern } from './filters.js';
import { buffer } from './buffer.js';
import { windowStacks } from './stack-fold.js';
import { pendingQueue, reportSelection } from './status.js';
import { dispatchLive, paintLive } from './live.js';
import { rowPrefs } from './row-prefs.js';
import type { LevelTally } from './toolbar-model.js';
import {
  countsEl,
  levelAllBtn,
  levelErrorChip,
  levelErrorCountEl,
  levelWarnChip,
  levelWarnCountEl,
  linesEl,
  liveBtn,
  mainEl,
  scrollBtn,
  setText,
} from './elements.js';
import { findHooks, installRowHooks, nav, view } from './view.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

export { EDGE_CHUNK };

/** The level chips' numbers, and the strip's «N de M líneas · K silenciadas». */
function renderCounts(tally: LevelTally): void {
  setText(levelWarnCountEl, String(tally.warn));
  setText(levelErrorCountEl, String(tally.error));
  const total = buffer.entries.length;
  const lines =
    buffer.visible.length === total
      ? `${total} líneas`
      : `${buffer.visible.length} de ${total} líneas`;
  setText(
    countsEl,
    tally.silenced ? `${lines} · ${tally.silenced} silenciadas` : lines,
  );
}

/** Mark which level chips the view is pinned to; «Todo» when none is. */
export function renderLevelChips(): void {
  const levels = view.levelFilter;
  levelAllBtn.setAttribute('aria-pressed', String(levels.size === 0));
  levelWarnChip.setAttribute('aria-pressed', String(levels.has('warn')));
  levelErrorChip.setAttribute('aria-pressed', String(levels.has('error')));
}

const pane = createPane({
  state: view,
  buffer,
  stacks: windowStacks,
  pending: pendingQueue,
  dispatchLive,
  find: findHooks,
  nav,
  prefs: rowPrefs,
  els: { lines: linesEl, main: mainEl, scrollButton: scrollBtn },
  hooks: {
    counts: renderCounts,
    levelFilter: renderLevelChips,
    selection: reportSelection,
  },
});

/** Point the view at a fresh set of lines (a scope switch or a snapshot). */
export const resetBuffer = pane.resetBuffer;
/**
 * A line that just arrived. It only reaches the DOM when the view is already
 * at the bottom: scrolled back, you are reading history and must not be
 * yanked forward.
 */
export const pushEntry = pane.pushEntry;
/**
 * Re-decide which held lines pass the filters, and redraw. At the tail by
 * default; around `anchor` when the reader was on a line that still passes.
 */
export const applyFilter = pane.applyFilter;
/** Replace the level pin outright — entry points set what they want to see. */
export const setLevelFilter = pane.setLevelFilter;
/**
 * Make sure `entryIndex` is drawn and centre it, for the find widget landing
 * on a hit. Null when the filters hide the line.
 */
export const revealEntry = pane.revealEntry;
/** Draw the window around an entry, scroll to it and mark it. */
export const flashEntry = pane.flashEntry;
/** Move the find widget's «current» marks in the drawn rows, rebuilding none. */
export const paintFindCurrent = pane.paintFindCurrent;
/** Drop the oldest lines once memory is past its cap, and redraw. */
export const trimMemory = pane.trimMemory;
export const updateScrollButton = pane.updateScrollButton;

installRowHooks({ repaint: pane.repaintInPlace });

/** A chip pins the view to its level alone; pressing it again lets go. */
function toggleLevelChip(level: SilenceLevel): void {
  const alone = view.levelFilter.size === 1 && view.levelFilter.has(level);
  setLevelFilter(alone ? [] : [level]);
}

/**
 * Re-decide which held lines a silence rule swallows, after the rules changed.
 * Updates the BUFFER, not just the drawn rows: a row scrolled out of the
 * window would otherwise come back built from a stale `silenced` flag.
 */
export function rerenderExistingLines(): void {
  const target = view.currentTarget;
  if (!target || target.kind !== 'command' || !target.target) return;
  const sp = target.target.silencedPatterns || { warn: [], error: [] };
  let changed = false;
  for (const entry of buffer.entries) {
    const orig = entry.originalLevel;
    if (!orig) continue;
    const list = sp[orig] || [];
    const isSilenced = list.some((pattern) =>
      clientMatchesPattern(pattern, stripAnsi(entry.line)),
    );
    if (entry.silenced === isSilenced) continue;
    entry.silenced = isSilenced;
    entry.level = isSilenced ? null : orig;
    changed = true;
  }
  if (changed) pane.relevelled();
}

liveBtn.addEventListener('click', () => {
  if (view.live.following) dispatchLive({ type: 'press' });
  else pane.resumeLive();
});
paintLive();

levelAllBtn.addEventListener('click', () => setLevelFilter([]));
levelWarnChip.addEventListener('click', () => toggleLevelChip('warn'));
levelErrorChip.addEventListener('click', () => toggleLevelChip('error'));
