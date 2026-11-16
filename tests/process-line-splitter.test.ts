import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createLineSplitter, readLines } from '../src/process/line-splitter.js';

/**
 * How a child's output becomes lines. A terminal draws `\r` as "back to the
 * start of this line", so a progress bar that rewrites itself with it is ONE
 * line that updates — not one line per refresh, which is what readline made
 * of it. Every emission says whether it rewrites the previous one.
 */
type Emitted = [line: string, overwrite: boolean];

function split(...chunks: string[]): Emitted[] {
  const out: Emitted[] = [];
  const splitter = createLineSplitter((line, overwrite) => {
    out.push([line, overwrite]);
  });
  for (const chunk of chunks) splitter.write(chunk);
  splitter.end();
  return out;
}

describe('src/process/line-splitter.ts', () => {
  describe('ordinary line endings', () => {
    it('splits on \\n, every line a new one', () => {
      expect(split('one\ntwo\n')).toEqual([
        ['one', false],
        ['two', false],
      ]);
    });

    it('reads \\r\\n in one chunk as a plain line end, not a rewrite', () => {
      // Windows output: turning every line into an overwrite would collapse
      // a whole log into its last line.
      expect(split('one\r\ntwo\r\n')).toEqual([
        ['one', false],
        ['two', false],
      ]);
    });

    it('reads \\r\\n split across two chunks as a plain line end too', () => {
      expect(split('one\r', '\ntwo\r\n')).toEqual([
        ['one', false],
        ['two', false],
      ]);
    });

    it('keeps a blank line a blank line', () => {
      expect(split('one\n\ntwo\n')).toEqual([
        ['one', false],
        ['', false],
        ['two', false],
      ]);
    });
  });

  describe('a carriage return that rewrites the line', () => {
    it('emits a chunk ending in \\r at once, and rewrites it with the next', () => {
      expect(split('10%\r', '50%\r', '100%\r', 'done\n')).toEqual([
        ['10%', false],
        ['50%', true],
        ['100%', true],
        ['done', true],
      ]);
    });

    it('drops a segment the same chunk rewrites before anyone could see it', () => {
      expect(split('10%\r50%\r100%\n')).toEqual([['100%', false]]);
    });

    it('keeps rewriting the line a previous chunk left open', () => {
      expect(split('10%\r', '50%\r100%\n')).toEqual([
        ['10%', false],
        ['100%', true],
      ]);
    });

    it('shows a leading-\\r progress bar one step behind, as one line', () => {
      // curl/wget style: the `\r` comes first and the text after it stays
      // unterminated until the next refresh.
      expect(split('\r10%', '\r50%', '\r100%', '\n')).toEqual([
        ['10%', false],
        ['50%', true],
        ['100%', true],
      ]);
    });

    it('treats a run of carriage returns as one', () => {
      // `\r\r\n` (a doubled CR some Windows tools print) still ends the line.
      expect(split('one\r\r\ntwo\r', '\r', '\r\nthree\n')).toEqual([
        ['one', false],
        ['two', false],
        ['three', false],
      ]);
    });

    it('starts a fresh line after the rewritten one ends with \\n', () => {
      expect(split('50%\r', '100%\n', 'next\n')).toEqual([
        ['50%', false],
        ['100%', true],
        ['next', false],
      ]);
    });
  });

  describe('text with no line end yet', () => {
    it('holds it until its line ends', () => {
      const out: Emitted[] = [];
      const splitter = createLineSplitter((line, overwrite) => {
        out.push([line, overwrite]);
      });
      splitter.write('partial');
      expect(out).toEqual([]);
      splitter.write(' line\n');
      expect(out).toEqual([['partial line', false]]);
    });

    it('flushes it when the stream ends', () => {
      expect(split('last words')).toEqual([['last words', false]]);
    });

    it('flushes it as a rewrite when the line before it was left open', () => {
      expect(split('50%\r', '100%')).toEqual([
        ['50%', false],
        ['100%', true],
      ]);
    });

    it('flushes nothing when nothing is held', () => {
      expect(split('one\n')).toEqual([['one', false]]);
    });
  });

  describe('readLines', () => {
    it('decodes a multibyte character split across two chunks', async () => {
      const input = new PassThrough();
      const out: Emitted[] = [];
      readLines(input, (line, overwrite) => out.push([line, overwrite]));
      const bytes = Buffer.from('año ✓\n', 'utf8');
      // Cut inside «ñ» (two bytes) and inside «✓» (three bytes).
      input.write(bytes.subarray(0, 2));
      input.write(bytes.subarray(2, 6));
      input.write(bytes.subarray(6));
      input.end();
      await new Promise((resolve) => input.once('end', resolve));
      expect(out).toEqual([['año ✓', false]]);
    });

    it('flushes the unterminated tail when the stream ends', async () => {
      const input = new PassThrough();
      const out: Emitted[] = [];
      readLines(input, (line, overwrite) => out.push([line, overwrite]));
      input.end('42%\rdone');
      await new Promise((resolve) => input.once('end', resolve));
      expect(out).toEqual([
        ['42%', false],
        ['done', true],
      ]);
    });
  });
});
