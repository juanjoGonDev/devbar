/**
 * «Buscar en el log»: the find widget floating over the log pane.
 *
 * Opens with Cmd/Ctrl+F (or the header's button, through `devbar:find`),
 * closes with Escape. By default every line stays on screen and the hits are
 * marked, the current one brighter; «Solo coincidencias» hides the rest, which
 * is what the old search box always did. The level chips live here too.
 *
 * The arithmetic is in `find-model.ts`; this module binds it to the widget and
 * to the pane. It has to stay fast on a 50 000-line buffer that keeps
 * streaming, so: typing is debounced, a line that arrives is counted on its
 * own (the pane calls `appended`), only the drawn window is ever marked (rows
 * mark themselves as they are built), and the ticks are redrawn at most a few
 * times a second, merged into a fixed number of slots.
 */
import { stripAnsi } from './ansi.js';
import { buffer } from './buffer.js';
import { applyFilter, renderLevelChips, revealEntry } from './pane.js';
import { dispatchLive } from './live.js';
import { isFolded, stackOf, toggleStack } from './stack-fold.js';
import {
  findCaseBtn,
  findCloseBtn,
  findCountEl,
  findEl,
  findFieldEl,
  findInputEl,
  findNextBtn,
  findOnlyBtn,
  findPrevBtn,
  findRegexBtn,
  findTicksEl,
  findWordBtn,
  linesEl,
  mainEl,
  setText,
} from './elements.js';
import { installFindHooks, rowHooks, view } from './view.js';
import {
  DEFAULT_FIND_OPTIONS,
  appendMatch,
  buildMatches,
  compileFind,
  counterLabel,
  emptyMatches,
  hitRanges,
  nearestCursor,
  ordinalOf,
  parseFindOptions,
  rebaseMatches,
  stepCursor,
  tickMarks,
  type CompiledFind,
  type FindCursor,
  type FindOptions,
  type Tick,
} from './find-model.js';

/** The toggles survive a restart; the query does not. */
const OPTIONS_KEY = 'devbar.logs.find';
/** Typing pauses this long before 50 000 lines are searched again. */
export const FIND_DEBOUNCE_MS = 120;
/** How often, at most, the ticks are redrawn while lines stream in. */
export const TICKS_DELAY_MS = 150;
/** Slots the ticks are merged into: a few hundred marks, never 50 000. */
const TICK_SLOTS = 400;

const NOTHING: CompiledFind = { re: null, error: null };

let options: FindOptions = loadOptions();
let compiled: CompiledFind = NOTHING;
let matches = emptyMatches();
let isOpen = false;
let ticks: Tick[] = [];
let queryTimer: ReturnType<typeof setTimeout> | null = null;
let ticksTimer: ReturnType<typeof setTimeout> | null = null;

function loadOptions(): FindOptions {
  try {
    return parseFindOptions(localStorage.getItem(OPTIONS_KEY));
  } catch (_) {
    return { ...DEFAULT_FIND_OPTIONS };
  }
}

function saveOptions(): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch (_) {
    // Storage off or full: the toggles still work, they just are not kept.
  }
}

function textOf(entryIndex: number): string {
  const entry = buffer.entries[entryIndex];
  return entry ? stripAnsi(entry.line) : '';
}

// ─────────────────────────── Painting ───────────────────────────

const TOGGLES: ReadonlyArray<[HTMLButtonElement, keyof FindOptions]> = [
  [findCaseBtn, 'caseSensitive'],
  [findWordBtn, 'wholeWord'],
  [findRegexBtn, 'regex'],
  [findOnlyBtn, 'onlyMatches'],
];

function paintToggles(): void {
  for (const [button, key] of TOGGLES)
    button.setAttribute('aria-pressed', String(options[key]));
}

function paintCounter(): void {
  const searching = compiled.re !== null || compiled.error !== null;
  setText(findCountEl, counterLabel(matches, view.findCurrent, searching));
  const none = matches.total === 0;
  findPrevBtn.disabled = none;
  findNextBtn.disabled = none;
}

/**
 * The field's red ring, and why: the tooltip carries the regex error. The
 * tooltip module moves a `title` into `data-tip`, so clearing it means
 * clearing what it left behind too.
 */
function paintError(): void {
  const error = compiled.error;
  findFieldEl.classList.toggle('invalid', error !== null);
  findInputEl.setAttribute('aria-invalid', String(error !== null));
  if (error) {
    findFieldEl.title = error;
    return;
  }
  findFieldEl.removeAttribute('title');
  if (findFieldEl.getAttribute('aria-label') === findFieldEl.dataset.tip)
    findFieldEl.removeAttribute('aria-label');
  delete findFieldEl.dataset.tip;
}

