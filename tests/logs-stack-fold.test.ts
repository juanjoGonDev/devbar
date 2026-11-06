import { describe, expect, it } from 'vitest';

import {
  MIN_FOLD,
  groupStacks,
  indexStackEntry,
  indexStacks,
  isFolded,
  isStackLine,
  stackOf,
  toggleStack,
} from '../renderer/logs/stack-fold.js';
import type { LogEntry } from '../src/domain-types.js';
import type { SourcedLogEntry } from '../src/ipc-contract.js';

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: text, ...extra };
}

/** `groupStacks` over plain texts, the first one flagged as an error. */
function runs(texts: string[], errorAt: number[] = []): number[][] {
  return groupStacks(
    texts.map((text, i) => ({ text, error: errorAt.includes(i) })),
  ).map((run) => [run.head, run.start, run.end]);
}

describe('renderer/logs/stack-fold.ts', () => {
  describe('isStackLine', () => {
    it.each([
      '    at Server.listen (node:net:1:2)',
      '\tat com.acme.Main.run(Main.java:12)',
      '  File "app.py", line 3, in <module>',
      '\t... 12 more',
      '\u001b[90m    at emit (node:events:5:1)\u001b[0m',
    ])('takes a stack frame %j wherever it appears', (text) => {
      expect(isStackLine(text, false, false)).toBe(true);
    });

    it('takes an indented line only while a stack is open', () => {
      expect(isStackLine('    return foo()', true, false)).toBe(true);
      expect(isStackLine('    return foo()', false, false)).toBe(false);
    });

    it('takes a caret or blank line right after an error, or inside a stack', () => {
      expect(isStackLine('    ^', false, true)).toBe(true);
      expect(isStackLine('', false, true)).toBe(true);
      expect(isStackLine('', true, false)).toBe(true);
      expect(isStackLine('', false, false)).toBe(false);
    });

    it('never takes an unindented message', () => {
      expect(isStackLine('ValueError: bad', true, false)).toBe(false);
      expect(isStackLine('attaching debugger', true, true)).toBe(false);
    });
  });

  describe('groupStacks', () => {
    it('groups the frames under the line they follow', () => {
      expect(
        runs(
          [
            'Error: socket hang up',
            '    at a (x:1)',
            '    at b (x:2)',
            'next line',
          ],
          [0],
        ),
      ).toEqual([[0, 1, 2]]);
    });

    it('keeps a Python traceback together, code lines included', () => {
      expect(
        runs([
          'Traceback (most recent call last):',
          '  File "app.py", line 3, in <module>',
          '    main()',
          '  File "app.py", line 1, in main',
          'ValueError: bad',
        ]),
      ).toEqual([[0, 1, 3]]);
    });

    it('starts a new run after a Java «Caused by»', () => {
      expect(
        runs([
          'java.lang.IllegalStateException: boom',
          '\tat a.B.c(B.java:1)',
          '\tat a.B.d(B.java:2)',
          'Caused by: java.io.IOException',
          '\tat a.C.e(C.java:3)',
          '\t... 2 more',
        ]),
      ).toEqual([
        [0, 1, 2],
        [3, 4, 5],
      ]);
    });

    it('hangs frames cut off from their message (a trimmed buffer) under the first', () => {
      expect(
        runs(['    at a (x:1)', '    at b (x:2)', '    at c (x:3)']),
      ).toEqual([[0, 1, 2]]);
    });

    it('leaves plain output alone', () => {
      expect(runs(['one', '  indented but no stack', 'two'])).toEqual([]);
    });
  });

  describe('the entry index', () => {
    const trace = (): LogEntry[] => [
      line('Error: boom', { level: 'error' }),
      line('    at a (x:1)'),
      line('    at b (x:2)'),
      line('    at c (x:3)'),
      line('done'),
    ];

    it('maps every frame to its block, and the block to its head', () => {
      const entries = trace();
      indexStacks(entries);
      const block = stackOf(entries[1]);
      expect(block?.head).toBe(entries[0]);
      expect(block?.members).toEqual(entries.slice(1, 4));
      expect(stackOf(entries[3])).toBe(block);
      expect(stackOf(entries[0])).toBeUndefined();
      expect(stackOf(entries[4])).toBeUndefined();
    });

    it('grows a block one arriving line at a time, as indexStacks would', () => {
      const entries = trace();
      for (let i = 0; i < entries.length; i += 1)
        indexStackEntry(entries[i - 1], entries[i]);
      expect(stackOf(entries[2])?.members).toHaveLength(3);
    });

    it('does not stitch lines from two different services together', () => {
      const head: SourcedLogEntry = { ...line('Error: boom'), srcId: 'a' };
      const frame: SourcedLogEntry = { ...line('    at a (x:1)'), srcId: 'b' };
      indexStacks([head, frame]);
      expect(stackOf(frame)).toBeUndefined();
    });

    it('folds a block of MIN_FOLD lines or more until it is toggled open', () => {
      const entries = trace();
      indexStacks(entries);
      const block = stackOf(entries[1]);
      if (!block) throw new Error('no block');
      expect(MIN_FOLD).toBeLessThanOrEqual(3);
      expect(isFolded(block)).toBe(true);
      toggleStack(block);
      expect(isFolded(block)).toBe(false);
    });

    it('remembers a block was opened across a rebuild of the index', () => {
      const entries = trace();
      indexStacks(entries);
      const before = stackOf(entries[1]);
      if (!before) throw new Error('no block');
      toggleStack(before);
      indexStacks(entries);
      const after = stackOf(entries[1]);
      expect(after && isFolded(after)).toBe(false);
    });

    it('never folds a lone frame', () => {
      const entries = [line('Error: x'), line('    at a (x:1)'), line('ok')];
      indexStacks(entries);
      const block = stackOf(entries[1]);
      expect(block && isFolded(block)).toBe(false);
    });
  });
});
