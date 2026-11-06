export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function buildSilencePattern(line: string | null | undefined): string {
  if (line == null) return '';
  const trimmed = String(line).trim();
  if (!trimmed) return '';
  return regexEscape(trimmed).replace(/\d{2,}/g, '\\d+');
}

/**
 * How a typed silence rule is stored.
 *
 * Storage has no "is this a regex" flag: `matchesPattern` decides by the
 * presence of a backslash (none → substring, any → regex). Adding a flag would
 * change the config schema, main's matcher, the IPC contract and every stored
 * rule, so the panel's `.*` toggle is encoded INTO the string instead:
 *
 * - a regex with no backslash of its own gets this prefix — a zero-width group
 *   that always matches (every position is either a word boundary or not), so
 *   it changes nothing about what the regex matches, even across a top-level
 *   `|` or a leading `^`; it is only there to carry the backslash;
 * - a substring that contains a backslash is escaped into the regex that
 *   matches it literally (case-insensitively, as every stored regex is).
 *
 * `decodeSilencePattern` strips the marker back off for display.
 */
export const REGEX_MARKER = String.raw`(?:\b|\B)`;

export function encodeSilenceDraft(text: string, asRegex: boolean): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const hasBackslash = trimmed.includes('\\');
  if (!asRegex) return hasBackslash ? regexEscape(trimmed) : trimmed;
  return hasBackslash ? trimmed : `${REGEX_MARKER}${trimmed}`;
}

export function decodeSilencePattern(pattern: string): {
  text: string;
  regex: boolean;
} {
  if (pattern.startsWith(REGEX_MARKER))
    return { text: pattern.slice(REGEX_MARKER.length), regex: true };
  return { text: pattern, regex: pattern.includes('\\') };
}
