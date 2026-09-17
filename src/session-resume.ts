import fs from 'node:fs';
import path from 'node:path';

/**
 * Session resume — remember what was running so a restart brings it back.
 *
 * DevBar owns its services' process trees: when it stops (reinstall via
 * `pnpm install-local`, in-place update, kill, crash), every service stops
 * with it. This module persists the running set to a small JSON file in the
 * app-data dir (which the bundle swap never touches) and lets the next
 * launch decide what to restart.
 *
 * The file is EPHEMERAL by design: it is written while the app lives
 * (debounced on every change to the running set, refreshed periodically so
 * a crash still leaves a fresh one), rewritten one last time on every
 * controlled exit with the exit reason, and CONSUMED — read and deleted —
 * by exactly one launch. Nothing lingers.
 *
 * This module is pure node (no electron) so it is fully unit-testable;
 * main.ts does the wiring (what counts as "running", which ids may be
 * resumed, where the app-data dir is).
 */

/** File name inside the app-data dir. */
export const RESUME_STATE_FILE = 'session-resume.json';

/**
 * A snapshot older than this is not resumed: it is too long after the
 * previous session for the services to be "the user's current state"
 * (e.g. the app crashed and came back the next morning).
 */
export const RESUME_WINDOW_MS = 10 * 60 * 1000;

/**
 * Why the snapshot was written.
 *  - `live`   — written while the app was running (change/refresh).
 *  - `kill`   — the last write on exit, after SIGINT/SIGTERM (install-local,
 *               `kill`, Ctrl+C).
 *  - `quit`   — the last write on exit, after a user-initiated quit.
 *  - `update` — the last write on exit, when the app is quitting to apply
 *               an update (swap script / installer).
 * Resume rule: `quit` never resumes (a deliberate stop stays a stop);
 * `live`/`kill`/`update` resume when fresh.
 */
export type ResumeExitReason = 'live' | 'kill' | 'quit' | 'update';

export interface ResumeSnapshot {
  /** Schema version. */
  v: 1;
  /** Epoch ms when the snapshot was taken. */
  at: number;
  /** Why the snapshot was written. */
  exit: ResumeExitReason;
  /** Process ids (`cmd:<group>:<command>`) that were running. */
  services: string[];
}

/** Why a launch decided (or not) to resume. */
type ResumeReason =
  | 'fresh' // snapshot read, in window, resumable ids → resume
  | 'none' // no snapshot file
  | 'stale' // older than RESUME_WINDOW_MS
  | 'corrupt' // unreadable / wrong shape — deleted
  | 'user-quit' // previous session ended in a deliberate quit — deleted
  | 'empty'; // nothing left after filtering to valid ids — deleted
interface ResumeDecision {
  /** Process ids to start (order preserved from the snapshot). */
  resume: string[];
  /** What the decision was and why — for logging. */
  reason: ResumeReason;
}

interface Clock {
  now(): number;
}
const realClock: Clock = { now: () => Date.now() };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

function snapshotFile(dir: string): string {
  return path.join(dir, RESUME_STATE_FILE);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set<string>();
  for (const id of a) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  for (const id of b) if (!seen.has(id)) return false;
  return true;
}

/**
 * Persist the running set. Atomic (tmp + rename) and best-effort: returns
 * false instead of throwing when the disk refuses. An empty set DELETES
 * the file — an app with nothing running has nothing to hand over.
 */
