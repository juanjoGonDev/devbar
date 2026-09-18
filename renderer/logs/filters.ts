/**
 * What a line has to pass to stay on screen, and how the active level pin
 * describes itself.
 *
 * The two filters are independent and both must pass: the text box is manual
 * searching, the level pin is what every warn/error entry point sets. Keeping
 * them here — pure, with the state handed in — is what lets a test ask "does
 * this line survive?" without a window.
 */
import { stripAnsi } from './ansi.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/**
 * A search box that is also a regex box. An unparseable pattern is not an
 * error to report: it is someone halfway through typing one, so it falls back
 * to matching the literal text.
 */
export function buildFilter(value: string): RegExp | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new RegExp(trimmed, 'i');
  } catch (_) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
}

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

/** The text of the escape-hatch pill, e.g. `sólo ⚠ warnings + ⛔ errores`. */
export function levelPillLabel(levels: readonly SilenceLevel[]): string {
  const label = levels
    .map((level) => (level === 'warn' ? '⚠ warnings' : '⛔ errores'))
    .join(' + ');
  return `sólo ${label}`;
}

/** Errors outrank warnings when the pill stands for both. */
export function levelPillClass(levels: readonly SilenceLevel[]): string {
  return `level-pill ${levels.includes('error') ? 'err' : 'warn'}`;
}
