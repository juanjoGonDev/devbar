import type { LogEntry, LogLevel } from '../domain-types.js';
import {
  isShellNoise,
  matchesPattern,
  safeRegex,
  stripAnsi,
} from './log-filters.js';
import type { LineSink } from './line-splitter.js';
import type { InternalState, ResolvedTarget } from './state.js';
import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
} from '../log-level-defaults.js';

/**
 * What one line of a child's stdout or stderr does to its process: dropped
 * as shell noise, classified against the command's regexes and silence
 * patterns, counted, and appended — or, when a carriage return redrew it (a
 * progress bar), swapped in for the line it rewrites, counts included.
 */
interface OutputLineDeps {
  /** None for an action: its output is never classified. */
  warnRegex: RegExp | null;
  errorRegex: RegExp | null;
  /** False when a level only colours the line and never adds to the counts. */
  countsLevels: boolean;
  /**
   * Whether the process printed a real line yet, on either stream: before
   * that, a blank line is an rc file starting up, however slow it is.
   */
  printedYet: () => boolean;
  /** This line is the process's own output: blank lines count from now on. */
  printing: () => void;
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

/**
 * What tells a line's level: a command's own detectors; for a workflow
 * script, which has none, the defaults a command gets — so it reads the same
 * in the logs window and the workflow terminal. An action's output stays
 * unclassified (`pnpm install`'s «0 errors» must not read as one).
 */
export function levelDetectors(resolved: ResolvedTarget): {
  warnRegex: RegExp | null;
  errorRegex: RegExp | null;
} {
  if (resolved.kind === 'command')
    return {
      warnRegex: safeRegex(resolved.target.warnRegex),
      errorRegex: safeRegex(resolved.target.errorRegex),
    };
  if (resolved.kind === 'prescript')
    return {
      warnRegex: safeRegex(DEFAULT_WARN_REGEX),
      errorRegex: safeRegex(DEFAULT_ERROR_REGEX),
    };
  return { warnRegex: null, errorRegex: null };
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
  deps: OutputLineDeps,
): void {
  if (!deps.countsLevels) return;
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
      (!deps.printedYet() && stripAnsi(line).trim() === '')
    ) {
      last = null;
      return;
    }
    deps.printing();
    // Rewritten in place only while it is still the newest line: once
    // anything else (stderr, a sys line) came after it, the redraw is a new
    // line, as a terminal would scroll it.
    const rewritten = overwrite && last && deps.newest() === last ? last : null;
    const { warnCount, errorCount } = state;
    // A redraw takes the place of the line it rewrites in the counts too: a
    // progress bar matching a warning counts once, not once per frame.
    count(state, rewritten?.level, -1, deps);
    const { detected, silenced } = classify(line, deps);
    const entry: LogEntry = {
      ts: Date.now(),
      stream,
      level: silenced ? null : detected,
      originalLevel: detected,
      silenced,
      line,
    };
    count(state, entry.level, 1, deps);
    if (rewritten) deps.redraw(entry);
    else deps.push(entry);
    last = entry;
    if (state.warnCount !== warnCount || state.errorCount !== errorCount)
      deps.countsChanged(state);
  };
}
