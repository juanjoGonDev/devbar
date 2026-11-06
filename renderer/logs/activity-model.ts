/**
 * The arithmetic behind the activity strip: one bar per slice of time, as tall
 * as the lines it holds and coloured by the worst of them.
 *
 * Buckets are keyed by `floor(ts / step)`, so a line lands in its bucket in
 * O(1) and a streaming log only ever touches the last one. The step adapts to
 * the span so the strip never holds more than `ACTIVITY_MAX_BARS` bars: every
 * step in the ladder is a whole multiple of the one before, which is what lets
 * a growing log widen its buckets by MERGING the ones it has — no line is read
 * twice, and the result is exactly what bucketing everything afresh would give.
 *
 * Pure on purpose: nothing here touches the DOM.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** At most this many bars fill the strip. */
export const ACTIVITY_MAX_BARS = 60;

/** Each step divides the next, so widening merges buckets instead of re-reading lines. */
const STEPS: readonly number[] = [
  SECOND,
  5 * SECOND,
  10 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

/** A busy bucket is never drawn shorter than this, however quiet. */
const MIN_BAR_PX = 2;

export type ActivityLevel = 'warn' | 'error' | null;

/** What the strip needs to know about one visible line. */
export interface ActivityLine {
  ts: number;
  /** The level it shows with: a silenced warning no longer counts as one. */
  level: ActivityLevel;
  /** Where it lives in the buffer, so a bar can jump to its first line. */
  entryIndex: number;
}

interface Bucket {
  count: number;
  warns: number;
  errors: number;
  firstEntry: number;
}

export interface ActivityModel {
  step: number;
  buckets: Map<number, Bucket>;
  minKey: number;
  maxKey: number;
  lines: number;
  errors: number;
}

type BarTone = 'empty' | 'normal' | 'warn' | 'error';

export interface ActivityBar {
  key: number;
  start: number;
  count: number;
  warns: number;
  errors: number;
  /** The first line of the bucket in the buffer; -1 for an empty one. */
  firstEntry: number;
  tone: BarTone;
  /** In pixels, square-root scaled against the busiest bucket. */
  height: number;
}

/** The smallest step that fits `spanMs` into the bar budget. */
export function pickStep(spanMs: number): number {
  for (const step of STEPS)
    if (Math.floor(spanMs / step) + 1 <= ACTIVITY_MAX_BARS) return step;
  return DAY;
}

export function createActivity(step: number = SECOND): ActivityModel {
  return {
    step,
    buckets: new Map(),
    minKey: Number.POSITIVE_INFINITY,
    maxKey: Number.NEGATIVE_INFINITY,
    lines: 0,
    errors: 0,
  };
}

export function bucketKeyOf(model: ActivityModel, ts: number): number {
  return Math.floor(ts / model.step);
}

/** Widen the buckets to `step`, merging the narrower ones into it. */
function widen(model: ActivityModel, step: number): void {
  const ratio = step / model.step;
  const merged = new Map<number, Bucket>();
  for (const [key, bucket] of model.buckets) {
    const next = Math.floor(key / ratio);
    const into = merged.get(next);
    if (!into) {
      merged.set(next, { ...bucket });
      continue;
    }
    into.count += bucket.count;
    into.warns += bucket.warns;
    into.errors += bucket.errors;
    into.firstEntry = Math.min(into.firstEntry, bucket.firstEntry);
  }
  model.buckets = merged;
  model.step = step;
  model.minKey = Math.floor(model.minKey / ratio);
  model.maxKey = Math.floor(model.maxKey / ratio);
}

/** Widen until the range of buckets fits the bar budget. */
function fit(model: ActivityModel): void {
  while (model.maxKey - model.minKey + 1 > ACTIVITY_MAX_BARS) {
    const next = STEPS.find((step) => step > model.step);
    if (next === undefined) return;
    widen(model, next);
  }
}

/** Count one line; O(1) unless it is the line that makes the buckets widen. */
export function addActivityLine(
  model: ActivityModel,
  line: ActivityLine,
): void {
  if (!Number.isFinite(line.ts)) return;
  const key = bucketKeyOf(model, line.ts);
  let bucket = model.buckets.get(key);
  if (!bucket) {
    bucket = { count: 0, warns: 0, errors: 0, firstEntry: line.entryIndex };
    model.buckets.set(key, bucket);
  }
  bucket.count += 1;
  bucket.firstEntry = Math.min(bucket.firstEntry, line.entryIndex);
  if (line.level === 'warn') bucket.warns += 1;
  if (line.level === 'error') {
    bucket.errors += 1;
    model.errors += 1;
  }
  model.lines += 1;
  if (key >= model.minKey && key <= model.maxKey) return;
  model.minKey = Math.min(model.minKey, key);
  model.maxKey = Math.max(model.maxKey, key);
  fit(model);
}

/** Bucket a whole set of lines, picking the step from their span first. */
export function buildActivity(lines: Iterable<ActivityLine>): ActivityModel {
  const all = Array.from(lines).filter((line) => Number.isFinite(line.ts));
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const line of all) {
    if (line.ts < min) min = line.ts;
    if (line.ts > max) max = line.ts;
  }
  const model = createActivity(all.length ? pickStep(max - min) : SECOND);
  for (const line of all) addActivityLine(model, line);
  return model;
}