export function saveSnapshot(
  dir: string,
  services: readonly string[],
  exit: ResumeExitReason,
  clock: Clock = realClock,
): boolean {
  try {
    const file = snapshotFile(dir);
    if (services.length === 0) {
      fs.rmSync(file, { force: true });
      return true;
    }
    fs.mkdirSync(dir, { recursive: true });
    const snap: ResumeSnapshot = {
      v: 1,
      at: clock.now(),
      exit,
      services: [...services],
    };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the snapshot, decide what to resume, and ALWAYS consume it (the file
 * is deleted in every branch — this launch is the only one that gets it).
 *
 * `isValid` is the launch-time gate (id still configured, still a command,
 * has a command, not confirm-gated). Non-string entries are dropped
 * silently; everything else that fails the gate becomes `empty` when
 * nothing is left.
 */
export function consumeSnapshot(
  dir: string,
  isValid: (id: string) => boolean,
  clock: Clock = realClock,
): ResumeDecision {
  const file = snapshotFile(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { resume: [], reason: 'none' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const snap = parsed as Partial<ResumeSnapshot> | null;
    if (
      typeof snap !== 'object' ||
      snap === null ||
      // Full persisted contract: an unknown schema version or exit reason
      // means the snapshot was written by another (future?) version —
      // do not start services under unknown semantics.
      snap.v !== 1 ||
      typeof snap.at !== 'number' ||
      !Number.isFinite(snap.at) ||
      (snap.exit !== 'live' &&
        snap.exit !== 'kill' &&
        snap.exit !== 'quit' &&
        snap.exit !== 'update') ||
      !Array.isArray(snap.services)
    ) {
      return { resume: [], reason: 'corrupt' };
    }
    // A clock rewind (at in the future) makes the age negative: treat it as
    // fresh rather than corrupt — the data itself is intact.
    if (clock.now() - snap.at > RESUME_WINDOW_MS)
      return { resume: [], reason: 'stale' };
    const services = snap.services.filter(
      (s): s is string => typeof s === 'string',
    );
    if (snap.exit === 'quit') return { resume: [], reason: 'user-quit' };
    const valid = services.filter(isValid);
    if (valid.length === 0) return { resume: [], reason: 'empty' };
    return { resume: valid, reason: 'fresh' };
  } catch {
    return { resume: [], reason: 'corrupt' };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Already gone — consuming twice must stay a no-op.
    }
  }
}

interface TrackerOptions {
  /** Debounce for change-driven writes. Default 750 ms. */
  writeDelayMs?: number;
  /** Periodic refresh while the set is non-empty (keeps a crash-resume
   * snapshot inside the window no matter when the set last changed).
   * Default 5 min. */
  refreshMs?: number;
  clock?: Clock;
  timers?: Timers;
}

/**
 * Live tracker: called with the current running set whenever it changes.
 *
 *  - writes are debounced (a service flapping must not hammer the disk);
 *  - a non-empty set is refreshed periodically so a CRASH (no exit handler)
 *    still leaves a snapshot inside the resume window;
 *  - `flush()` is the exit path: immediate write with the real exit reason,
 *    timers cancelled.
 */
export class SessionResumeTracker {
  private readonly dir: string;
  private readonly writeDelayMs: number;
  private readonly refreshMs: number;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private pending: string[] = [];
  private writeTimer: unknown = null;
  private refreshTimer: unknown = null;

  constructor(dir: string, opts: TrackerOptions = {}) {
    this.dir = dir;
    this.writeDelayMs = opts.writeDelayMs ?? 750;
    this.refreshMs = opts.refreshMs ?? 5 * 60 * 1000;
    this.clock = opts.clock ?? realClock;
    this.timers = opts.timers ?? realTimers;
  }

  /**
   * Report the current running set. A no-op when the set is unchanged, so
   * log-driven state churn never re-arms the debounce. An EMPTY set is
   * written immediately (and deletes the snapshot file): left to the
   * debounce, a crash within that window would leave the previous
   * non-empty snapshot on disk and the next launch would restart
   * services the user already stopped.
   */
  track(ids: readonly string[]): void {
    if (sameSet(this.pending, ids)) return;
    if (this.writeTimer !== null) this.timers.clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.pending = [...ids];
    if (this.pending.length === 0) {
      this.stopRefresh();
      saveSnapshot(this.dir, this.pending, 'live', this.clock);
      return;
    }
    this.writeTimer = this.timers.setTimeout(() => {
      this.writeTimer = null;
      saveSnapshot(this.dir, this.pending, 'live', this.clock);
    }, this.writeDelayMs);
    this.syncRefresh();
  }

  /**
   * Immediate write on exit. `ids` is authoritative (the caller passes the
   * live running set; the tracker's own copy may be <1 debounce old).
   * Cancels every pending timer — the app is going.
   */
  flush(exit: ResumeExitReason, ids?: readonly string[]): boolean {
    if (this.writeTimer !== null) {
      this.timers.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (ids !== undefined) this.pending = [...ids];
    this.stopRefresh();
    return saveSnapshot(this.dir, this.pending, exit, this.clock);
  }

  /** Drop everything without writing (never reached in normal exits). */
  dispose(): void {
    if (this.writeTimer !== null) {
      this.timers.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.stopRefresh();
  }

  private syncRefresh(): void {
    if (this.pending.length > 0 && this.refreshTimer === null) {
      this.refreshTimer = this.timers.setInterval(
        () => saveSnapshot(this.dir, this.pending, 'live', this.clock),
        this.refreshMs,
      );
    }
    if (this.pending.length === 0 && this.refreshTimer !== null)
      this.stopRefresh();
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== null) {
      this.timers.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
