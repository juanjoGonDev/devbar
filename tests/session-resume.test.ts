import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESUME_STATE_FILE,
  RESUME_WINDOW_MS,
  SessionResumeTracker,
  consumeSnapshot,
  saveSnapshot,
  type ResumeSnapshot,
  type Timers,
} from '../src/session-resume.js';

/** Epoch ms that all "now" calculations in this file agree on. */
const NOW = 1_800_000_000_000;
const clock = { now: () => NOW };

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-'));
}

function readSnapshot(dir: string): ResumeSnapshot {
  return JSON.parse(
    fs.readFileSync(path.join(dir, RESUME_STATE_FILE), 'utf8'),
  ) as ResumeSnapshot;
}

function fileExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, RESUME_STATE_FILE));
}

interface FakeTimers {
  timers: Timers;
  pendingTimeouts(): number;
  pendingIntervals(): number;
  fireNextTimeout(): void;
  fireInterval(): void;
}
function makeFakeTimers(): FakeTimers {
  let next = 1;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  return {
    pendingTimeouts: () => timeouts.size,
    pendingIntervals: () => intervals.size,
    fireNextTimeout: () => {
      const entry = timeouts.entries().next();
      if (entry.done) return;
      timeouts.delete(entry.value[0]);
      entry.value[1]();
    },
    fireInterval: () => {
      for (const fn of [...intervals.values()]) fn();
    },
    timers: {
      setTimeout: (fn: () => void) => {
        const id = next++;
        timeouts.set(id, fn);
        return id;
      },
      clearTimeout: (handle: unknown) => {
        timeouts.delete(handle as number);
      },
      setInterval: (fn: () => void) => {
        const id = next++;
        intervals.set(id, fn);
        return id;
      },
      clearInterval: (handle: unknown) => {
        intervals.delete(handle as number);
      },
    },
  };
}

describe('saveSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes an atomic snapshot with the running set and exit reason', () => {
    expect(saveSnapshot(dir, ['cmd:g1:a', 'cmd:g2:b'], 'kill', clock)).toBe(
      true,
    );
    const snap = readSnapshot(dir);
    expect(snap).toEqual({
      v: 1,
      at: NOW,
      exit: 'kill',
      services: ['cmd:g1:a', 'cmd:g2:b'],
    });
    // Atomic write leaves no tmp litter.
    expect(fs.readdirSync(dir)).toEqual([RESUME_STATE_FILE]);
  });

  it('copies the input array (later mutation does not corrupt the file)', () => {
    const services = ['cmd:g1:a'];
    saveSnapshot(dir, services, 'live', clock);
    services.push('cmd:g2:later');
    expect(readSnapshot(dir).services).toEqual(['cmd:g1:a']);
  });

  it('deletes the file for an empty set', () => {
    saveSnapshot(dir, ['cmd:g1:a'], 'live', clock);
    expect(fileExists(dir)).toBe(true);
    expect(saveSnapshot(dir, [], 'quit', clock)).toBe(true);
    expect(fileExists(dir)).toBe(false);
  });

  it('is a no-op success when an empty set finds no file', () => {
    expect(saveSnapshot(dir, [], 'quit', clock)).toBe(true);
    expect(fileExists(dir)).toBe(false);
  });

  it('creates the directory when missing', () => {
    const nested = path.join(dir, 'a', 'b');
    expect(saveSnapshot(nested, ['cmd:g1:a'], 'update', clock)).toBe(true);
    expect(readSnapshot(nested).exit).toBe('update');
  });

  it('returns false instead of throwing when the disk refuses', () => {
    // A regular file standing where the directory should be: mkdirSync
    // throws ENOTDIR.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(
      saveSnapshot(path.join(blocker, 'sub'), ['cmd:g1:a'], 'live', clock),
    ).toBe(false);
  });
});