function toneOf(bucket: Bucket | undefined): BarTone {
  if (!bucket || !bucket.count) return 'empty';
  if (bucket.errors) return 'error';
  if (bucket.warns) return 'warn';
  return 'normal';
}

/** One bar per bucket from the first to the last, empty ones included. */
export function activityBars(
  model: ActivityModel,
  maxHeight: number,
): ActivityBar[] {
  if (!model.buckets.size) return [];
  let busiest = 0;
  for (const bucket of model.buckets.values())
    busiest = Math.max(busiest, bucket.count);
  const scale = maxHeight / Math.sqrt(busiest);
  const bars: ActivityBar[] = [];
  for (let key = model.minKey; key <= model.maxKey; key += 1) {
    const bucket = model.buckets.get(key);
    const count = bucket?.count ?? 0;
    bars.push({
      key,
      start: key * model.step,
      count,
      warns: bucket?.warns ?? 0,
      errors: bucket?.errors ?? 0,
      firstEntry: bucket?.firstEntry ?? -1,
      tone: toneOf(bucket),
      height: count
        ? Math.max(MIN_BAR_PX, Math.round(Math.sqrt(count) * scale))
        : 0,
    });
  }
  return bars;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clock(ts: number, withSeconds: boolean): string {
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${hm}:${pad(d.getSeconds())}` : hm;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** «13:44–13:45 · 120 líneas · 2 errores» */
export function barTitle(bar: ActivityBar, step: number): string {
  const withSeconds = step < MINUTE;
  const parts = [
    `${clock(bar.start, withSeconds)}–${clock(bar.start + step, withSeconds)}`,
    plural(bar.count, 'línea', 'líneas'),
  ];
  if (bar.errors) parts.push(plural(bar.errors, 'error', 'errores'));
  if (bar.warns) parts.push(plural(bar.warns, 'aviso', 'avisos'));
  return parts.join(' · ');
}

/** «últimos 35 min»: the stretch of time the bars cover. */
export function spanLabel(model: ActivityModel): string {
  if (!model.buckets.size) return '';
  const covered = (model.maxKey - model.minKey + 1) * model.step;
  if (covered < MINUTE) return `últimos ${Math.round(covered / SECOND)} s`;
  if (covered < HOUR) return `últimos ${Math.round(covered / MINUTE)} min`;
  if (covered < 2 * DAY) return `últimas ${Math.round(covered / HOUR)} h`;
  return `últimos ${Math.round(covered / DAY)} días`;
}

/** The whole strip in one sentence, for a screen reader. */
export function activitySummary(model: ActivityModel): string {
  const base = `Actividad: ${plural(model.lines, 'línea', 'líneas')}, ${spanLabel(model)}`;
  return model.errors
    ? `${base} · ${plural(model.errors, 'error', 'errores')}`
    : base;
}