function paintTicks(): void {
  ticksTimer = null;
  const show = isOpen && matches.total > 0;
  findTicksEl.hidden = !show;
  ticks = show
    ? tickMarks(matches, buffer.visible, view.findCurrent, TICK_SLOTS)
    : [];
  const fragment = document.createDocumentFragment();
  ticks.forEach((tick, index) => {
    const mark = document.createElement('span');
    mark.className = tick.current ? 'find-tick current' : 'find-tick';
    mark.style.top = `${(tick.fraction * 100).toFixed(3)}%`;
    mark.dataset.tick = String(index);
    fragment.appendChild(mark);
  });
  findTicksEl.replaceChildren(fragment);
}

function scheduleTicks(): void {
  if (ticksTimer) return;
  ticksTimer = setTimeout(paintTicks, TICKS_DELAY_MS);
}

/** Move the «current» marks in the drawn rows without rebuilding them. */
function paintCurrentInPlace(): void {
  for (const node of Array.from(
    linesEl.querySelectorAll('.find-current, mark.find-hit.current'),
  ))
    node.classList.remove(node.tagName === 'MARK' ? 'current' : 'find-current');
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

// ─────────────────────────── Matching ───────────────────────────

/** The first drawn line the reader can actually see, to start searching from. */
function topEntryInView(): number {
  const rows = linesEl.children;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid] as HTMLElement;
    if (row.offsetTop + row.offsetHeight <= mainEl.scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const row = rows[lo] as HTMLElement | undefined;
  return row ? Number(row.dataset.eidx) : (buffer.visible[0] ?? 0);
}

/** Count every match in `visible` again, keeping the cursor where it was. */
function recount(): void {
  const previous = view.findCurrent;
  matches = view.findRe
    ? buildMatches(buffer.visible, textOf, view.findRe)
    : emptyMatches();
  view.findCurrent =
    previous && ordinalOf(matches, previous) >= 0
      ? previous
      : nearestCursor(matches, previous?.entry ?? topEntryInView());
  paintCounter();
  scheduleTicks();
}

function appended(entryIndex: number): void {
  if (!view.findRe) return;
  const count = hitRanges(textOf(entryIndex), view.findRe).length;
  if (!count) return;
  appendMatch(matches, entryIndex, count);
  view.findCurrent ??= { entry: entryIndex, hit: 0 };
  paintCounter();
  scheduleTicks();
}

function trimmed(dropped: number): void {
  if (!view.findRe) return;
  matches = rebaseMatches(matches, dropped);
  const previous = view.findCurrent;
  const moved = previous && {
    entry: previous.entry - dropped,
    hit: previous.hit,
  };
  view.findCurrent =
    moved && ordinalOf(matches, moved) >= 0 ? moved : nearestCursor(matches, 0);
  paintCounter();
  scheduleTicks();
}

/** The find regex without `g`, for the filter: `test` must keep no state. */
function asFilter(re: RegExp | null): RegExp | null {
  if (!re || !options.onlyMatches) return null;
  return new RegExp(re.source, re.flags.replace('g', ''));
}

/** Compile what is in the box and redraw with it. */
function applyQuery(): void {
  if (queryTimer) {
    clearTimeout(queryTimer);
    queryTimer = null;
  }
  compiled = isOpen ? compileFind(findInputEl.value, options) : NOTHING;
  paintError();
  view.findRe = compiled.re;
  const filter = asFilter(compiled.re);
  if (filter || view.filterRe) {
    // What is visible changes: the pane rebuilds it and asks for a recount.
    // Following the tail stays at the tail; otherwise stay on the hit.
    view.filterRe = filter;
    applyFilter(view.live.following ? undefined : view.findCurrent?.entry);
  } else {
    recount();
    rowHooks.repaint();
  }
  paintCounter();
  scheduleTicks();
}

function scheduleQuery(): void {
  if (queryTimer) clearTimeout(queryTimer);
  queryTimer = setTimeout(applyQuery, FIND_DEBOUNCE_MS);
}

// ─────────────────────────── Moving ───────────────────────────

/**
 * Put the reader on `cursor`: open the stack it is folded into, draw it,
 * centre it. Landing is reading, so the live tail lets go, as scrolling up
 * does.
 */
function land(cursor: FindCursor): void {
  view.findCurrent = cursor;
  dispatchLive({ type: 'leftTail' });
  const entry = buffer.entries[cursor.entry];
  const block = entry && !view.filterRe ? stackOf(entry) : undefined;
  if (block && isFolded(block)) {
    toggleStack(block);
    rowHooks.repaint();
  } else paintCurrentInPlace();
  revealEntry(cursor.entry);
  paintCounter();
  scheduleTicks();
}

function go(direction: 1 | -1): void {
  if (queryTimer) applyQuery(); // Enter right after typing searches first
  const next = stepCursor(matches, view.findCurrent, direction);
  if (next) land(next);
}

// ─────────────────────────── Opening ───────────────────────────

/** One line of text selected inside the log, to search for. */
function selectedLogText(): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return '';
  if (!linesEl.contains(selection.anchorNode)) return '';
  const text = selection.toString().trim();
  return text.includes('\n') ? '' : text;
}

