import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isWin, userShell } from './platform.js';

/**
 * PATH handling for spawned services.
 *
 * A GUI-launched app inherits a reduced PATH (no user-managed dirs), which
 * makes `pnpm`/`docker`/local CLIs "not found" even though they work in the
 * user's terminal. On POSIX we recover the full PATH by asking the user's
 * own shell for it; on Windows the environment already carries the user's
 * PATH, so we only top up the system dirs.
 */
let cachedPath: string | null = null;

const POSIX_STANDARD_PATH_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

const WIN_STANDARD_PATH_DIRS = [
  'C:\\Windows\\system32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
] as const;

function standardPathDirs(): readonly string[] {
  return isWin ? WIN_STANDARD_PATH_DIRS : POSIX_STANDARD_PATH_DIRS;
}

export function ensureStandardPaths(
  pathString: string | null | undefined,
): string {
  const delimiter = isWin ? ';' : ':';
  const existing = (pathString ?? '').split(delimiter).filter(Boolean);
  const seen = new Set(existing);
  return [
    ...existing,
    ...standardPathDirs().filter((dir) => !seen.has(dir)),
  ].join(delimiter);
}

function posixShellPath(): string {
  const shell = userShell();
  try {
    const out = execSync(`${shell} -ilc 'printf %s "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

export function loadShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  // Windows: no login shell to query; the GUI environment already has the
  // user's PATH (including the per-user directories the terminal would add).
  const base = isWin
    ? process.env.PATH || ''
    : posixShellPath() || process.env.PATH || '';
  cachedPath = ensureStandardPaths(base);
  return cachedPath;
}

export function expandTilde(value: null): null;
export function expandTilde(value: undefined): undefined;
export function expandTilde(value: string): string;
export function expandTilde(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined || value === '') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function enhancedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: loadShellPath(),
    // Keep the p10k gitstatus daemon out of the captured output: it prints
    // startup noise that would otherwise land in the service logs. Inert on
    // shells that don't know these variables.
    POWERLEVEL9K_INSTANT_PROMPT: 'quiet',
    POWERLEVEL9K_DISABLE_GITSTATUS: 'true',
    GITSTATUS_AUTO_INSTALL: '0',
    ...extra,
  };
}
