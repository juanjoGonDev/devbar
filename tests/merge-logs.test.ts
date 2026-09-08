import { describe, expect, it } from 'vitest';
import { mergeNewestByTs, type SourceBuffer } from '../src/merge-logs.js';
import type { LogEntry } from '../src/domain-types.js';

function entry(ts: number, line = `l${ts}`): LogEntry {
  return { ts, stream: 'stdout', level: null, line };
}

function buffer(srcId: string, timestamps: number[]): SourceBuffer {
  return { srcId, entries: timestamps.map((ts) => entry(ts)) };
}

describe('mergeNewestByTs', () => {
  it('interleaves sources in chronological order', () => {
    const merged = mergeNewestByTs(
      [buffer('a', [1, 3, 5]), buffer('b', [2, 4, 6])],
      10,
    );
    expect(merged.map((e) => e.ts)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged.map((e) => e.srcId)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('keeps the NEWEST entries when the limit bites, oldest-first', () => {
    const merged = mergeNewestByTs(
      [buffer('a', [1, 3, 5]), buffer('b', [2, 4, 6])],
      3,
    );
    expect(merged.map((e) => e.ts)).toEqual([4, 5, 6]);
  });

  it('tags every entry with the source it came from', () => {
    const merged = mergeNewestByTs([buffer('only', [7])], 10);
    expect(merged).toEqual([{ ...entry(7), srcId: 'only' }]);
  });

  it('does not mutate the buffers it reads', () => {
    const a = buffer('a', [1, 2, 3]);
    mergeNewestByTs([a], 2);
    expect(a.entries.map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  it('handles empty and exhausted buffers', () => {
    expect(mergeNewestByTs([], 10)).toEqual([]);
    expect(mergeNewestByTs([buffer('a', [])], 10)).toEqual([]);
    const merged = mergeNewestByTs([buffer('a', []), buffer('b', [1])], 10);
    expect(merged.map((e) => e.ts)).toEqual([1]);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(mergeNewestByTs([buffer('a', [1, 2])], 0)).toEqual([]);
    expect(mergeNewestByTs([buffer('a', [1, 2])], -5)).toEqual([]);
  });

  it('clones at most `limit` entries, whatever the buffers hold', () => {
    // The point of the merge: cost follows the limit, not the retained total.
    // 5 sources × 4000 entries would be 20 000 clones and a sort of the same
    // under concatenate-then-sort.
    const many = Array.from({ length: 5 }, (_, s) =>
      buffer(
        `s${s}`,
        Array.from({ length: 4000 }, (_, i) => i * 5 + s),
      ),
    );
    const merged = mergeNewestByTs(many, 100);
    expect(merged).toHaveLength(100);
    // Still globally ordered, and genuinely the newest slice.
    const timestamps = merged.map((e) => e.ts);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
    expect(Math.max(...timestamps)).toBe(3999 * 5 + 4);
  });

  it('survives ties on the timestamp without dropping entries', () => {
    const merged = mergeNewestByTs(
      [buffer('a', [1, 1, 1]), buffer('b', [1, 1])],
      10,
    );
    expect(merged).toHaveLength(5);
  });
});
