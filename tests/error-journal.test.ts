import { describe, expect, it } from 'vitest';
import {
  createErrorJournal,
  type JournalFs,
  type ProblemEntry,
} from '../src/error-journal.js';

const FILE = '/logs/errors.json';

/** In-memory fs that records every write/rename, so atomicity is visible. */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const ops: string[] = [];
  let failWrites = false;
  const fs: JournalFs = {
    readFileSync: (file) => {
      const text = files.get(file);
      if (text === undefined) throw new Error(`ENOENT ${file}`);
      return text;
    },
    writeFileSync: (file, data) => {
      if (failWrites) throw new Error('EACCES');
      ops.push(`write:${file}`);
      files.set(file, data);
    },
    renameSync: (from, to) => {
      ops.push(`rename:${from}->${to}`);
      const text = files.get(from);
      if (text === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, text);
      files.delete(from);
    },
  };
  return {
    fs,
    files,
    ops,
    failWrites: () => {
      failWrites = true;
    },
  };
}

/** Manual timers: a test decides when the debounced flush fires. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (id: unknown) => void pending.delete(id as number),
    pendingCount: () => pending.size,
    fire: () => {
      const all = [...pending.values()];
      pending.clear();
      for (const fn of all) fn();
    },
  };
}

function journal(
  options: {
    initial?: Record<string, string>;
    capacity?: number;
    maxMessageChars?: number;
    session?: string;
  } = {},
) {
  const memory = memoryFs(options.initial);
  const timers = manualTimers();
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const j = createErrorJournal({
    filePath: FILE,
    fs: memory.fs,
    now: () => new Date(clock),
    session: options.session ?? 'S2',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(options.capacity ? { capacity: options.capacity } : {}),
    ...(options.maxMessageChars
      ? { maxMessageChars: options.maxMessageChars }
      : {}),
  });
  return {
    j,
    memory,
    timers,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function persisted(files: Map<string, string>): ProblemEntry[] {
  return (JSON.parse(files.get(FILE) ?? '{}') as { entries: ProblemEntry[] })
    .entries;
}

describe('src/error-journal.ts', () => {
  it('records warnings and errors with time, level, source and session', () => {
    const { j } = journal();
    j.record('error', 'main', 'download failed');
    expect(j.entries()).toEqual([
      {
        ts: '2026-09-30T10:00:00.000Z',
        level: 'error',
        source: 'main',
        message: 'download failed',
        count: 1,
        session: 'S2',
      },
    ]);
  });

  it('keeps only the newest entries once the capacity is reached', () => {
    const { j } = journal({ capacity: 3 });
    for (const n of [1, 2, 3, 4, 5]) j.record('warn', 'main', `w${n}`);
    expect(j.entries().map((e) => e.message)).toEqual(['w3', 'w4', 'w5']);
  });

  it('truncates an oversized message', () => {
    const { j } = journal({ maxMessageChars: 10 });
    j.record('error', 'main', 'x'.repeat(50));
    const [entry] = j.entries();
    expect(entry?.message).toBe(`${'x'.repeat(10)}…`);
  });

  it('groups identical consecutive messages into one entry with a count', () => {
    const { j, tick } = journal();
    j.record('error', 'main', 'same');
    tick(1000);
    j.record('error', 'main', 'same');
    j.record('warn', 'main', 'same'); // a different level breaks the run
    expect(j.entries()).toMatchObject([
      {
        message: 'same',
        level: 'error',
        count: 2,
        ts: '2026-09-30T10:00:01.000Z',
      },
      { message: 'same', level: 'warn', count: 1 },
    ]);
  });

  it('persists with a debounce, atomically: write a temp file, then rename', () => {
    const { j, memory, timers } = journal();
    j.record('error', 'main', 'a');
    j.record('error', 'main', 'b');
    // One pending flush for the burst, nothing on disk yet.
    expect(timers.pendingCount()).toBe(1);
    expect(memory.files.has(FILE)).toBe(false);
    timers.fire();
    expect(memory.ops).toEqual([
      `write:${FILE}.tmp`,
      `rename:${FILE}.tmp->${FILE}`,
    ]);
    expect(persisted(memory.files).map((e) => e.message)).toEqual(['a', 'b']);
  });

  it('flushes on demand and cancels the pending debounce', () => {
    const { j, memory, timers } = journal();
    j.record('error', 'main', 'crash');
    j.flush();
    expect(timers.pendingCount()).toBe(0);
    expect(persisted(memory.files)).toHaveLength(1);
    // Nothing new: a second flush writes nothing.
    j.flush();
    expect(memory.ops).toHaveLength(2);
  });

  it('loads what a previous session persisted and keeps adding to it', () => {
    const previous: ProblemEntry = {
      ts: '2026-09-29T08:00:00.000Z',
      level: 'error',
      source: 'main',
      message: 'install failed',
      count: 1,
      session: 'S1',
    };
    const { j } = journal({
      initial: { [FILE]: JSON.stringify({ version: 1, entries: [previous] }) },
    });
    j.record('warn', 'renderer:config', 'slow');
    expect(j.entries().map((e) => e.session)).toEqual(['S1', 'S2']);
  });

  it('does not group a new message with an identical one from an older session', () => {
    const { j } = journal({
      initial: {
        [FILE]: JSON.stringify({
          version: 1,
          entries: [
            {
              ts: '2026-09-29T08:00:00.000Z',
              level: 'error',
              source: 'main',
              message: 'same',
              count: 1,
              session: 'S1',
            },
          ],
        }),
      },
    });
    j.record('error', 'main', 'same');
    expect(j.entries()).toHaveLength(2);
  });

  it.each([
    ['garbage', 'not json'],
    ['a wrong shape', JSON.stringify({ entries: 'nope' })],
    ['invalid entries', JSON.stringify({ entries: [{ level: 'info' }, null] })],
  ])('starts empty when the persisted file holds %s', (_label, text) => {
    const { j } = journal({ initial: { [FILE]: text } });
    expect(j.entries()).toEqual([]);
  });

  it('trims a persisted file larger than the capacity to its newest entries', () => {
    const entries = [1, 2, 3].map((n) => ({
      ts: '2026-09-29T08:00:00.000Z',
      level: 'warn',
      source: 'main',
      message: `m${n}`,
      count: 1,
      session: 'S1',
    }));
    const { j } = journal({
      capacity: 2,
      initial: { [FILE]: JSON.stringify({ version: 1, entries }) },
    });
    expect(j.entries().map((e) => e.message)).toEqual(['m2', 'm3']);
  });

  it('never throws when the disk refuses the write', () => {
    const { j, memory } = journal();
    memory.failWrites();
    j.record('error', 'main', 'x');
    expect(() => j.flush()).not.toThrow();
    expect(j.entries()).toHaveLength(1);
  });
});
