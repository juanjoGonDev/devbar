import type { LogEntry, LogLevel } from '../domain-types.js';
import { isShellNoise, matchesPattern, stripAnsi } from './log-filters.js';
import type { LineSink } from './line-splitter.js';
import type { InternalState } from './state.js';

/**
 * What one line of a child's stdout or stderr does to its process: dropped
 * as shell noise, classified against the command's regexes and silence
 * patterns, counted, and appended — or, when a carriage return redrew it (a
 * progress bar), swapped in for the line it rewrites, counts included.
 */
interface OutputLineDeps {
  /** Regexes are a command concept: an action or pre-script has none. */
  warnRegex: RegExp | null;
  errorRegex: RegExp | null;
  /** True while an rc file may still be printing blank lines at start-up. */
  inInitWindow: () => boolean;
  /** A port probe's own echo, which gets no level at all. */
  isProbeNoise: (cleaned: string) => boolean;
  /** Read per line, so a pattern added mid-run applies to the next one. */
  silencedPatterns: (level: LogLevel) => readonly string[];
  /** The live state; undefined once the process was forgotten. */
  state: () => InternalState | undefined;
  /** The newest entry of the process's buffer. */
  newest: () => LogEntry | undefined;
  push: (entry: LogEntry) => void;
  /** Rewrite the newest entry of the buffer in place with this one. */
  redraw: (entry: LogEntry) => void;
  countsChanged: (state: InternalState) => void;
}

function classify(
  line: string,
  deps: OutputLineDeps,
): { detected: LogLevel | null; silenced: boolean } {
  let detected: LogLevel | null = null;
  if (deps.errorRegex?.test(line)) detected = 'error';
  else if (deps.warnRegex?.test(line)) detected = 'warn';
  if (!detected) return { detected, silenced: false };
  const cleaned = stripAnsi(line);
  // No level at all (not «silenced»): recount must never revive it.
  if (deps.isProbeNoise(cleaned)) return { detected: null, silenced: false };
  const silenced = deps
    .silencedPatterns(detected)
    .some((pattern) => matchesPattern(pattern, cleaned));
  return { detected, silenced };
}

function count(
  state: InternalState,
  level: LogLevel | null | undefined,
  delta: 1 | -1,
): void {
  if (level === 'error') state.errorCount += delta;
  else if (level === 'warn') state.warnCount += delta;
}

export function outputLines(
  stream: 'stdout' | 'stderr',
  deps: OutputLineDeps,
): LineSink {
  /** The entry this stream's last line became: what a redraw rewrites. */
  let last: LogEntry | null = null;
  return (line, overwrite) => {
    const state = deps.state();
    if (
      !state ||
      isShellNoise(line) ||
      (deps.inInitWindow() && stripAnsi(line).trim() === '')
    ) {
      last = null;
      return;
    }
    // Rewritten in place only while it is still the newest line: once
    // anything else (stderr, a sys line) came after it, the redraw is a new
    // line, as a terminal would scroll it.
    const rewritten = overwrite && last && deps.newest() === last ? last : null;
    const { warnCount, errorCount } = state;
    // A redraw takes the place of the line it rewrites in the counts too: a
    // progress bar matching a warning counts once, not once per frame.
    count(state, rewritten?.level, -1);
    const { detected, silenced } = classify(line, deps);
    const entry: LogEntry = {
      ts: Date.now(),
      stream,
      level: silenced ? null : detected,
      originalLevel: detected,
      silenced,
      line,
    };
    count(state, entry.level, 1);
    if (rewritten) deps.redraw(entry);
    else deps.push(entry);
    last = entry;
    if (state.warnCount !== warnCount || state.errorCount !== errorCount)
      deps.countsChanged(state);
  };
}
