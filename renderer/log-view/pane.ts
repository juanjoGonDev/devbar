/**
 * A log pane: which slice of a view's buffer is drawn, and how it moves.
 *
 * The DOM holds a few hundred rows around where you are looking, extended at
 * whichever edge you approach; `buffer.ts` owns the lines and the index
 * arithmetic, this module owns everything that touches the screen — the
 * window, the counts, the arriving line, the redraw, the scroll button.
 *
 * One pane per view (`createPane`): the logs window has one, the workflow
 * terminal another, and everything here reads its own context, never a
 * module-level copy. What only a view's chrome can paint — the level chips,
 * the selection count, the live button — goes out through `ctx.hooks`.
 */
import {
  clampWindow,
  extendBottom,
  extendTop,
  initialWindow,
  windowAround,
} from '../log-window.js';
import { matchesFilter } from '../logs/filters.js';
import {
  recomputeVisible,
  replaceEntries,
  swapRewritten,
  trimBuffer,
} from '../logs/buffer.js';
import { isHolding } from '../logs/live-state.js';
import {
  addToTally,
  tallyLevels,
  type LevelTally,
} from '../logs/toolbar-model.js';
import { createRowBuilder } from './rows.js';
import type { LogViewCtx } from './context.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/** Rows rendered on a fresh view, and added per edge as you scroll. */
const WINDOW_ROWS = 600;
export const EDGE_CHUNK = 300;
/** How close to an edge counts as approaching it. */
const EDGE_PX = 500;
const SCROLL_THRESHOLD = 4;

export interface LogPane {
  /** Point the view at a fresh set of lines (a scope switch or a snapshot). */
  resetBuffer: (next: LogEntry[]) => void;
  /** A line that just arrived (or a redraw of one already held). */
  pushEntry: (entry: LogEntry) => void;
  /** Re-decide which held lines pass the filters, and redraw. */
  applyFilter: (anchor?: number) => void;
  /** Replace the level pin outright. */
  setLevelFilter: (levels: readonly SilenceLevel[]) => void;
  /** Draw `entryIndex` and centre it; null when the filters hide it. */
  revealEntry: (entryIndex: number) => HTMLElement | null;
  /** Draw the window around an entry, scroll to it and mark it. */
  flashEntry: (entryIndex: number) => void;
  /** Move the find widget's «current» marks in the drawn rows. */
  paintFindCurrent: () => void;
  /** Rebuild the drawn rows where they are. */
  repaintInPlace: () => void;
  /** Drop the oldest lines once memory is past its cap, and redraw. */
  trimMemory: () => boolean;
  updateScrollButton: () => void;
  /** Back to the tail and following it, flushing what a pause held. */
  resumeLive: () => void;
  /** The held lines' levels changed in place: count and draw them again. */
  relevelled: () => void;
}

