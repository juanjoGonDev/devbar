import { describe, expect, it } from 'vitest';
import { replacedIndex } from '../src/log-replace.js';

/**
 * Finding the line a carriage return rewrote, in a list that mirrors a log
 * buffer (a window's buffer, a phone's tail, a workflow run's script log).
 */
interface Line {
  seq?: number;
  src?: string;
}

describe('src/log-replace.ts', () => {
  describe('replacedIndex', () => {
    it('finds the entry the rewrite replaces', () => {
      const list: Line[] = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
      expect(replacedIndex(list, 3)).toBe(2);
      expect(replacedIndex(list, 2)).toBe(1);
    });

    it('matches any link of a redraw chain below the upper end it is given', () => {
      // A held redraw that took over its chain (2 → 3 → 4) replaces whichever
      // link the list still holds.
      const list: Line[] = [{ seq: 1 }, { seq: 3 }];
      expect(replacedIndex(list, 2, undefined, 5)).toBe(1);
      expect(replacedIndex([{ seq: 1 }], 2, undefined, 5)).toBe(-1);
    });

    it('answers -1 for a line that rewrites nothing', () => {
      expect(replacedIndex([{ seq: 1 }], undefined)).toBe(-1);
    });

    it('answers -1 when the list no longer holds that entry', () => {
      // Trimmed away, or never delivered: the caller appends it instead.
      expect(replacedIndex([{ seq: 5 }, { seq: 6 }], 4)).toBe(-1);
      expect(replacedIndex([], 4)).toBe(-1);
    });

    it('skips entries with no position of their own', () => {
      expect(replacedIndex([{ seq: 7 }, {}], 7)).toBe(0);
    });

    it('never matches another source’s line that shares the number', () => {
      // A merged view: every service counts its own lines from 1.
      const list: Line[] = [
        { seq: 3, src: 'api' },
        { seq: 3, src: 'web' },
      ];
      expect(replacedIndex(list, 3, (line) => line.src === 'api')).toBe(0);
      expect(replacedIndex(list, 3, (line) => line.src === 'db')).toBe(-1);
    });
  });
});
