/**
 * What a line has to pass to stay on screen, and how the active level pin
 * describes itself.
 *
 * The two filters are independent and both must pass: the find query (while
 * «Solo coincidencias» is on), and the level pin every warn/error entry point
 * sets. Keeping them here — pure, with the state handed in — is what lets a
 * test ask "does this line survive?" without a window.
 */
import { stripAnsi } from './ansi.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/** The level a line counts as, ignoring whether it was silenced. */
export function levelOf(entry: LogEntry): string {
  return entry.originalLevel ?? entry.level ?? '';
}

export function matchesLevel(
  levels: ReadonlySet<SilenceLevel>,
  level: string,
): boolean {
  if (!levels.size) return true;
  return levels.has(level as SilenceLevel);
}

export function matchesFilter(
  entry: LogEntry,
  filterRe: RegExp | null,
  levels: ReadonlySet<SilenceLevel>,
): boolean {
  if (!matchesLevel(levels, levelOf(entry))) return false;
  if (!filterRe) return true;
  return filterRe.test(stripAnsi(entry.line));
}

/**
 * Mirror the process-manager heuristic used for silenced patterns: a
 * backslash means the author meant a regex, anything else is a substring.
 */
export function clientMatchesPattern(p: string, lineText: string): boolean {
  if (!p) return false;
  if (!p.includes('\\')) return lineText.includes(p);
  try {
    return new RegExp(p, 'i').test(lineText);
  } catch (_) {
    return lineText.includes(p);
  }
}
