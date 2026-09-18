/**
 * Process-platform helpers. One place to branch on the host OS so the rest of
 * the codebase never compares `process.platform` strings directly.
 */
export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/**
 * The interactive shell a user's services run under. On macOS AND Linux
 * alike `$SHELL` wins — that is the shell whose rc files the user's own
 * terminal loads, which is the whole point of running services under it.
 * The per-OS default applies only when `$SHELL` is unset or empty: zsh on
 * macOS (the system default since Catalina), bash on Linux. Windows has no
 * login shell — commands run through `cmd.exe` (`ComSpec`).
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
