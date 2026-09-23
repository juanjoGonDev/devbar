import { execFileSync } from 'node:child_process';
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

/** Windows fallback dirs derived from %SystemRoot% (a Windows install is
 *  not guaranteed to live on C:). Built with win32 path semantics so the
 *  strings stay correct no matter what OS builds/tests them. */
function winStandardPathDirs(): string[] {
  const systemRoot = (process.env.SystemRoot || 'C:\\Windows').replace(
    /[/\\]+$/u,
    '',
  );
  return [
    path.win32.join(systemRoot, 'system32'),
    systemRoot,
    path.win32.join(systemRoot, 'System32', 'Wbem'),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ];
}

function standardPathDirs(): readonly string[] {
  return isWin ? winStandardPathDirs() : POSIX_STANDARD_PATH_DIRS;
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
    // execFileSync with an explicit argv: userShell() returns an executable
    // PATH, and interpolating it into an execSync command string breaks on
    // spaces or shell metacharacters (a quoted ~/.nvm/.../zsh, a $ in a
    // path) — silently leaving the user's CLIs unreachable.
    const out = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
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

/**
 * Windows environment names are case-insensitive at the OS level, but object
 * keys are not: `extra` can carry `Path` (the spelling Windows itself uses)
 * while this module writes `PATH`, and BOTH survive into the spawn env —
 * where only one of them can reach the child. A group's or target's PATH
 * override is then dropped silently, for no reason the user can see.
 *
 * Collapse every PATH-like key into one canonical `PATH`. The override wins:
 * the value the caller set LAST (spread order) becomes the base, and
 * `ensureStandardPaths` tops it up afterwards, exactly as `loadShellPath`
 * does for the inherited PATH.
 */
function collapseWindowsPath(
  env: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  let overrideKey: string | undefined;
  for (const key of Object.keys(extra))
    if (key.toUpperCase() === 'PATH') overrideKey = key;
  const value =
    overrideKey === undefined
      ? env.PATH
      : ensureStandardPaths(extra[overrideKey]);
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(env))
    if (key.toUpperCase() !== 'PATH') merged[key] = entry;
  merged.PATH = value;
  return merged;
}

/**
 * The spawn environment: the current environment, with PATH replaced by the
 * login shell's one (see `loadShellPath`).
 *
 * `extra` is for OVERRIDES ONLY — the caller's configured group/target env.
 * `process.env` is already spread in below, so a caller that spreads it into
 * `extra` as well silently reinstates the inherited PATH and defeats the whole
 * module. Deliberately NOT guarded against here: the only signal available is
 * `extra.PATH === process.env.PATH`, which is exactly what a caller that
 * legitimately wants to force the inherited PATH produces, so a guard would
 * have to break that case to catch this one.
 */
export function enhancedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
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
  return isWin ? collapseWindowsPath(env, extra) : env;
}