describe('consumeSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns none when there is no file', () => {
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: [],
      reason: 'none',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('resumes the valid ids in order when the snapshot is fresh', () => {
    saveSnapshot(dir, ['cmd:g1:a', 'cmd:g2:b', 'cmd:g3:c'], 'kill', clock);
    const seen: string[] = [];
    const decision = consumeSnapshot(
      dir,
      (id) => {
        seen.push(id);
        return id !== 'cmd:g2:b';
      },
      clock,
    );
    expect(decision).toEqual({
      resume: ['cmd:g1:a', 'cmd:g3:c'],
      reason: 'fresh',
    });
    // The gate only saw the ids in stored order.
    expect(seen).toEqual(['cmd:g1:a', 'cmd:g2:b', 'cmd:g3:c']);
    // Consumed: the file is gone.
    expect(fileExists(dir)).toBe(false);
  });

  it('accepts every non-quit exit reason (live, kill, update)', () => {
    for (const exit of ['live', 'kill', 'update'] as const) {
      const d = makeDir();
      try {
        saveSnapshot(d, ['cmd:g1:a'], exit, clock);
        expect(consumeSnapshot(d, () => true, clock)).toEqual({
          resume: ['cmd:g1:a'],
          reason: 'fresh',
        });
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('never resumes a deliberate quit and still deletes the file', () => {
    saveSnapshot(dir, ['cmd:g1:a'], 'quit', clock);
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: [],
      reason: 'user-quit',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('drops a snapshot older than the window (and deletes it)', () => {
    const oldClock = { now: () => NOW - RESUME_WINDOW_MS - 1000 };
    saveSnapshot(dir, ['cmd:g1:a'], 'kill', oldClock);
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: [],
      reason: 'stale',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('accepts a snapshot exactly at the window boundary', () => {
    const atEdge = { now: () => NOW - RESUME_WINDOW_MS };
    saveSnapshot(dir, ['cmd:g1:a'], 'kill', atEdge);
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: ['cmd:g1:a'],
      reason: 'fresh',
    });
  });

  it('treats a future at (clock rewind) as fresh, not corrupt', () => {
    const futureClock = { now: () => NOW + RESUME_WINDOW_MS * 2 };
    saveSnapshot(dir, ['cmd:g1:a'], 'kill', futureClock);
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: ['cmd:g1:a'],
      reason: 'fresh',
    });
  });

  it.each(['{not json', '42', 'null', '"str"'])('corrupt payload %s', (raw) => {
    fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), raw);
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: [],
      reason: 'corrupt',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('rejects a snapshot missing at / with a non-array services', () => {
    fs.writeFileSync(
      path.join(dir, RESUME_STATE_FILE),
      JSON.stringify({ v: 1, services: ['cmd:g1:a'] }),
    );
    expect(consumeSnapshot(dir, () => true, clock).reason).toBe('corrupt');
    expect(fileExists(dir)).toBe(false);

    fs.writeFileSync(
      path.join(dir, RESUME_STATE_FILE),
      JSON.stringify({ v: 1, at: 'yesterday', services: 'nope' }),
    );
    expect(consumeSnapshot(dir, () => true, clock).reason).toBe('corrupt');
    expect(fileExists(dir)).toBe(false);
  });

  it('rejects unknown schema versions, unknown exit reasons and non-finite timestamps', () => {
    const corrupt = (snap: unknown) => {
      fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(snap));
      expect(consumeSnapshot(dir, () => true, clock).reason).toBe('corrupt');
      expect(fileExists(dir)).toBe(false);
    };
    // A future version's snapshot must not start services under unknown semantics.
    corrupt({ v: 2, at: 0, exit: 'kill', services: ['cmd:g1:a'] });
    corrupt({ v: undefined, at: 0, exit: 'kill', services: ['cmd:g1:a'] });
    // An unrecognised exit reason has unknown resume semantics.
    corrupt({ v: 1, at: 0, exit: 'crash', services: ['cmd:g1:a'] });
    corrupt({ v: 1, at: 0, exit: null, services: ['cmd:g1:a'] });
    // A non-finite timestamp cannot be aged (NaN would pass the window check).
    corrupt({ v: 1, at: Number.NaN, exit: 'kill', services: ['cmd:g1:a'] });
    corrupt({ v: 1, at: null, exit: 'kill', services: ['cmd:g1:a'] });
  });

  it('drops non-string entries and resumes the rest', () => {
    fs.writeFileSync(
      path.join(dir, RESUME_STATE_FILE),
      JSON.stringify({
        v: 1,
        at: NOW,
        exit: 'kill',
        services: [42, null, 'cmd:g1:a', { nested: true }, 'cmd:g2:b'],
      }),
    );
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: ['cmd:g1:a', 'cmd:g2:b'],
      reason: 'fresh',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('reports empty when the gate rejects everything (and deletes the file)', () => {
    saveSnapshot(dir, ['cmd:gone:a', 'act:g1:x'], 'kill', clock);
    expect(consumeSnapshot(dir, () => false, clock)).toEqual({
      resume: [],
      reason: 'empty',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('reports empty for a snapshot with an empty services list', () => {
    saveSnapshot(dir, [], 'live', clock); // writes nothing (deletes)
    fs.writeFileSync(
      path.join(dir, RESUME_STATE_FILE),
      JSON.stringify({ v: 1, at: NOW, exit: 'live', services: [] }),
    );
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: [],
      reason: 'empty',
    });
    expect(fileExists(dir)).toBe(false);
  });

  it('is idempotent: a second consume finds nothing', () => {
    saveSnapshot(dir, ['cmd:g1:a'], 'kill', clock);
    consumeSnapshot(dir, () => true, clock);
    expect(consumeSnapshot(dir, () => true, clock)).toEqual({
      resume: [],
      reason: 'none',
    });
  });

  it('still returns its decision when the file cannot be deleted', () => {
    if (process.platform === 'win32') return; // no chmod on Windows
    saveSnapshot(dir, ['cmd:g1:a'], 'kill', clock);
    fs.chmodSync(dir, 0o555); // read+traverse, no write: rm fails
    try {
      const decision = consumeSnapshot(dir, () => true, clock);
      expect(decision.reason).toBe('fresh');
      // Deletion was best-effort: the file survives the failed rm.
      expect(fileExists(dir)).toBe(true);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe('SessionResumeTracker', () => {
  let dir: string;
  let fake: FakeTimers;
  let tracker: SessionResumeTracker;

  beforeEach(() => {
    dir = makeDir();
    fake = makeFakeTimers();
    tracker = new SessionResumeTracker(dir, {
      writeDelayMs: 750,
      refreshMs: 5 * 60 * 1000,
      clock,
      timers: fake.timers,
    });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('debounces change-driven writes (exit live)', () => {
    tracker.track(['cmd:g1:a']);
    // Before the debounce fires: nothing on disk yet.
    expect(fileExists(dir)).toBe(false);
    fake.fireNextTimeout();
    expect(readSnapshot(dir).services).toEqual(['cmd:g1:a']);
    expect(readSnapshot(dir).exit).toBe('live');
  });

  it('ignores an unchanged set (no re-arm, single write)', () => {
    tracker.track(['cmd:g1:a']);
    tracker.track(['cmd:g1:a']); // same set: no-op
    expect(fake.pendingTimeouts()).toBe(1);
    fake.fireNextTimeout();
    expect(fileExists(dir)).toBe(true);
    // The one armed timer is spent.
    expect(fake.pendingTimeouts()).toBe(0);
  });

  it('re-arms on a changed set, dropping the stale pending write', () => {
    tracker.track(['cmd:g1:a']);
    tracker.track(['cmd:g1:b']); // changed: previous timer cleared
    expect(fake.pendingTimeouts()).toBe(1);
    fake.fireNextTimeout();
    expect(readSnapshot(dir).services).toEqual(['cmd:g1:b']);
    // Only one timer survived the re-arm.
    expect(fake.pendingTimeouts()).toBe(0);
  });

  it('treats order as irrelevant when the set is unchanged', () => {
    tracker.track(['cmd:g1:a', 'cmd:g2:b']);
    tracker.track(['cmd:g2:b', 'cmd:g1:a']); // same set, other order
    expect(fake.pendingTimeouts()).toBe(1);
  });

  it('re-arms when the reported set carries duplicates (defensive)', () => {
    tracker.track(['cmd:g1:a', 'cmd:g1:a']); // duplicate: seen twice
    expect(fake.pendingTimeouts()).toBe(1);
    tracker.track(['cmd:g1:a', 'cmd:g1:a']);
    // A duplicated set never compares "same" to itself — it re-arms.
    expect(fake.pendingTimeouts()).toBe(1);
  });

  it('deletes the file when the set becomes empty', () => {
    tracker.track(['cmd:g1:a']);
    fake.fireNextTimeout();
    expect(fileExists(dir)).toBe(true);
    tracker.track([]);
    fake.fireNextTimeout();
    expect(fileExists(dir)).toBe(false);
  });

  it('refreshes a non-empty set periodically so a crash leaves a fresh file', () => {
    tracker.track(['cmd:g1:a']);
    fake.fireNextTimeout(); // first write
    expect(fake.pendingIntervals()).toBe(1);
    // Simulate minutes passing: the clock moves, the interval ticks.
    const laterClock = { now: () => NOW + 60_000 };
    const refreshTracker = new SessionResumeTracker(dir, {
      clock: laterClock,
      timers: fake.timers,
    });
    // The original tracker's interval is still armed and writes with ITS
    // clock; assert the mechanics, then move to the moved clock:
    fake.fireInterval();
    expect(readSnapshot(dir).at).toBe(NOW);
    // A tracker whose clock moved writes the moved timestamp on tick.
    refreshTracker.track(['cmd:g1:a']);
    expect(fake.pendingIntervals()).toBe(2);
    fake.fireInterval();
    expect(readSnapshot(dir).at).toBe(NOW + 60_000);
    expect(fake.pendingIntervals()).toBe(2);
  });

  it('stops refreshing when the set goes empty', () => {
    tracker.track(['cmd:g1:a']);
    fake.fireNextTimeout();
    expect(fake.pendingIntervals()).toBe(1);
    tracker.track([]);
    // The empty change cancels the refresh immediately (no write needed:
    // the debounced delete handles the file).
    expect(fake.pendingIntervals()).toBe(0);
  });

  it('flush writes immediately with the exit reason and given ids', () => {
    tracker.track(['cmd:g1:a']); // pending, not written
    expect(fileExists(dir)).toBe(false);
    const ok = tracker.flush('kill', ['cmd:g1:a', 'cmd:g2:b']);
    expect(ok).toBe(true);
    expect(fake.pendingTimeouts()).toBe(0);
    expect(fake.pendingIntervals()).toBe(0);
    const snap = readSnapshot(dir);
    expect(snap.exit).toBe('kill');
    expect(snap.services).toEqual(['cmd:g1:a', 'cmd:g2:b']);
  });

  it('flush without ids falls back to the tracked set', () => {
    tracker.track(['cmd:g1:a']);
    tracker.flush('update');
    expect(readSnapshot(dir).services).toEqual(['cmd:g1:a']);
    expect(readSnapshot(dir).exit).toBe('update');
  });

  it('flush with an empty set deletes the file', () => {
    tracker.track(['cmd:g1:a']);
    fake.fireNextTimeout();
    expect(fileExists(dir)).toBe(true);
    tracker.flush('quit', []);
    expect(fileExists(dir)).toBe(false);
  });

  it('flush returns false when the disk refuses', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    tracker.flush('kill', ['cmd:g1:a']);
    // The tracker was built on a healthy dir; point a second one at the
    // impossible one.
    const broken = new SessionResumeTracker(path.join(blocker, 'sub'), {
      clock,
      timers: fake.timers,
    });
    expect(broken.flush('kill', ['cmd:g1:a'])).toBe(false);
  });

  it('dispose cancels the pending write and the refresh', () => {
    tracker.track(['cmd:g1:a']);
    expect(fake.pendingTimeouts()).toBe(1);
    expect(fake.pendingIntervals()).toBe(1);
    tracker.dispose();
    expect(fake.pendingTimeouts()).toBe(0);
    expect(fake.pendingIntervals()).toBe(0);
    expect(fileExists(dir)).toBe(false);
    // Disposing twice must stay a no-op.
    tracker.dispose();
  });

  it('flush after dispose still writes (dispose is not a lock)', () => {
    tracker.dispose();
    expect(tracker.flush('quit', ['cmd:g1:a'])).toBe(true);
    expect(readSnapshot(dir).services).toEqual(['cmd:g1:a']);
  });

  it('uses real timers and the real clock by default', async () => {
    const realTracker = new SessionResumeTracker(dir); // no options at all
    realTracker.track(['cmd:g1:a']);
    // Flush while the debounced write is STILL pending: the pending timer
    // must be cancelled and the file written immediately with the exit
    // reason (default debounce is 750 ms — flush far earlier than that).
    realTracker.flush('kill', ['cmd:g1:a', 'cmd:g2:b']);
    expect(readSnapshot(dir).exit).toBe('kill');
    expect(readSnapshot(dir).services).toEqual(['cmd:g1:a', 'cmd:g2:b']);
    // The cancelled timer must not write a stale "live" snapshot later.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(readSnapshot(dir).exit).toBe('kill');
    // A new change still goes through the real debounce.
    realTracker.track(['cmd:g1:a']);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const snap = readSnapshot(dir);
    expect(snap.services).toEqual(['cmd:g1:a']);
    expect(snap.exit).toBe('live');
    expect(Math.abs(Date.now() - snap.at)).toBeLessThan(5000);
    realTracker.flush('quit', []);
    expect(fileExists(dir)).toBe(false);
  });
});
