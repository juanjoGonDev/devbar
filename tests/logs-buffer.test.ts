import { beforeEach, describe, expect, it } from 'vitest';

import {
  buffer,
  commitSelection,
  entriesToText,
  recomputeVisible,
  replaceEntries,
  selectionAsPositions,
  trimBuffer,
} from '../renderer/logs/buffer.js';
import { fmtTime } from '../renderer/logs/format.js';
import type { LogEntry } from '../src/domain-types.js';
import type { SilenceLevel } from '../src/ipc-contract.js';

const NO_LEVEL: ReadonlySet<SilenceLevel> = new Set();

function line(text: string, level: LogEntry['level'] = null): LogEntry {
  return { ts: 0, stream: 'stdout', level, line: text };
}

function lines(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => line(`línea ${i}`));
}

describe('renderer/logs/buffer.ts', () => {
  beforeEach(() => {
    // The buffer is the window's single copy of what it holds, so every test
    // starts it empty rather than inheriting the previous one's lines.
    replaceEntries([], null, NO_LEVEL);
    buffer.winStart = 0;
    buffer.winEnd = -1;
  });

  describe('recomputeVisible', () => {
    it('lists every line while nothing is filtered', () => {
      buffer.entries = lines(3);
      recomputeVisible(null, NO_LEVEL);
      expect(buffer.visible).toEqual([0, 1, 2]);
    });

    it('keeps the positions of what survives, not a renumbering', () => {
      // `visible` indexes `entries`: a filtered view that renumbered would
      // make every selection and every jump point at the wrong line.
      buffer.entries = [line('uno'), line('dos'), line('uno otra vez')];
      recomputeVisible(/uno/iu, NO_LEVEL);
      expect(buffer.visible).toEqual([0, 2]);
    });

    it('applies the level pin as well as the text box', () => {
      buffer.entries = [line('a', 'warn'), line('b', 'error')];
      recomputeVisible(null, new Set(['error']));
      expect(buffer.visible).toEqual([1]);
    });
  });

  describe('replaceEntries', () => {
    it('adopts the new lines and indexes them', () => {
      replaceEntries(lines(2), null, NO_LEVEL);
      expect(buffer.entries).toHaveLength(2);
      expect(buffer.visible).toEqual([0, 1]);
    });

    it('drops a selection that belonged to the lines being replaced', () => {
      replaceEntries(lines(2), null, NO_LEVEL);
      buffer.selected.add(1);
      buffer.anchorEntry = 1;
      replaceEntries(lines(2), null, NO_LEVEL);
      expect([...buffer.selected]).toEqual([]);
      expect(buffer.anchorEntry).toBeNull();
    });
  });

  describe('trimBuffer', () => {
    it('does nothing while the buffer is inside its cap', () => {
      replaceEntries(lines(5), null, NO_LEVEL);
      expect(trimBuffer(10, null, NO_LEVEL)).toBeNull();
      expect(buffer.entries).toHaveLength(5);
    });

    it('drops the oldest lines down to the cap', () => {
      replaceEntries(lines(10), null, NO_LEVEL);
      trimBuffer(4, null, NO_LEVEL);
      expect(buffer.entries.map((e) => e.line)).toEqual([
        'línea 6',
        'línea 7',
        'línea 8',
        'línea 9',
      ]);
    });

    it('rebases the selection onto the lines that are left', () => {
      replaceEntries(lines(10), null, NO_LEVEL);
      buffer.selected.add(1); // dropped
      buffer.selected.add(8); // survives, as index 2
      buffer.anchorEntry = 8;
      trimBuffer(4, null, NO_LEVEL);
      expect([...buffer.selected]).toEqual([2]);
      expect(buffer.anchorEntry).toBe(2);
    });

    it('forgets an anchor that was dropped rather than moving it', () => {
      replaceEntries(lines(10), null, NO_LEVEL);
      buffer.anchorEntry = 1;
      trimBuffer(4, null, NO_LEVEL);
      expect(buffer.anchorEntry).toBeNull();
    });

    it('reports that the window was following the tail', () => {
      replaceEntries(lines(10), null, NO_LEVEL);
      buffer.winStart = 0;
      buffer.winEnd = 9;
      expect(trimBuffer(4, null, NO_LEVEL)).toEqual({
        droppedVisible: 6,
        wasFollowing: true,
      });
    });

    it('reports how far a window scrolled back has to slide', () => {
      replaceEntries(lines(10), null, NO_LEVEL);
      buffer.winStart = 0;
      buffer.winEnd = 3;
      // Six lines went, all of them visible: the reader's window slides six.
      expect(trimBuffer(4, null, NO_LEVEL)).toEqual({
        droppedVisible: 6,
        wasFollowing: false,
      });
    });

    it('counts only the dropped lines the filter was showing', () => {
      replaceEntries(
        [line('a', 'warn'), line('b'), line('c'), line('d')],
        null,
        new Set(['warn']),
      );
      buffer.winStart = 0;
      buffer.winEnd = 0;
      expect(trimBuffer(2, null, new Set(['warn']))?.droppedVisible).toBe(1);
    });
  });

  describe('selectionAsPositions', () => {
    it('translates entry indices into positions in the filtered view', () => {
      replaceEntries(
        [line('uno'), line('dos'), line('uno bis')],
        /uno/iu,
        NO_LEVEL,
      );
      buffer.selected.add(2);
      buffer.anchorEntry = 2;
      expect(selectionAsPositions()).toEqual({
        selected: new Set([1]),
        anchor: 1,
      });
    });

    it('reports no anchor when none is set', () => {
      replaceEntries(lines(2), null, NO_LEVEL);
      expect(selectionAsPositions().anchor).toBeNull();
    });

    it('reports no anchor when the filter hid the anchored line', () => {
      replaceEntries([line('uno'), line('dos')], /uno/iu, NO_LEVEL);
      buffer.anchorEntry = 1;
      expect(selectionAsPositions().anchor).toBeNull();
    });
  });

  describe('commitSelection', () => {
    it('translates positions back into the entries they stand for', () => {
      replaceEntries(
        [line('uno'), line('dos'), line('uno bis')],
        /uno/iu,
        NO_LEVEL,
      );
      commitSelection({ selected: new Set([0, 1]), anchor: 1 });
      expect([...buffer.selected]).toEqual([0, 2]);
      expect(buffer.anchorEntry).toBe(2);
    });

    it('ignores a position the filtered view no longer has', () => {
      replaceEntries(lines(1), null, NO_LEVEL);
      commitSelection({ selected: new Set([0, 7]), anchor: null });
      expect([...buffer.selected]).toEqual([0]);
      expect(buffer.anchorEntry).toBeNull();
    });
  });

  describe('entriesToText', () => {
    it('copies each line stamped, in the order asked for', () => {
      const stamp = fmtTime(0);
      replaceEntries([line('uno'), line('dos')], null, NO_LEVEL);
      expect(entriesToText([0, 1])).toBe(`${stamp} uno\n${stamp} dos`);
    });

    it('copies the text a reader sees, not its escape codes', () => {
      replaceEntries([line('[31mrojo[0m')], null, NO_LEVEL);
      expect(entriesToText([0])).toBe(`${fmtTime(0)} rojo`);
    });

    it('skips an index the buffer no longer holds', () => {
      replaceEntries([line('uno')], null, NO_LEVEL);
      expect(entriesToText([0, 9])).toBe(`${fmtTime(0)} uno`);
    });
  });
});
