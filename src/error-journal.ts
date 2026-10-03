/**
 * The warn/error journal behind «Errores y avisos recientes» in the bug
 * report. app.log is a tail the report can only sample, so a failure an
 * hour ago is long gone from it; this keeps the last N problems apart, in
 * memory, and mirrors them to a small JSON file so they survive the very
 * events worth reporting — a crash, an update relaunch.
 *
 * The file is written with a debounce (one write per burst, never one per
 * line) and atomically: a temp file renamed over the real one, so a crash
 * mid-write leaves the previous version, never half a JSON document.
 *
 * It must never log: the logger feeds it, so a console call from here
 * would feed it again. Every disk failure is swallowed.
 */

type ProblemLevel = 'warn' | 'error';

export interface ProblemEntry {
  /** ISO time of the LAST occurrence (a grouped run keeps the newest). */
  ts: string;
  level: ProblemLevel;
  /** `main`, or `renderer:<window>`. */
  source: string;
  message: string;
  /** How many identical consecutive occurrences this entry stands for. */
  count: number;
  /** The session that recorded it (its start time), to tell runs apart. */
  session: string;
}

export interface JournalFs {
  readFileSync: (file: string, encoding: 'utf8') => string;
  writeFileSync: (file: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
}

interface JournalOptions {
  filePath: string;
  fs: JournalFs;
  now: () => Date;
  session: string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  capacity?: number;
  maxMessageChars?: number;
  debounceMs?: number;
}

export interface ErrorJournal {
  record: (level: ProblemLevel, source: string, message: string) => void;
  /** Oldest first, previous sessions included. */
  entries: () => ProblemEntry[];
  /** Writes now if anything changed; for crash paths that cannot wait. */
  flush: () => void;
}

const JOURNAL_CAPACITY = 50;
const MAX_MESSAGE_CHARS = 1000;
const DEBOUNCE_MS = 1000;

function isEntry(value: unknown): value is ProblemEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.ts === 'string' &&
    (e.level === 'warn' || e.level === 'error') &&
    typeof e.source === 'string' &&
    typeof e.message === 'string' &&
    typeof e.count === 'number' &&
    typeof e.session === 'string'
  );
}

function load(fs: JournalFs, file: string, capacity: number): ProblemEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      entries?: unknown;
    };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isEntry).slice(-capacity);
  } catch {
    return [];
  }
}

export function createErrorJournal(options: JournalOptions): ErrorJournal {
  const { filePath, fs, now, session, setTimer, clearTimer } = options;
  const capacity = options.capacity ?? JOURNAL_CAPACITY;
  const maxChars = options.maxMessageChars ?? MAX_MESSAGE_CHARS;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const entries = load(fs, filePath, capacity);
  let pending: unknown = null;
  let dirty = false;

  const flush = (): void => {
    if (pending !== null) {
      clearTimer(pending);
      pending = null;
    }
    if (!dirty) return;
    dirty = false;
    const tmp = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
      fs.renameSync(tmp, filePath);
    } catch {
      // A full or read-only disk loses the mirror, never the app.
    }
  };

  const record = (
    level: ProblemLevel,
    source: string,
    message: string,
  ): void => {
    const text =
      message.length > maxChars ? `${message.slice(0, maxChars)}…` : message;
    const ts = now().toISOString();
    const last = entries[entries.length - 1];
    if (
      last &&
      last.session === session &&
      last.level === level &&
      last.source === source &&
      last.message === text
    ) {
      last.count += 1;
      last.ts = ts;
    } else {
      entries.push({ ts, level, source, message: text, count: 1, session });
      if (entries.length > capacity)
        entries.splice(0, entries.length - capacity);
    }
    dirty = true;
    // Coalesce a burst into one write, but never postpone it forever: the
    // first record of a burst arms the timer, later ones ride along.
    if (pending === null)
      pending = setTimer(() => {
        pending = null;
        flush();
      }, debounceMs);
  };

  return { record, entries: () => entries.map((e) => ({ ...e })), flush };
}
