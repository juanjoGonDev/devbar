import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FIND_OPTIONS,
  MAX_LINE_HITS,
  appendMatch,
  buildMatches,
  compileFind,
  counterLabel,
  cursorAt,
  emptyMatches,
  hitRanges,
  nearestCursor,
  ordinalOf,
  parseFindOptions,
  rebaseMatches,
  stepCursor,
  tickMarks,
  type FindMatches,
  type FindOptions,
} from '../renderer/logs/find-model.js';

const PLAIN: FindOptions = DEFAULT_FIND_OPTIONS;

function opts(extra: Partial<FindOptions>): FindOptions {
  return { ...PLAIN, ...extra };
}

/** Matches over `lines`, keyed by their position — the way the pane keys them. */
function matchesOver(lines: readonly string[], query: string): FindMatches {
  const { re } = compileFind(query, PLAIN);
  if (!re) return emptyMatches();
  return buildMatches(
    lines.map((_, i) => i),
    (i) => lines[i] ?? '',
    re,
  );
}

describe('renderer/logs/find-model.ts', () => {
  describe('compileFind', () => {
    it('finds nothing for an empty query', () => {
      expect(compileFind('', PLAIN)).toEqual({ re: null, error: null });
    });

    it('treats the query as literal text unless the regex toggle is on', () => {
      const { re } = compileFind('a.b', PLAIN);
      expect(hitRanges('axb a.b', re as RegExp)).toEqual([[4, 7]]);
    });

    it('ignores case unless told otherwise', () => {
      const loose = compileFind('error', PLAIN).re as RegExp;
      const strict = compileFind('error', opts({ caseSensitive: true }))
        .re as RegExp;
      expect(hitRanges('Error error', loose)).toHaveLength(2);
      expect(hitRanges('Error error', strict)).toEqual([[6, 11]]);
    });

    it('only matches whole words when asked to', () => {
      const re = compileFind('log', opts({ wholeWord: true })).re as RegExp;
      expect(hitRanges('logger log blog', re)).toEqual([[7, 10]]);
    });

    it('compiles a regex when the regex toggle is on', () => {
      const re = compileFind('\\d+ms', opts({ regex: true })).re as RegExp;
      expect(hitRanges('took 12ms then 4ms', re)).toEqual([
        [5, 9],
        [15, 18],
      ]);
    });

    it('reports an invalid regex instead of matching anything', () => {
      const compiled = compileFind('a(', opts({ regex: true }));
      expect(compiled.re).toBeNull();
      expect(compiled.error).toMatch(/./);
    });
  });

  describe('hitRanges', () => {
    it('skips empty matches instead of looping on them', () => {
      const re = compileFind('x*', opts({ regex: true })).re as RegExp;
      expect(hitRanges('axxb', re)).toEqual([[1, 3]]);
    });

    it('stops at a per-line cap so a pathological line stays cheap', () => {
      const re = compileFind('a', PLAIN).re as RegExp;
      expect(hitRanges('a'.repeat(MAX_LINE_HITS + 50), re)).toHaveLength(
        MAX_LINE_HITS,
      );
    });
  });

  describe('the match list', () => {
    it('counts every hit of every line', () => {
      const m = matchesOver(['a a', 'b', 'a'], 'a');
      expect(m.total).toBe(3);
      expect(m.lines).toEqual([0, 2]);
    });

    it('grows one line at a time without recounting', () => {
      const m = matchesOver(['a'], 'a');
      appendMatch(m, 5, 2);
      appendMatch(m, 6, 0);
      expect(m.total).toBe(3);
      expect(m.lines).toEqual([0, 5]);
      expect(cursorAt(m, 2)).toEqual({ entry: 5, hit: 1 });
    });

    it('rebases onto the buffer once its oldest lines are dropped', () => {
      const m = matchesOver(['a', 'b', 'a a', 'a'], 'a');
      const next = rebaseMatches(m, 2);
      expect(next.lines).toEqual([0, 1]);
      expect(next.total).toBe(3);
      expect(cursorAt(next, 2)).toEqual({ entry: 1, hit: 0 });
    });
  });

  describe('the cursor', () => {
    const m = (): FindMatches => matchesOver(['a', 'x', 'a a', 'a'], 'a');

    it('turns an ordinal into a line and a hit, and back', () => {
      expect(cursorAt(m(), 2)).toEqual({ entry: 2, hit: 1 });
      expect(ordinalOf(m(), { entry: 2, hit: 1 })).toBe(2);
      expect(ordinalOf(m(), { entry: 1, hit: 0 })).toBe(-1);
      expect(cursorAt(m(), 9)).toBeNull();
    });

    it('steps forward and back, wrapping at both ends', () => {
      expect(stepCursor(m(), { entry: 0, hit: 0 }, 1)).toEqual({
        entry: 2,
        hit: 0,
      });
      expect(stepCursor(m(), { entry: 3, hit: 0 }, 1)).toEqual({
        entry: 0,
        hit: 0,
      });
      expect(stepCursor(m(), { entry: 0, hit: 0 }, -1)).toEqual({
        entry: 3,
        hit: 0,
      });
    });

    it('starts from the first match when there is no cursor yet', () => {
      expect(stepCursor(m(), null, 1)).toEqual({ entry: 0, hit: 0 });
      expect(stepCursor(m(), null, -1)).toEqual({ entry: 3, hit: 0 });
      expect(stepCursor(emptyMatches(), null, 1)).toBeNull();
    });

    it('lands on the first match at or after a line, else the last one', () => {
      expect(nearestCursor(m(), 1)).toEqual({ entry: 2, hit: 0 });
      expect(nearestCursor(m(), 9)).toEqual({ entry: 3, hit: 0 });
      expect(nearestCursor(emptyMatches(), 0)).toBeNull();
    });
  });

  describe('counterLabel', () => {
    it('says nothing while nothing is searched for', () => {
      expect(counterLabel(emptyMatches(), null, false)).toBe('');
    });

    it('says «Sin resultados» when nothing matches', () => {
      expect(counterLabel(emptyMatches(), null, true)).toBe('Sin resultados');
    });

    it('says which match of how many is current', () => {
      const m = matchesOver(['a', 'a a'], 'a');
      expect(counterLabel(m, { entry: 1, hit: 0 }, true)).toBe('2 de 3');
    });
  });

  describe('tickMarks', () => {
    it('puts a tick where each matching line sits in the visible list', () => {
      const m = matchesOver(['a', 'x', 'x', 'a'], 'a');
      const ticks = tickMarks(m, [0, 1, 2, 3], { entry: 3, hit: 0 }, 100);
      expect(ticks.map((t) => t.fraction)).toEqual([0.125, 0.875]);
      expect(ticks.map((t) => t.current)).toEqual([false, true]);
      expect(ticks[1]?.cursor).toEqual({ entry: 3, hit: 0 });
    });

    it('merges ticks that would land on the same spot', () => {
      const lines = Array.from({ length: 1000 }, () => 'a');
      const m = matchesOver(lines, 'a');
      const visible = lines.map((_, i) => i);
      expect(tickMarks(m, visible, null, 50)).toHaveLength(50);
    });
  });

  describe('parseFindOptions', () => {
    it('falls back to the defaults for anything unreadable', () => {
      expect(parseFindOptions(null)).toEqual(DEFAULT_FIND_OPTIONS);
      expect(parseFindOptions('{nope')).toEqual(DEFAULT_FIND_OPTIONS);
    });

    it('keeps the toggles it recognises and ignores the rest', () => {
      expect(
        parseFindOptions('{"regex":true,"onlyMatches":"yes","query":"x"}'),
      ).toEqual({ ...DEFAULT_FIND_OPTIONS, regex: true });
    });
  });
});
