/**
 * «Buscar en el log», worked out without a window: what the query compiles
 * to, where it bites, which match is current and where the ticks go.
 *
 * The match list is keyed by ENTRY index, in buffer order, and holds one
 * record per matching line (not per hit): a query like «a» over 50 000 lines
 * would otherwise mean a million records. `starts` is the running total
 * before each line, so turning «match 812» into a line and a hit is a binary
 * search, and a line that arrives at the tail is one push — never a recount.
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Hide the lines that do not match — what the old search box always did. */
  onlyMatches: boolean;
}

export const DEFAULT_FIND_OPTIONS: Readonly<FindOptions> = Object.freeze({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  onlyMatches: false,
});

/** The toggles as stored; anything missing or of the wrong type is a default. */
export function parseFindOptions(raw: string | null): FindOptions {
  const out: FindOptions = { ...DEFAULT_FIND_OPTIONS };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(out) as Array<keyof FindOptions>) {
    const value = record[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export interface CompiledFind {
  /** Global, so it can walk a line hit by hit; null when there is no query. */
  re: RegExp | null;
  /** Why a regex query does not compile, for the field's tooltip. */
  error: string | null;
}

export function compileFind(query: string, options: FindOptions): CompiledFind {
  if (!query) return { re: null, error: null };
  let source = options.regex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return {
      re: new RegExp(source, options.caseSensitive ? 'g' : 'gi'),
      error: null,
    };
  } catch (err) {
    return {
      re: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Hits counted (and marked) per line. Enough to see where a search bites; a
 * minified 20 KB line full of «a» is not worth a thousand marks.
 */
export const MAX_LINE_HITS = 200;

/** Every non-empty run `re` finds in `text`, up to the per-line cap. */
export function hitRanges(text: string, re: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  while (out.length < MAX_LINE_HITS) {
    const match = re.exec(text);
    if (!match) break;
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out.push([match.index, match.index + match[0].length]);
  }
  re.lastIndex = 0;
  return out;
}

export interface FindMatches {
  /** Entry indices of the lines with at least one hit, ascending. */
  lines: number[];
  /** Hits on each of those lines. */
  counts: number[];
  /** Hits before each of those lines. */
  starts: number[];
  total: number;
}

/** Which hit of which line. */
export interface FindCursor {
  entry: number;
  hit: number;
}

export function emptyMatches(): FindMatches {
  return { lines: [], counts: [], starts: [], total: 0 };
}

/** One line's hits, appended at the end of the list (a line that arrived). */
export function appendMatch(
  matches: FindMatches,
  entry: number,
  count: number,
): void {
  if (count <= 0) return;
  matches.lines.push(entry);
  matches.counts.push(count);
  matches.starts.push(matches.total);
  matches.total += count;
}

/** Count `re` over the lines `indices` names, in order. */
export function buildMatches(
  indices: readonly number[],
  textOf: (entry: number) => string,
  re: RegExp,
): FindMatches {
  const out = emptyMatches();
  for (const entry of indices)
    appendMatch(out, entry, hitRanges(textOf(entry), re).length);
  return out;
}

/** The same matches once the `dropped` oldest entries left the buffer. */
export function rebaseMatches(
  matches: FindMatches,
  dropped: number,
): FindMatches {
  const out = emptyMatches();
  for (let i = 0; i < matches.lines.length; i += 1) {
    const entry = (matches.lines[i] as number) - dropped;
    if (entry >= 0) appendMatch(out, entry, matches.counts[i] as number);
  }
  return out;
}

/** First index in sorted `values` whose value is >= `target`. */
function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((values[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 0-based position of `cursor` among every hit; -1 when it is not one. */
export function ordinalOf(matches: FindMatches, cursor: FindCursor): number {
  const i = lowerBound(matches.lines, cursor.entry);
  if (matches.lines[i] !== cursor.entry) return -1;
  if (cursor.hit < 0 || cursor.hit >= (matches.counts[i] as number)) return -1;
  return (matches.starts[i] as number) + cursor.hit;
}

export function cursorAt(
  matches: FindMatches,
  ordinal: number,
): FindCursor | null {
  if (ordinal < 0 || ordinal >= matches.total) return null;
  // The last line whose first hit is at or before the ordinal.
  const i = lowerBound(matches.starts, ordinal + 1) - 1;
  return {
    entry: matches.lines[i] as number,
    hit: ordinal - (matches.starts[i] as number),
  };
}

/** The next (or previous) hit, wrapping around; the first (or last) from none. */
export function stepCursor(
  matches: FindMatches,
  cursor: FindCursor | null,
  direction: 1 | -1,
): FindCursor | null {
  if (!matches.total) return null;
  const at = cursor ? ordinalOf(matches, cursor) : -1;
  if (at < 0) return cursorAt(matches, direction === 1 ? 0 : matches.total - 1);
  return cursorAt(matches, (at + direction + matches.total) % matches.total);
}

/** The first hit on or after `entry`; the last hit when none is. */
export function nearestCursor(
  matches: FindMatches,
  entry: number,
): FindCursor | null {
  if (!matches.total) return null;
  const i = lowerBound(matches.lines, entry);
  if (i < matches.lines.length)
    return { entry: matches.lines[i] as number, hit: 0 };
  return cursorAt(matches, matches.total - 1);
}

/** «3 de 27», «Sin resultados», or nothing while the box is empty. */
export function counterLabel(
  matches: FindMatches,
  cursor: FindCursor | null,
  searching: boolean,
): string {
  if (!searching) return '';
  if (!matches.total) return 'Sin resultados';
  const at = cursor ? ordinalOf(matches, cursor) : -1;
  return at < 0 ? String(matches.total) : `${at + 1} de ${matches.total}`;
}

export interface Tick {
  /** Where the line sits in the visible list, 0 (top) to 1 (bottom). */
  fraction: number;
  /** What pressing the tick jumps to: the first hit of its first line. */
  cursor: FindCursor;
  current: boolean;
}

/**
 * One tick per matching line, merged into `buckets` slots so a query that
 * matches every line draws a few hundred marks, not fifty thousand.
 * `visible` is the pane's visible list: a tick's place is the line's place in
 * what is drawn, not in what is held.
 */
export function tickMarks(
  matches: FindMatches,
  visible: readonly number[],
  cursor: FindCursor | null,
  buckets: number,
): Tick[] {
  const out: Tick[] = [];
  if (!visible.length) return out;
  let lastBucket = -1;
  for (const entry of matches.lines) {
    const pos = lowerBound(visible, entry);
    if (visible[pos] !== entry) continue;
    const fraction = (pos + 0.5) / visible.length;
    const bucket = Math.floor(fraction * buckets);
    const current = cursor?.entry === entry;
    if (bucket === lastBucket) {
      const last = out[out.length - 1] as Tick;
      if (current) last.current = true;
      continue;
    }
    lastBucket = bucket;
    out.push({ fraction, cursor: { entry, hit: 0 }, current });
  }
  return out;
}
