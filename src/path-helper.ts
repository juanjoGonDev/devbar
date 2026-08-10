import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

let cachedPath: string | null = null;
const STANDARD_PATH_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;
export function ensureStandardPaths(
  pathString: string | null | undefined,
): string {
  const existing = (pathString ?? '').split(':').filter(Boolean);
  const seen = new Set(existing);
  return [
    ...existing,
    ...STANDARD_PATH_DIRS.filter((dir) => !seen.has(dir)),
  ].join(':');
}
export function loadShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  let base: string;
  try {
    const out = execSync(`${shell} -ilc 'printf %s "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    base = out.trim() || process.env.PATH || '';
  } catch {
    base = process.env.PATH || '';
  }
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
    POWERLEVEL9K_INSTANT_PROMPT: 'quiet',
    POWERLEVEL9K_DISABLE_GITSTATUS: 'true',
    GITSTATUS_AUTO_INSTALL: '0',
    ...extra,
  };
}
