/**
 * The activity strip under the toolbar: one bar per slice of time for the
 * lines the view shows, so a burst of errors twenty minutes back is visible —
 * and one click away — without scrolling to find it.
 *
 * It counts what is ON SCREEN: `buffer.visible`, after the level chip and the
 * search. Silenced lines stay on screen (marked), so they count as lines but
 * not as warnings or errors.
 *
 * Kept current without a recount per line: the pane appends to the same
 * `visible` array while lines stream in, so only the new tail is bucketed;
 * any wholesale change (a scope switch, a filter, a trim) builds a new array,
 * and that identity change is what triggers a rebuild. The DOM is repainted
 * on a ~4 fps tick, and only when what it would draw changed.
 */
import {
  activityBars,
  activitySummary,
  addActivityLine,
  barTitle,
  bucketKeyOf,
  buildActivity,
  createActivity,
  spanLabel,
  type ActivityLevel,
  type ActivityLine,
  type ActivityModel,
} from './activity-model.js';
import { buffer } from './buffer.js';
import {
  activityBarsEl,
  activityEl,
  activitySpanEl,
  linesEl,
  mainEl,
  setText,
} from './elements.js';
import { dispatchLive } from './live.js';
import { flashEntry } from './pane.js';
import { readPref, writePref } from './row-prefs.js';
import { view } from './view.js';
import type { LogEntry } from '../../src/domain-types.js';

const PREF_KEY = 'devbar.logs.activity';
/** ~4 repaints a second, however fast the stream. */
const REPAINT_MS = 250;
/** The tallest bar: the strip's 44px less its padding. */
const BAR_MAX_PX = 30;

let shown = readPref(PREF_KEY) !== 'off';
let model: ActivityModel = createActivity();
/** The `visible` array the model was built from, and how much of it it holds. */
let tracked: number[] | null = null;
let counted = 0;
let stale = true;
/** Bumped whenever the model changes, so an unchanged strip is not redrawn. */
let revision = 0;
let paintedSignature = '';
/** The bar the keyboard is on, so a repaint does not throw focus away. */
let focusKey: number | null = null;
/** Set while the bars are replaced, when losing focus is not the reader leaving. */
let repainting = false;

export function activityShown(): boolean {
  return shown;
}

export function setActivityShown(next: boolean): void {
  shown = next;
  writePref(PREF_KEY, next ? 'on' : 'off');
  paintActivity();
}

/** The held lines changed in place (silence rules): rebuild on the next tick. */
export function invalidateActivity(): void {
  stale = true;
}

function levelOf(entry: LogEntry): ActivityLevel {
  return entry.level === 'warn' || entry.level === 'error' ? entry.level : null;
}

function lineAt(position: number): ActivityLine | null {
  const entryIndex = buffer.visible[position];
  if (entryIndex === undefined) return null;
  const entry = buffer.entries[entryIndex];
  return entry ? { ts: entry.ts, level: levelOf(entry), entryIndex } : null;
}

function* visibleLines(from: number): Generator<ActivityLine> {
  for (let pos = from; pos < buffer.visible.length; pos += 1) {
    const line = lineAt(pos);
    if (line) yield line;
  }
}

/** Bring the model up to `buffer.visible`, as cheaply as what changed allows. */
function sync(): void {
  const visible = buffer.visible;
  if (stale || visible !== tracked || visible.length < counted) {
    model = buildActivity(visibleLines(0));
    stale = false;
    revision += 1;
  } else if (visible.length > counted) {
    for (const line of visibleLines(counted)) addActivityLine(model, line);
    revision += 1;
  }
  tracked = visible;
  counted = visible.length;
}

/** The drawn row at the middle of the viewport, found by bisection. */
function rowAtViewport(): HTMLElement | null {
  const rows = linesEl.children;
  if (!rows.length) return null;
  const box = mainEl.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (row && row.getBoundingClientRect().bottom < middle) low = mid + 1;
    else high = mid;
  }
  const row = rows[low];
  return row instanceof HTMLElement ? row : null;
}

/** The bucket the reader is looking at: the newest one while following. */
function currentKey(): number {
  if (view.live.following) return model.maxKey;
  const row = rowAtViewport();
  const entry = row ? buffer.entries[Number(row.dataset.eidx)] : undefined;
  return entry ? bucketKeyOf(model, entry.ts) : model.maxKey;
}

function buildBars(current: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const bars = activityBars(model, BAR_MAX_PX);
  const stop =
    focusKey !== null && model.buckets.has(focusKey) ? focusKey : current;
  for (const bar of bars) {
    const isCurrent = bar.key === current;
    const classes = `activity-bar tone-${bar.tone}${isCurrent ? ' current' : ''}`;
    if (!bar.count) {
      const gap = document.createElement('span');
      gap.className = classes;
      gap.setAttribute('aria-hidden', 'true');
      fragment.appendChild(gap);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = classes;
    button.dataset.key = String(bar.key);
    button.style.setProperty('--h', `${bar.height}px`);
    const title = barTitle(bar, model.step);
    button.title = title;
    button.setAttribute('aria-label', title);
    if (isCurrent) button.setAttribute('aria-current', 'true');
    button.tabIndex = bar.key === stop ? 0 : -1;
    fragment.appendChild(button);
  }
  return fragment;
}

/** Bring the strip up to date; a no-op when nothing it draws changed. */
export function paintActivity(): void {
  if (!shown) {
    activityEl.hidden = true;
    paintedSignature = '';
    return;
  }
  sync();
  const bucketsSpanned = model.maxKey - model.minKey + 1;
  if (!model.buckets.size || bucketsSpanned < 2) {
    activityEl.hidden = true;
    paintedSignature = '';
    return;
  }
  const current = currentKey();
  const signature = `${revision}|${current}|${focusKey}`;
  activityEl.hidden = false;
  if (signature === paintedSignature) return;
  paintedSignature = signature;
  const hadFocus = activityBarsEl.contains(document.activeElement);
  repainting = true;
  activityBarsEl.replaceChildren(buildBars(current));
  repainting = false;
  setText(activitySpanEl, spanLabel(model));
  activityEl.setAttribute('aria-label', activitySummary(model));
  if (hadFocus)
    activityBarsEl.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
}

function barButtons(): HTMLButtonElement[] {
  return Array.from(activityBarsEl.querySelectorAll('button'));
}

/** Land on a bucket's first line, paused there as scrolling up would. */
function jumpToBucket(key: number): void {
  sync();
  const bucket = model.buckets.get(key);
  if (!bucket) return;
  focusKey = key;
  dispatchLive({ type: 'leftTail' });
  flashEntry(bucket.firstEntry);
  paintActivity();
}

activityBarsEl.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest('button');
  if (button) jumpToBucket(Number(button.dataset.key));
});

/** One tab stop for the strip; the arrow keys, Home and End move along it. */
activityBarsEl.addEventListener('keydown', (event) => {
  const list = barButtons();
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  let next: number | null = null;
  if (event.key === 'ArrowLeft') next = Math.max(0, at - 1);
  if (event.key === 'ArrowRight') next = Math.min(list.length - 1, at + 1);
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = list.length - 1;
  if (next === null) return;
  event.preventDefault();
  const target = list[next];
  if (!target) return;
  for (const button of list) button.tabIndex = button === target ? 0 : -1;
  focusKey = Number(target.dataset.key);
  target.focus();
});

activityBarsEl.addEventListener('focusout', (event) => {
  if (repainting) return;
  if (!activityBarsEl.contains(event.relatedTarget as Node | null))
    focusKey = null;
});

setInterval(paintActivity, REPAINT_MS);
