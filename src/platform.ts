/**
 * Process-platform helpers. One place to branch on the host OS so the rest of
 * the codebase never compares `process.platform` strings directly.
 */
export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/**
 * The interactive shell a user's services run under. macOS keeps its
 * historical default (zsh); Linux uses whatever the user's `$SHELL` says with
 * a bash fallback; Windows has no login shell — commands run through
 * `cmd.exe`.
 */
export function userShell(): string {
  if (isWin) return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
}

/**
 * Human-readable platform label for UI copy and log lines.
 */
export function platformLabel(): 'macos' | 'win' | 'linux' {
  if (isWin) return 'win';
  if (isLinux) return 'linux';
  return 'macos';
}