function setOpen(next: boolean): void {
  isOpen = next;
  findEl.hidden = !next;
  document.documentElement.dataset.findOpen = next ? 'true' : '';
}

/** Show the widget; `focus` puts the cursor in the box, its text selected. */
export function openFind(focus = true): void {
  const selected = focus ? selectedLogText() : '';
  if (selected) findInputEl.value = selected;
  const wasOpen = isOpen;
  setOpen(true);
  if (focus) {
    findInputEl.focus();
    findInputEl.select();
  }
  if (!wasOpen || selected) applyQuery();
}

/**
 * Hide the widget and everything it was doing: the marks, the ticks, the
 * lines «Solo coincidencias» or a level chip were hiding. The text stays in
 * the box for the next time it opens.
 */
export function closeFind(): void {
  if (!isOpen) return;
  const anchor = view.findCurrent?.entry;
  setOpen(false);
  compiled = NOTHING;
  paintError();
  view.findRe = null;
  view.findCurrent = null;
  matches = emptyMatches();
  if (view.filterRe || view.levelFilter.size) {
    view.filterRe = null;
    view.levelFilter.clear();
    renderLevelChips();
    applyFilter(view.live.following ? undefined : anchor);
  } else rowHooks.repaint();
  paintCounter();
  paintTicks();
  mainEl.focus({ preventScroll: true });
}

function toggleFind(): void {
  if (isOpen) closeFind();
  else openFind();
}

/**
 * Show only the lines containing `query` — what an entry point that carries
 * a filter, or a row's «Filtrar por esto», asks for.
 */
export function filterBy(query: string): void {
  findInputEl.value = query;
  options = { ...options, onlyMatches: true };
  saveOptions();
  paintToggles();
  setOpen(true);
  applyQuery();
}

/** Empty the box, for an entry point that must not inherit a stale search. */
export function clearFindQuery(): void {
  findInputEl.value = '';
  if (isOpen) applyQuery();
}

// ─────────────────────────── Wiring ───────────────────────────

installFindHooks({
  recount,
  appended,
  trimmed,
  filterDropped() {
    options = { ...options, onlyMatches: false };
    saveOptions();
    paintToggles();
  },
  levelPinned() {
    if (!isOpen) openFind(false);
  },
});

for (const [button, key] of TOGGLES) {
  button.addEventListener('click', () => {
    options = { ...options, [key]: !options[key] };
    saveOptions();
    paintToggles();
    applyQuery();
  });
}

findInputEl.addEventListener('input', scheduleQuery);
findInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  go(event.shiftKey ? -1 : 1);
});

findEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation(); // Escape here closes the widget, nothing else
  closeFind();
});

findPrevBtn.addEventListener('click', () => go(-1));
findNextBtn.addEventListener('click', () => go(1));
findCloseBtn.addEventListener('click', closeFind);

findTicksEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.tick) return;
  const tick = ticks[Number(target.dataset.tick)];
  if (tick) land(tick.cursor);
});

document.addEventListener('keydown', (event) => {
  const accel = event.metaKey || event.ctrlKey;
  if (accel && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFind();
    return;
  }
  if (event.key === 'F3') {
    event.preventDefault();
    if (isOpen) go(event.shiftKey ? -1 : 1);
    else openFind();
  }
});

/** The header's button: `detail` is 'toggle', 'open' or 'close'. */
document.addEventListener('devbar:find', (event) => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === 'open') openFind();
  else if (detail === 'close') closeFind();
  else if (detail === 'toggle') toggleFind();
});

paintToggles();
paintCounter();
document.documentElement.dataset.findOpen = '';
