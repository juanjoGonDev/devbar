'use strict';

/**
 * Escape all regex special characters in a string.
 * @param {string} s
 * @returns {string}
 */
function regexEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex body from a (caller-stripped, ANSI-free) log line.
 *
 * Steps:
 *  1. Return '' for null/empty/whitespace input.
 *  2. trim()
 *  3. regexEscape every char (digits are NOT special in regex, so they survive)
 *  4. Replace runs of 2+ literal digits with \d+
 *
 * Design decisions:
 *  - No anchors (^ $) — matching is substring-style via new RegExp(pattern, 'i').test(line)
 *  - Digit-run threshold = 2 so single digits like 'v2' stay literal
 *  - Bracket/level prefix is preserved but neutralized via the \d+ substitution:
 *    "[12:34:56] WARN msg" → "\[\d+:\d+:\d+\] WARN msg"
 *    This keeps patterns more precise (level-specific) while still defeating
 *    the timestamp-mismatch problem that motivated this feature.
 *
 * @param {string|null} line
 * @returns {string}  regex body (empty string when input is empty/null)
 */
function buildSilencePattern(line) {
  if (line == null) return '';
  const trimmed = String(line).trim();
  if (!trimmed) return '';
  const escaped = regexEscape(trimmed);
  // \d{2,} matches runs of 2+ literal digits that survived regexEscape unchanged.
  return escaped.replace(/\d{2,}/g, '\\d+');
}

module.exports = { buildSilencePattern, regexEscape };
