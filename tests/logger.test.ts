import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

import {
  attachMainConsole,
  attachWindowConsole,
  init,
  readTail,
} from '../src/logger.js';

const LEVELS = ['log', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const tempDirs: string[] = [];
const savedConsole = new Map<Level, (...args: unknown[]) => void>();

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-logger-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * The logger writes through a `WriteStream`, so the bytes reach the file a
 * tick or two after the call returns. Polling for a marker is what makes the
 * assertions deterministic: writes on one stream are ordered, so once the
 * marker is on disk every earlier line already is too — which is also what
 * lets a test assert that a line is ABSENT.
 */
async function readLogUntil(file: string, marker: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.includes(marker)) return text;
    if (Date.now() > deadline)
      throw new Error(
        `log never contained ${JSON.stringify(marker)}; got:\n${text}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Silences the real console so `attachMainConsole` wraps a no-op. */
function muteConsole(): void {
  for (const level of LEVELS) {
    savedConsole.set(level, console[level].bind(console));
    console[level] = () => undefined;
  }
}

describe('readTail', () => {
  it('returns the whole file when it fits the window', () => {
    const file = path.join(tempDir(), 'app.log');
    fs.writeFileSync(file, 'line one\nline two\n');
    expect(readTail(file, 1024)).toBe('line one\nline two\n');
  });

  it('reads one bounded window and drops the torn first line', () => {
    const file = path.join(tempDir(), 'app.log');
    fs.writeFileSync(file, `${'A'.repeat(300)}\nultima linea\n`);
    // The window starts inside the A-run: the partial entry must not show.
    expect(readTail(file, 64)).toBe('ultima linea\n');
  });

  it('answers empty for a missing file', () => {
    expect(readTail(path.join(tempDir(), 'nope.log'), 1024)).toBe('');
  });
});

describe('src/logger.ts', () => {
  beforeEach(() => {
    muteConsole();
  });

  afterEach(() => {
    // attachMainConsole replaces console[level] in place and never restores
    // it; without this every later test would inherit a stack of wrappers
    // all writing to dead streams.
    for (const level of LEVELS) {
      const original = savedConsole.get(level);
      if (original) console[level] = original;
    }
    savedConsole.clear();
    vi.restoreAllMocks();
    for (const dir of tempDirs)
      fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  describe('init', () => {
    it('creates the log directory and announces the session and its cap', async () => {
      const file = path.join(tempDir(), 'nested', 'deeper', 'app.log');

      init({ filePath: file, maxBytes: 1234 });

      const text = await readLogUntil(file, 'Log session started');
      expect(text).toContain(`Log session started → ${file} (cap 1234 bytes)`);
      expect(text).toContain('[info ] [logger]');
    });

    it('rejects a call with no file path', () => {
      expect(() => init({ filePath: '' })).toThrow(
        'logger.init requires { filePath }',
      );
    });

    it.each([
      ['zero', 0],
      ['negative', -10],
      ['not finite', Number.NaN],
    ])('falls back to the 5 MiB default for a %s cap', async (_label, cap) => {
      const file = path.join(tempDir(), 'app.log');

      init({ filePath: file, maxBytes: cap });

      const text = await readLogUntil(file, 'Log session started');
      expect(text).toContain(`(cap ${5 * 1024 * 1024} bytes)`);
    });

    it('truncates whatever the previous session left behind', async () => {
      const file = path.join(tempDir(), 'app.log');
      fs.writeFileSync(file, 'STALE FROM AN EARLIER RUN\n');

      init({ filePath: file });

      const text = await readLogUntil(file, 'Log session started');
      expect(text).not.toContain('STALE FROM AN EARLIER RUN');
    });

    it('stays silent instead of throwing when the log file cannot be opened', async () => {
      const blocker = path.join(tempDir(), 'not-a-directory');
      fs.writeFileSync(blocker, 'x');
      const file = path.join(blocker, 'app.log');
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      expect(() => init({ filePath: file })).not.toThrow();

      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('[logger] init failed:'),
      );
      // And nothing that happens afterwards may resurrect the dead stream.
      attachMainConsole();
      console.log('after a failed init');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe('attachMainConsole', () => {
    it.each([
      ['log', 'log  '],
      ['info', 'info '],
      ['warn', 'warn '],
      ['error', 'error'],
    ] as const)(
      'records a console.%s call as main output',
      async (level, label) => {
        const file = path.join(tempDir(), 'app.log');
        init({ filePath: file });
        attachMainConsole();

        console[level]('hello', 'world');

        const text = await readLogUntil(file, 'hello world');
        expect(text).toContain(`[${label}] [main] hello world`);
      },
    );

    it('still calls the console method it replaced', async () => {
      const file = path.join(tempDir(), 'app.log');
      const seen: unknown[][] = [];
      console.info = (...args: unknown[]) => void seen.push(args);
      init({ filePath: file });
      attachMainConsole();

      console.info('passed through', 42);

      expect(seen).toEqual([['passed through', 42]]);
      await readLogUntil(file, 'passed through 42');
    });

    it('still logs when the console method it replaced throws', async () => {
      const file = path.join(tempDir(), 'app.log');
      console.warn = () => {
        throw new Error('a broken console');
      };
      init({ filePath: file });
      attachMainConsole();

      expect(() => console.warn('survives')).not.toThrow();

      const text = await readLogUntil(file, 'survives');
      expect(text).toContain('[warn ] [main] survives');
    });

    it.each([
      ['a string', 'plain', 'plain'],
      ['a number', 7, '7'],
      ['a boolean', false, 'false'],
      ['a bigint', 10n, '10'],
      ['null', null, 'null'],
      ['undefined', undefined, 'undefined'],
      ['an object', { a: 1 }, '{"a":1}'],
    ])('formats %s argument', async (_label, value, expected) => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      attachMainConsole();

      console.log('marker', value);

      const text = await readLogUntil(file, 'marker');
      expect(text).toContain(`[main] marker ${expected}`);
    });

    it('formats an Error with its name, message and stack', async () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      attachMainConsole();
      const error = new TypeError('boom');

      console.error(error);

      const text = await readLogUntil(file, 'boom');
      expect(text).toContain('TypeError: boom');
      expect(text).toContain(error.stack ?? 'no stack');
    });

    it('does not let an unserializable argument kill the line', async () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      attachMainConsole();
      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;

      console.log('marker', circular);

      const text = await readLogUntil(file, 'marker');
      expect(text).toContain('[main] marker [unserializable]');
    });
  });

  describe('the byte cap', () => {
    it('drops entries past the cap and says so exactly once', async () => {
      const file = path.join(tempDir(), 'app.log');
      // The session header alone is already over this cap, so the very next
      // entry is the one that trips it.
      init({ filePath: file, maxBytes: 10 });
      attachMainConsole();

      console.log('DROPPED-ONE');
      console.log('DROPPED-TWO');

      const text = await readLogUntil(file, 'Cap reached');
      expect(text).not.toContain('DROPPED-ONE');
      expect(text).not.toContain('DROPPED-TWO');
      expect(text.match(/Cap reached/g)).toHaveLength(1);
      expect(text).toContain('Cap reached (10 bytes)');
    });

    it('keeps writing while there is budget left', async () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file, maxBytes: 5_000 });
      attachMainConsole();

      console.log('UNDER-THE-CAP');

      const text = await readLogUntil(file, 'UNDER-THE-CAP');
      expect(text).not.toContain('Cap reached');
    });
  });

  describe('attachWindowConsole', () => {
    function fakeWindow(): {
      win: BrowserWindow;
      emit: (level: string, message: string, source?: string) => void;
    } {
      // Electron 37+ passes ONE event object; the old positional
      // (event, level, message) form is deprecated and warns on every
      // message — into this very log.
      type ConsoleEvent = {
        level: string;
        message: string;
        lineNumber: number;
        sourceId: string;
      };
      const handlers: ((details: ConsoleEvent) => void)[] = [];
      const win = {
        webContents: {
          on: (channel: string, handler: (details: ConsoleEvent) => void) => {
            if (channel === 'console-message') handlers.push(handler);
          },
        },
      } as unknown as BrowserWindow;
      return {
        win,
        emit: (level, message, source = '') => {
          for (const handler of handlers)
            handler({ level, message, lineNumber: 7, sourceId: source });
        },
      };
    }

    it.each([
      ['debug', 'verbose'],
      ['info', 'info '],
      ['warning', 'warn '],
      ['error', 'error'],
    ])('maps renderer level %s to its label', async (level, label) => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      const { win, emit } = fakeWindow();
      attachWindowConsole(win, 'config');

      emit(level, `renderer-said-${level}`);

      const text = await readLogUntil(file, `renderer-said-${level}`);
      expect(text).toContain(`[${label}] [config] renderer-said-${level}`);
    });

    it('locates an error by source and line, so a packaged crash is findable', () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      const { win, emit } = fakeWindow();
      attachWindowConsole(win, 'tray');

      emit('error', 'boom', 'file:///app/tray.js');

      return readLogUntil(file, 'boom').then((text) => {
        expect(text).toContain('boom (file:///app/tray.js:7)');
      });
    });

    it('does not clutter a non-error line with its source', () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      const { win, emit } = fakeWindow();
      attachWindowConsole(win, 'tray');

      emit('info', 'just-saying', 'file:///app/tray.js');

      return readLogUntil(file, 'just-saying').then((text) => {
        expect(text).not.toContain('tray.js');
      });
    });

    it('falls back to "log" for a level it does not know', async () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      const { win, emit } = fakeWindow();
      attachWindowConsole(win, 'tray');

      emit('catastrophe', 'from-the-future');

      const text = await readLogUntil(file, 'from-the-future');
      expect(text).toContain('[log  ] [tray] from-the-future');
    });

    it('labels an empty origin rather than dropping the line', async () => {
      const file = path.join(tempDir(), 'app.log');
      init({ filePath: file });
      const { win, emit } = fakeWindow();
      attachWindowConsole(win, '');

      emit('info', 'no-origin');

      const text = await readLogUntil(file, 'no-origin');
      expect(text).toContain('[renderer] no-origin');
    });

    it('subscribes to nothing when the window has no webContents', () => {
      const win = {} as unknown as BrowserWindow;

      expect(() => attachWindowConsole(win, 'config')).not.toThrow();
    });
  });
});
