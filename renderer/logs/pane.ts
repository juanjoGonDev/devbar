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
import {
  buildFilter,
  clientMatchesPattern,
  levelPillClass,
  levelPillLabel,
  matchesFilter,
} from './filters.js';
import {
  buffer,
  recomputeVisible,
  replaceEntries,
  trimBuffer,
} from './buffer.js';
import { buildRow } from './rows.js';
import { pushMutedLine } from './drawer.js';
import { pendingQueue, reportSelection } from './status.js';
import {
  autoscrollEl,
  countsEl,
  filterEl,
  levelPillEl,
  levelPillTextEl,
  linesEl,
  mainEl,
  pausedEl,
  scrollBtn,
  setText,
  statusEl,
} from './elements.js';
import { view } from './view.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/** Rows rendered on a fresh view, and added per edge as you scroll. */
const WINDOW_ROWS = 600;
export const EDGE_CHUNK = 300;
/** How close to an edge counts as approaching it. */
const EDGE_PX = 500;
const SCROLL_THRESHOLD = 4;

function renderCounts(): void {
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
  autoscrollEl.checked = false; // otherwise the tail yanks us away again
  if (Number.isFinite(entryIndex)) flashEntry(entryIndex);
}

/** Show the escape hatch only while a level filter is actually narrowing things. */
export function renderLevelChips(): void {
  const active = [...view.levelFilter];
  levelPillEl.hidden = active.length === 0;
  if (!active.length) return;
  setText(levelPillTextEl, levelPillLabel(active));
  levelPillEl.title = 'Quitar el filtro de nivel';
  levelPillEl.className = levelPillClass(active);
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
  renderAtBottom();
  reportSelection();
}

/**
 * A line that just arrived. It only reaches the DOM when the view is already
 * at the bottom: scrolled back, you are reading history and must not be
 * yanked forward.
 */
export function pushEntry(entry: LogEntry): void {
  if (entry.silenced) pushMutedLine(entry);
  // A selection detaches the view from the tail. Otherwise every arriving line
  // slides the window and drops rows off the top — with the DOM budget down
  // from the old 20 000 to a few hundred that happens constantly, so a
  // selection visibly ate itself row by row while its owner watched.
  // The lines still accumulate in the buffer; ↓ or clearing the selection
  // returns to following them.
  const wasAtEnd =
    buffer.winEnd >= buffer.visible.length - 1 && buffer.selected.size === 0;
  buffer.entries.push(entry);
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
  buffer.winEnd = buffer.visible.length - 1;
  while (
    linesEl.childElementCount > WINDOW_ROWS + EDGE_CHUNK &&
    linesEl.firstChild
  ) {
    linesEl.removeChild(linesEl.firstChild);
    buffer.winStart += 1;
  }
  if (autoscrollEl.checked) mainEl.scrollTop = mainEl.scrollHeight;
  renderCounts();
  updateScrollButton();
}

/** Drop the oldest lines once memory is past its cap, and redraw. */
export function trimMemory(): boolean {
  const trim = trimBuffer(view.memoryCap, view.filterRe, view.levelFilter);
  if (!trim) return false;
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
  if (pausedEl.checked) return;
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
  if (atBottom && !autoscrollEl.checked && buffer.selected.size === 0) {
    autoscrollEl.checked = true;
  }
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
  const atBottom = isAtBottom();
  if (!atBottom && autoscrollEl.checked) {
    autoscrollEl.checked = false;
  }
  updateScrollButton();
});

window.addEventListener('resize', updateScrollButton);

scrollBtn.addEventListener('click', () => {
  // Move the WINDOW to the tail first. Scrolling the container alone would stop
  // at the end of the drawn slice, which is what this button appeared to do.
  renderAtBottom();
  autoscrollEl.checked = true;
  updateScrollButton();
});

filterEl.addEventListener('input', applyFilter);
levelPillEl.addEventListener('click', () => setLevelFilter([]));
pausedEl.addEventListener('change', () => {
  statusEl.textContent = pausedEl.checked ? 'Pausado' : '';
  if (!pausedEl.checked) flushQueue();
});
