/**
 * What a silence rule WOULD swallow, worked out before it is saved.
 *
 * The silenced popover previews a draft (and each saved rule, on hover)
 * against the lines the window already holds: how many, which ones, and where
 * in each line the rule bites (`ranges`, painted by `silence-marks.ts`). Pure
 * on purpose — every question here takes the lines and the rule as arguments,
 * so the matching is checked without a window.
 *
 * Matching follows storage exactly (`matchesPattern` in
 * `src/process/log-filters.ts`): no backslash → case-sensitive substring, any
 * backslash → case-insensitive regex, falling back to substring when it does
 * not compile. Only lines of the rule's own level count: a warn rule never
 * touches an error line.
 */
import { stripAnsi } from './ansi.js';
import { levelOf } from './filters.js';
import { encodeSilenceDraft } from '../../src/silence-pattern.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/**
 * Newest lines a preview reads. Retention can be set far past this; a preview
 * re-runs on every keystroke, so it reads a bounded tail instead.
 */
export const PREVIEW_SCAN_LIMIT = 50_000;
/** Highlighted runs per line: enough for a row, bounded for a pathological one. */
const MAX_RANGES = 20;

export type DraftCheck =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; pattern: string };

/**
 * Judge a draft as typed. Validity is checked on the user's own text: the
 * regex marker would turn something invalid on its own (`*foo`) into a valid
 * pattern that means something else.
 */
export function checkDraft(text: string, asRegex: boolean): DraftCheck {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  if (asRegex) {
    try {
      new RegExp(trimmed, 'i');
    } catch {
      return { kind: 'invalid', message: 'Regex no válida' };
    }
  }
  return { kind: 'ok', pattern: encodeSilenceDraft(trimmed, asRegex) };
}

export interface PatternMatcher {
  test(text: string): boolean;
  /** `[start, end)` of each non-empty match, in order. */
  ranges(text: string): Array<[number, number]>;
}

function substringMatcher(needle: string): PatternMatcher {
  return {
    test: (text) => text.includes(needle),
    ranges: (text) => {
      const out: Array<[number, number]> = [];
      let from = 0;
      while (out.length < MAX_RANGES) {
        const at = text.indexOf(needle, from);
        if (at < 0) break;
        out.push([at, at + needle.length]);
        from = at + needle.length;
      }
      return out;
    },
  };
}

/** Compile a stored pattern ONCE, with storage's own semantics. */
export function compilePattern(pattern: string): PatternMatcher {
  if (!pattern.includes('\\')) return substringMatcher(pattern);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return substringMatcher(pattern);
  }
  const global = new RegExp(regex.source, 'gi');
  return {
    test: (text) => regex.test(text),
    ranges: (text) => {
      const out: Array<[number, number]> = [];
      global.lastIndex = 0;
      while (out.length < MAX_RANGES) {
        const match = global.exec(text);
        if (!match) break;
        if (match[0].length === 0) {
          global.lastIndex += 1; // an empty match would spin in place
          if (global.lastIndex > text.length) break;
          continue;
        }
        out.push([match.index, match.index + match[0].length]);
      }
      return out;
    },
  };
}

export function entryWouldSilence(
  entry: LogEntry,
  level: SilenceLevel,
  matcher: PatternMatcher,
): boolean {
  return levelOf(entry) === level && matcher.test(stripAnsi(entry.line));
}

export interface PreviewResult {
  count: number;
  /** True when older lines past the scan cap were not read. */
  truncated: boolean;
}

export function previewPattern(
  entries: readonly LogEntry[],
  level: SilenceLevel,
  matcher: PatternMatcher,
  scanLimit = PREVIEW_SCAN_LIMIT,
): PreviewResult {
  const start = Math.max(0, entries.length - scanLimit);
  let count = 0;
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || levelOf(entry) !== level) continue;
    if (matcher.test(stripAnsi(entry.line))) count += 1;
  }
  return { count, truncated: start > 0 };
}

/** One count per saved pattern, stripping each line once for all of them. */
export function countPatternMatches(
  entries: readonly LogEntry[],
  level: SilenceLevel,
  patterns: readonly string[],
  scanLimit = PREVIEW_SCAN_LIMIT,
): number[] {
  const matchers = patterns.map(compilePattern);
  const counts = patterns.map(() => 0);
  if (!matchers.length) return counts;
  for (
    let i = Math.max(0, entries.length - scanLimit);
    i < entries.length;
    i += 1
  ) {
    const entry = entries[i];
    if (!entry || levelOf(entry) !== level) continue;
    const text = stripAnsi(entry.line);
    matchers.forEach((matcher, index) => {
      if (matcher.test(text)) counts[index] = (counts[index] ?? 0) + 1;
    });
  }
  return counts;
}
