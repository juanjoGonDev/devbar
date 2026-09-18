/**
 * Line-level filtering for service output: what is noise, and what counts as
 * a warning or an error.
 *
 * Every helper here is pure and total — a user-authored regex that does not
 * compile must never take the manager down, so `safeRegex` answers `null`
 * instead of throwing and each caller decides the fallback.
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const SHELL_NOISE_PATTERNS = [
  /^\(anon\):setopt:\d+: can't change option: monitor$/,
  /^\[ERROR\]: gitstatus failed to initialize/,
  /^Add the following parameter to/,
  /^GITSTATUS_LOG_LEVEL=DEBUG$/,
  /^Restart Zsh to retry gitstatus/,
  /^exec zsh$/,
  /^zsh: no job control in this shell$/,
];

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

/**
 * Chatter the INTERACTIVE login shell itself emits (`-ic` loads the user's
 * rc files), not the service. Blank lines are not noise by this rule — the
 * start-up window in `ProcessManager.start` handles those.
 */
export function isShellNoise(line: string): boolean {
  const clean = stripAnsi(line).trim();
  return (
    Boolean(clean) &&
    SHELL_NOISE_PATTERNS.some((pattern) => pattern.test(clean))
  );
}

export function safeRegex(source: string | null | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/**
 * A silenced-pattern match. A pattern WITHOUT a backslash is a plain
 * substring (what the "silence this line" button stores); one with a
 * backslash is treated as a regex, falling back to substring when it does
 * not compile. `renderer/logs.ts` mirrors this heuristic.
 */
export function matchesPattern(pattern: string, cleaned: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes('\\')) return cleaned.includes(pattern);
  const regex = safeRegex(pattern);
  return regex ? regex.test(cleaned) : cleaned.includes(pattern);
}
