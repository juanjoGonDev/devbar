/**
 * The log pane: which slice of the buffer is drawn, and how it moves.
 *
 * The DOM holds a few hundred rows around where you are looking, extended at
 * whichever edge you approach; `buffer.ts` owns the lines and the index
 * arithmetic, this module owns everything that touches the screen — the
 * window, the counts, the arriving line, the scroll button.
 */
import {
  clampWindow,
  extendBottom,
  extendTop,
  initialWindow,
  windowAround,
} from '../log-window.js';
import { stripAnsi } from './ansi.js';
import { buildFilter, clientMatchesPattern, matchesFilter } from './filters.js';
import {
  buffer,
  recomputeVisible,
  replaceEntries,
  trimBuffer,
} from './buffer.js';
import { buildRow } from './rows.js';
import { indexStackEntry, indexStacks, stackOf } from './stack-fold.js';
import { pendingQueue, reportSelection } from './status.js';
import { dispatchLive, paintLive } from './live.js';
import { isHolding } from './live-state.js';
import { addToTally, tallyLevels, type LevelTally } from './toolbar-model.js';
import {
  countsEl,
  filterEl,
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
import { installRowHooks, view } from './view.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/** Rows rendered on a fresh view, and added per edge as you scroll. */
const WINDOW_ROWS = 600;
export const EDGE_CHUNK = 300;
/** How close to an edge counts as approaching it. */
const EDGE_PX = 500;
const SCROLL_THRESHOLD = 4;

/**
 * Warn/error lines held, behind the level chips' numbers. Kept up to date one
 * line at a time — recounting 20 000 entries for every arriving line would be
 * the slowest thing in the window — and recounted whenever the held lines are
 * replaced wholesale.
 */
let tally: LevelTally = { warn: 0, error: 0 };

function recount(): void {
  tally = tallyLevels(buffer.entries);
}

function renderCounts(): void {
  setText(levelWarnCountEl, String(tally.warn));
  setText(levelErrorCountEl, String(tally.error));
  const total = buffer.entries.length;
  countsEl.textContent =
    buffer.visible.length === total
      ? `${total} líneas`
      : `${buffer.visible.length} de ${total} líneas`;
}

/** Replace the DOM with `visible[from..to]`, clamped to what exists. */
function renderWindow(from: number, to: number): void {
  buffer.winStart = Math.max(0, from);
  buffer.winEnd = Math.min(buffer.visible.length - 1, to);
  const fragment = document.createDocumentFragment();
  for (let pos = buffer.winStart; pos <= buffer.winEnd; pos += 1) {
    const entryIndex = buffer.visible[pos];
    if (entryIndex === undefined) continue;
    const entry = buffer.entries[entryIndex];
    if (entry) fragment.appendChild(buildRow(entry, entryIndex, showInContext));
  }
  linesEl.textContent = '';
  linesEl.appendChild(fragment);
  renderCounts();
  // Deliberately no updateScrollButton() here: growTop compensates scrollTop
  // right after rendering, so judging position mid-flight would briefly read
  // "at bottom" and switch auto-scroll back on, yanking the reader to the tail.
}

function renderAtBottom(): void {
  const win = initialWindow(buffer.visible.length, WINDOW_ROWS);
  renderWindow(win.start, win.end);
  mainEl.scrollTop = mainEl.scrollHeight;
  updateScrollButton();
}

/** Render around one entry, for landing on a specific line after a jump. */
function renderAroundEntry(entryIndex: number): HTMLElement | null {
  const pos = buffer.visible.indexOf(entryIndex);
  if (pos < 0) return null;
  const win = windowAround(pos, buffer.visible.length, WINDOW_ROWS);
  renderWindow(win.start, win.end);
  return (
    linesEl.querySelector<HTMLElement>(`.line[data-eidx="${entryIndex}"]`) ??
    null
  );
}

/** Extend upward, holding the viewport still. */
function growTop(): void {
  if (buffer.winStart === 0) return;
  const before = mainEl.scrollHeight;
  const win = extendTop(
    { start: buffer.winStart, end: buffer.winEnd },
    buffer.visible.length,
    EDGE_CHUNK,
    WINDOW_ROWS,
  );
  renderWindow(win.start, win.end);
  // Measured rather than computed: rows wrap, so their heights are not known
  // ahead of time. The delta is exactly how far the content moved down.
  mainEl.scrollTop += mainEl.scrollHeight - before;
  updateScrollButton();
}

/** Extend downward, dropping from the top if the DOM budget is spent. */
function growBottom(): void {
  if (buffer.winEnd >= buffer.visible.length - 1) return;
  const before = mainEl.scrollHeight;
  const win = extendBottom(
    { start: buffer.winStart, end: buffer.winEnd },
    buffer.visible.length,
    EDGE_CHUNK,
    WINDOW_ROWS,
  );
  const droppingTop = win.start > buffer.winStart;
  renderWindow(win.start, win.end);
  if (droppingTop) mainEl.scrollTop -= before - mainEl.scrollHeight;
  updateScrollButton();
}

/** Draw the window around an entry, scroll to it and mark it. */
export function flashEntry(entryIndex: number): void {
  const row = renderAroundEntry(entryIndex);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation if it is already running
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

/**
 * Drop every filter and land on this line, in sequence with everything around
 * it. Filtering only ever hides rows — it never removes them — so putting a
 * warning back among its neighbours costs nothing but a repaint and a scroll.
 * That context is usually where the cause is: the line before the failure.
 */
function showInContext(row: HTMLElement): void {
  const entryIndex = Number(row.dataset.eidx);
  filterEl.value = '';
  // Clearing the filter re-renders, so the row handed in here is discarded —
  // the entry index is what survives, and the window is rebuilt around it.
  setLevelFilter([]);
  // Always respond, even when nothing was filtered. A control that looks
  // pressable and answers with silence teaches you to stop pressing it; with
  // no filter on, centring and flashing the line is still a real answer.
  dispatchLive({ type: 'leftTail' }); // otherwise the tail yanks us away again
  if (Number.isFinite(entryIndex)) flashEntry(entryIndex);
}

/** Mark which level chips the view is pinned to; «Todo» when none is. */
export function renderLevelChips(): void {
  const levels = view.levelFilter;
  levelAllBtn.setAttribute('aria-pressed', String(levels.size === 0));
  levelWarnChip.setAttribute('aria-pressed', String(levels.has('warn')));
  levelErrorChip.setAttribute('aria-pressed', String(levels.has('error')));
}

/** A chip pins the view to its level alone; pressing it again lets go. */
function toggleLevelChip(level: SilenceLevel): void {
  const alone = view.levelFilter.size === 1 && view.levelFilter.has(level);
  setLevelFilter(alone ? [] : [level]);
}

/** Replace the level pin outright — entry points set what they want to see. */
export function setLevelFilter(levels: readonly SilenceLevel[]): void {
  view.levelFilter.clear();
  for (const level of levels) view.levelFilter.add(level);
  renderLevelChips();
  applyFilter();
}

export function applyFilter(): void {
  view.filterRe = buildFilter(filterEl.value);
  recomputeVisible(view.filterRe, view.levelFilter);
  renderAtBottom();
  reportSelection();
}

/** Point the view at a fresh set of lines (a scope switch or a snapshot). */
export function resetBuffer(next: LogEntry[]): void {
  replaceEntries(next, view.filterRe, view.levelFilter);
  indexStacks(buffer.entries);
  recount();
  renderAtBottom();
  reportSelection();
}

/**
 * A line that just arrived. It only reaches the DOM when the view is already
 * at the bottom: scrolled back, you are reading history and must not be
 * yanked forward.
 */
export function pushEntry(entry: LogEntry): void {
  // A selection detaches the view from the tail. Otherwise every arriving line
  // slides the window and drops rows off the top — with the DOM budget down
  // from the old 20 000 to a few hundred that happens constantly, so a
  // selection visibly ate itself row by row while its owner watched.
  // The lines still accumulate in the buffer; ↓ or clearing the selection
  // returns to following them.
  const wasAtEnd =
    buffer.winEnd >= buffer.visible.length - 1 && buffer.selected.size === 0;
  indexStackEntry(buffer.entries[buffer.entries.length - 1], entry);
  buffer.entries.push(entry);
  addToTally(tally, entry);
  dispatchLive({ type: 'arrived', count: 1 }); // counted only while paused
  if (buffer.entries.length > view.memoryCap + EDGE_CHUNK && trimMemory()) {
    // A trim rebuilds `visible` and the window from scratch, this entry
    // included. Carrying on would push its index a second time and append a
    // second row for it — one duplicate per trim, for the life of the view.
    renderCounts();
    return;
  }
  const entryIndex = buffer.entries.length - 1;
  if (!matchesFilter(entry, view.filterRe, view.levelFilter)) {
    renderCounts();
    return;
  }
  buffer.visible.push(entryIndex);
  if (!wasAtEnd) {
    renderCounts();
    return;
  }
  linesEl.appendChild(buildRow(entry, entryIndex, showInContext));
  refreshStackHead(entry, entryIndex);
  buffer.winEnd = buffer.visible.length - 1;
  while (
    linesEl.childElementCount > WINDOW_ROWS + EDGE_CHUNK &&
    linesEl.firstChild
  ) {
    linesEl.removeChild(linesEl.firstChild);
    buffer.winStart += 1;
  }
  if (view.live.following) mainEl.scrollTop = mainEl.scrollHeight;
  renderCounts();
  updateScrollButton();
}

/**
 * A frame that joined a block changes how the block's FIRST row looks — the
 * «+N» it counts, or whether it folds at all — so that one row is rebuilt.
 * Members are consecutive in the buffer, which is what locates it.
 */
function refreshStackHead(entry: LogEntry, entryIndex: number): void {
  const block = stackOf(entry);
  if (!block || block.members.length < 2) return;
  const firstIndex = entryIndex - block.members.length + 1;
  const first = block.members[0];
  // Walk back from the row just appended rather than querying: the first row
  // of the block is at most `members.length` rows up, and a selector over the
  // whole list on every arriving frame is what a fast stream cannot afford.
  let row = linesEl.lastElementChild;
  for (let i = 1; i < block.members.length && row; i += 1)
    row = row.previousElementSibling;
  if (
    row instanceof HTMLElement &&
    row.dataset.eidx === String(firstIndex) &&
    first
  )
    row.replaceWith(buildRow(first, firstIndex, showInContext));
}

/** Rebuild the drawn rows where they are — a block folded or unfolded. */
function repaintInPlace(): void {
  const top = mainEl.scrollTop;
  renderWindow(buffer.winStart, buffer.winEnd);
  mainEl.scrollTop = view.live.following ? mainEl.scrollHeight : top;
  updateScrollButton();
}

installRowHooks({ repaint: repaintInPlace });

/** Drop the oldest lines once memory is past its cap, and redraw. */
export function trimMemory(): boolean {
  const trim = trimBuffer(view.memoryCap, view.filterRe, view.levelFilter);
  if (!trim) return false;
  recount();
  // Only jump to the tail if that is where the reader already was. Forcing it
  // would drag anyone scrolled back to the end every few hundred lines.
  if (trim.wasFollowing) {
    renderAtBottom();
    return true;
  }
  const win = clampWindow(
    buffer.winStart - trim.droppedVisible,
    buffer.winEnd - trim.droppedVisible,
    buffer.visible.length,
  );
  renderWindow(win.start, win.end);
  updateScrollButton();
  return true;
}

function flushQueue(): void {
  if (isHolding(view.live)) return;
  while (pendingQueue.length) {
    const entry = pendingQueue.shift();
    if (entry) pushEntry(entry);
  }
}

/**
 * At the end of the LOG, not merely at the end of what is drawn. With a window
 * over the buffer those stopped being the same thing: scrolled back, the bottom
 * of the DOM is the bottom of the window, and there are newer lines past it.
 */
function isAtBottom(): boolean {
  if (buffer.winEnd < buffer.visible.length - 1) return false;
  return (
    mainEl.scrollTop + mainEl.clientHeight >=
    mainEl.scrollHeight - SCROLL_THRESHOLD
  );
}

export function updateScrollButton(): void {
  if (!scrollBtn) return;
  const atBottom = isAtBottom();
  scrollBtn.classList.toggle('visible', !atBottom);
  // Never resume following while lines are selected: that is the one moment
  // the reader has said, by picking rows, that they are not watching the tail.
  if (atBottom)
    dispatchLive({
      type: 'reachedTail',
      canResume: buffer.selected.size === 0,
    });
}

/**
 * Back to the tail and following it: what the live button does while paused,
 * and what the jump-to-bottom button always does. Lines held by a manual
 * pause go into the buffer first, so the tail drawn is the real one.
 */
function resumeLive(): void {
  dispatchLive({ type: 'resume' });
  flushQueue();
  // Move the WINDOW to the tail first. Scrolling the container alone would stop
  // at the end of the drawn slice, which is what this button appeared to do.
  renderAtBottom();
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
  if (changed) {
    recount();
    renderWindow(buffer.winStart, buffer.winEnd);
    updateScrollButton();
  }
}

// Approaching either edge extends the window there. No spinner and no gap:
// the lines are already in memory, this only decides what is drawn.
mainEl.addEventListener('scroll', () => {
  if (mainEl.scrollTop < EDGE_PX) growTop();
  else if (
    mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight <
    EDGE_PX
  )
    growBottom();
});

mainEl.addEventListener('scroll', () => {
  if (!isAtBottom()) dispatchLive({ type: 'leftTail' });
  updateScrollButton();
});

window.addEventListener('resize', updateScrollButton);

scrollBtn.addEventListener('click', resumeLive);

liveBtn.addEventListener('click', () => {
  if (view.live.following) dispatchLive({ type: 'press' });
  else resumeLive();
});
paintLive();

filterEl.addEventListener('input', applyFilter);
levelAllBtn.addEventListener('click', () => setLevelFilter([]));
levelWarnChip.addEventListener('click', () => toggleLevelChip('warn'));
levelErrorChip.addEventListener('click', () => toggleLevelChip('error'));