export function createPane(ctx: LogViewCtx): LogPane {
  const { state: view, buffer, stacks, find: findHooks, hooks } = ctx;
  const { lines: linesEl, main: mainEl, scrollButton: scrollBtn } = ctx.els;
  const dispatchLive = ctx.dispatchLive;
  const buildRow = createRowBuilder(ctx, repaintInPlace);

  /**
   * Warn/error lines held, behind the level chips' numbers, and the silenced
   * ones behind the footer's. Kept up to date one line at a time — recounting
   * 20 000 entries for every arriving line would be the slowest thing in the
   * view — and recounted whenever the held lines are replaced wholesale.
   */
  let tally: LevelTally = { warn: 0, error: 0, silenced: 0 };

  function recount(): void {
    tally = tallyLevels(buffer.entries);
  }

  function renderCounts(): void {
    hooks.counts?.(tally);
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
      if (entry)
        fragment.appendChild(buildRow(entry, entryIndex, showInContext));
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

  function flashEntry(entryIndex: number): void {
    const row = renderAroundEntry(entryIndex);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation if it is already running
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  }

  /**
   * Drop every filter and land on this line, in sequence with everything
   * around it. Filtering only ever hides rows — it never removes them — so
   * putting a warning back among its neighbours costs nothing but a repaint
   * and a scroll. That context is usually where the cause is: the line before
   * the failure.
   */
  function showInContext(row: HTMLElement): void {
    const entryIndex = Number(row.dataset.eidx);
    // The find query stays marked; it just stops hiding the lines around it.
    if (view.filterRe) {
      view.filterRe = null;
      findHooks.filterDropped();
    }
    // Re-filtering re-renders, so the row handed in here is discarded — the
    // entry index is what survives, and the window is rebuilt around it.
    setLevelFilter([]);
    // Always respond, even when nothing was filtered. A control that looks
    // pressable and answers with silence teaches you to stop pressing it; with
    // no filter on, centring and flashing the line is still a real answer.
    dispatchLive({ type: 'leftTail' }); // otherwise the tail yanks us away again
    if (Number.isFinite(entryIndex)) flashEntry(entryIndex);
  }

  /** Replace the level pin outright — entry points set what they want to see. */
  function setLevelFilter(levels: readonly SilenceLevel[]): void {
    view.levelFilter.clear();
    for (const level of levels) view.levelFilter.add(level);
    hooks.levelFilter?.();
    applyFilter();
    // The chips live in the find widget: a pinned level nobody can see would
    // read as lines that went missing.
    if (levels.length) findHooks.levelPinned();
  }

  /**
   * At the tail by default; around `anchor` when the reader was on a line that
   * still passes — toggling «Solo coincidencias» on a match must not throw
   * them to the end.
   */
  function applyFilter(anchor?: number): void {
    recomputeVisible(view.filterRe, view.levelFilter, buffer);
    findHooks.recount();
    const row = anchor === undefined ? null : renderAroundEntry(anchor);
    if (row) row.scrollIntoView({ block: 'center' });
    else renderAtBottom();
    hooks.selection?.();
  }

  /**
   * A row already in the window is reused rather than redrawn: going from one
   * hit to the next must not rebuild six hundred rows.
   */
  function revealEntry(entryIndex: number): HTMLElement | null {
    const drawn = linesEl.querySelector<HTMLElement>(
      `.line[data-eidx="${entryIndex}"]`,
    );
    const row = drawn ?? renderAroundEntry(entryIndex);
    if (!row) return null;
    const target =
      row.querySelector<HTMLElement>('mark.find-hit.current') ?? row;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    return row;
  }

  function resetBuffer(next: LogEntry[]): void {
    replaceEntries(next, view.filterRe, view.levelFilter, buffer);
    stacks.indexAll(buffer.entries);
    recount();
    findHooks.recount();
    renderAtBottom();
    hooks.selection?.();
  }

  /**
   * It only reaches the DOM when the view is already at the bottom: scrolled
   * back, you are reading history and must not be yanked forward.
   */
  function pushEntry(entry: LogEntry): void {
    if (entry.replaces !== undefined && redrawEntry(entry)) return;
    // A selection detaches the view from the tail. Otherwise every arriving
    // line slides the window and drops rows off the top, so a selection
    // visibly ate itself row by row while its owner watched. The lines still
    // accumulate in the buffer; ↓ or clearing the selection returns to
    // following them.
    const wasAtEnd =
      buffer.winEnd >= buffer.visible.length - 1 && buffer.selected.size === 0;
    stacks.indexEntry(buffer.entries[buffer.entries.length - 1], entry);
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
    findHooks.appended(entryIndex);
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
   * A redraw of a line a carriage return rewrote (a progress bar): it takes
   * that line's place, row and all, instead of arriving — so it is no news to
   * a paused reader and no new line in the counts. False when the buffer no
   * longer holds the line it rewrites: it is then appended like any other.
   */
  function redrawEntry(entry: LogEntry): boolean {
    const swap = swapRewritten(entry, buffer);
    if (!swap) return false;
    const { index, previous } = swap;
    addToTally(tally, previous, -1);
    addToTally(tally, entry);
    // A frame of a stack block is part of its head's fold: re-read the blocks.
    const frames = stacks.stackOf(previous)?.members.length;
    if (frames !== undefined) stacks.indexAll(buffer.entries);
    else stacks.indexEntry(buffer.entries[index - 1], entry);
    const shown = matchesFilter(entry, view.filterRe, view.levelFilter);
    if (shown !== matchesFilter(previous, view.filterRe, view.levelFilter)) {
      // In or out of the filtered view: `visible` changes shape.
      recomputeVisible(view.filterRe, view.levelFilter, buffer);
      findHooks.recount();
      if (view.live.following) renderAtBottom();
      else repaintInPlace();
      return true;
    }
    if (view.findRe) findHooks.recount(); // its hits are in the text that changed
    // Joining or leaving a block changes how its first row folds, not just this one.
    if (stacks.stackOf(entry)?.members.length !== frames) repaintInPlace();
    else {
      linesEl
        .querySelector(`.line[data-eidx="${index}"]`)
        ?.replaceWith(buildRow(entry, index, showInContext));
      // The recount may have moved the current hit to a row nobody rebuilt.
      if (view.findRe) paintFindCurrent();
    }
    if (view.live.following) mainEl.scrollTop = mainEl.scrollHeight;
    renderCounts();
    updateScrollButton();
    return true;
  }

  /**
   * A frame that joined a block changes how the block's FIRST row looks — the
   * «+N» it counts, or whether it folds at all — so that one row is rebuilt.
   * Members are consecutive in the buffer, which is what locates it.
   */
  function refreshStackHead(entry: LogEntry, entryIndex: number): void {
    const block = stacks.stackOf(entry);
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

  function paintFindCurrent(): void {
    for (const node of Array.from(
      linesEl.querySelectorAll('.find-current, mark.find-hit.current'),
    ))
      node.classList.remove(
        node.tagName === 'MARK' ? 'current' : 'find-current',
      );
    const current = view.findCurrent;
    if (!current) return;
    const row = linesEl.querySelector<HTMLElement>(
      `.line[data-eidx="${current.entry}"]`,
    );
    if (!row) return;
    row.classList.add('find-current');
    for (const mark of Array.from(
      row.querySelectorAll(`mark.find-hit[data-hit="${current.hit}"]`),
    ))
      mark.classList.add('current');
  }

  /** A block folded or unfolded, a search marked: same rows, drawn again. */
  function repaintInPlace(): void {
    const top = mainEl.scrollTop;
    renderWindow(buffer.winStart, buffer.winEnd);
    mainEl.scrollTop = view.live.following ? mainEl.scrollHeight : top;
    updateScrollButton();
  }

  function trimMemory(): boolean {
    const held = buffer.entries.length;
    const trim = trimBuffer(
      view.memoryCap,
      view.filterRe,
      view.levelFilter,
      buffer,
    );
    if (!trim) return false;
    recount();
    findHooks.trimmed(held - buffer.entries.length);
    // Only jump to the tail if that is where the reader already was. Forcing
    // it would drag anyone scrolled back to the end every few hundred lines.
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
    while (ctx.pending.length) {
      const entry = ctx.pending.shift();
      if (entry) pushEntry(entry);
    }
  }

  /**
   * At the end of the LOG, not merely at the end of what is drawn. With a
   * window over the buffer those stopped being the same thing: scrolled back,
   * the bottom of the DOM is the bottom of the window, and there are newer
   * lines past it.
   */
  function isAtBottom(): boolean {
    if (buffer.winEnd < buffer.visible.length - 1) return false;
    return (
      mainEl.scrollTop + mainEl.clientHeight >=
      mainEl.scrollHeight - SCROLL_THRESHOLD
    );
  }

  function updateScrollButton(): void {
    const atBottom = isAtBottom();
    scrollBtn?.classList.toggle('visible', !atBottom);
    // Never resume following while lines are selected: that is the one moment
    // the reader has said, by picking rows, that they are not watching the tail.
    if (atBottom)
      dispatchLive({
        type: 'reachedTail',
        canResume: buffer.selected.size === 0,
      });
  }

  /**
   * What the live button does while paused, and what the jump-to-bottom
   * button always does. Lines held by a manual pause go into the buffer
   * first, so the tail drawn is the real one.
   */
  function resumeLive(): void {
    dispatchLive({ type: 'resume' });
    flushQueue();
    // Move the WINDOW to the tail first. Scrolling the container alone would
    // stop at the end of the drawn slice, which is what this button appeared
    // to do.
    renderAtBottom();
  }

  function relevelled(): void {
    recount();
    renderWindow(buffer.winStart, buffer.winEnd);
    updateScrollButton();
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
  scrollBtn?.addEventListener('click', resumeLive);

  return {
    resetBuffer,
    pushEntry,
    applyFilter,
    setLevelFilter,
    revealEntry,
    flashEntry,
    paintFindCurrent,
    repaintInPlace,
    trimMemory,
    updateScrollButton,
    resumeLive,
    relevelled,
  };
}
