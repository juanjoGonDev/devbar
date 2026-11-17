import type { Readable } from 'node:stream';

/**
 * A child's output, cut into lines the way a terminal draws them.
 *
 * readline ends a line at a lone `\r`, so a progress bar that redraws itself
 * with one (`aws s3 cp`, curl, any upload) became a new line per refresh —
 * hundreds of them. A terminal reads `\r` as "back to the start of this
 * line": the next text rewrites it. So every line comes out with `overwrite`,
 * true when it rewrites the previous one rather than starting a new one.
 *
 * - `\n`, and `\r\n` even split across two chunks, end a line as usual —
 *   Windows output must not collapse into its last line.
 * - A chunk ending in `\r` is shown right away (the bar is live) and left
 *   open: whatever comes next rewrites it, unless it is the `\n` of a `\r\n`.
 * - A segment the same chunk rewrites before its end is dropped: nobody could
 *   have seen it. The last one before an unterminated tail is kept — that is
 *   the bar that prints its `\r` first, and its text is all there is to show.
 * - A run of `\r` counts as one; text with no line end yet waits for one, or
 *   for the stream to end.
 *
 * ponytail: only `\r` rewrites. ANSI cursor movement (`ESC[1A`, `ESC[2K`…),
 * what multi-line progress UIs draw with, still appends a line per redraw.
 */
export type LineSink = (line: string, overwrite: boolean) => void;

export interface LineSplitter {
  write(chunk: string): void;
  /** The stream ended: flush the unterminated tail, if any. */
  end(): void;
}

const LINE_END = /\r+\n?|\n/g;

export function createLineSplitter(emit: LineSink): LineSplitter {
  let buffer = '';
  /** The last line emitted ended in a lone `\r`: the next one rewrites it. */
  let open = false;
  /** The last chunk ended in `\r`: `\r\n` or a rewrite, the next one says. */
  let pendingCR = false;

  function line(text: string, leaveOpen: boolean): void {
    emit(text, open);
    open = leaveOpen;
  }

  return {
    write(chunk) {
      let text = chunk;
      if (pendingCR) {
        text = text.replace(/^\r+/, '');
        if (text === '') return; // still the same run of carriage returns
        pendingCR = false;
        if (text.startsWith('\n')) {
          open = false; // it was a `\r\n`: the line already shown stays
          text = text.slice(1);
        }
      }
      // The held text never contains a line end (each one is consumed
      // below), so only the new text is searched: rescanning a long
      // unfinished line on every chunk made one huge line cost quadratic time.
      const lastBreak = Math.max(
        text.lastIndexOf('\n'),
        text.lastIndexOf('\r'),
      );
      let start = 0;
      for (const match of text.matchAll(LINE_END)) {
        const segment = buffer + text.slice(start, match.index);
        buffer = '';
        const end = match.index + match[0].length;
        start = end;
        if (match[0].endsWith('\n')) line(segment, false);
        else if (end === text.length) {
          line(segment, true);
          pendingCR = true;
        } else if (segment !== '' && end > lastBreak) line(segment, true);
        // Otherwise rewritten within this very chunk: never on screen.
      }
      buffer += text.slice(start);
    },
    end() {
      if (buffer !== '') line(buffer, false);
      buffer = '';
    },
  };
}

/** Feed a child's stdout or stderr through a splitter, UTF-8 safe. */
export function readLines(input: Readable, emit: LineSink): void {
  const splitter = createLineSplitter(emit);
  // Decodes across chunk boundaries: a character cut in two is held back
  // until its last byte arrives instead of turning into two U+FFFD.
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => splitter.write(chunk));
  input.on('end', () => splitter.end());
}
