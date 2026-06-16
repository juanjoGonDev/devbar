const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

let cachedPath = null;

// Standard macOS/Homebrew binary directories that MUST be reachable by any
// command we spawn. When DevBar is launched from Finder/launchd (not a
// terminal), the PATH we recover via `$SHELL -ilc` can be missing some of
// these — most notably `/usr/local/bin`, where Docker Desktop symlinks its
// CLI and credential helpers (docker, docker-credential-desktop, …). A
// missing dir there means a spawned `docker` (or any tool living there)
// silently becomes "command not found". We append (never reorder) any of
// these that are absent so they're always resolvable, without disturbing
// the precedence of the user's own entries.
const STANDARD_PATH_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/**
 * Return `pathStr` with any missing STANDARD_PATH_DIRS appended at the end.
 * Existing entries keep their order and precedence; only absent standard
 * dirs are added. Pure + synchronous so it can be unit-tested without a shell.
 *
 * @param {string} pathStr a ':'-separated PATH value
 * @returns {string}
 */
function ensureStandardPaths(pathStr) {
  const existing = (pathStr || '').split(':').filter(Boolean);
  const seen = new Set(existing);
  const missing = STANDARD_PATH_DIRS.filter((dir) => !seen.has(dir));
  return [...existing, ...missing].join(':');
}

function loadShellPath() {
  if (cachedPath !== null) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  let base;
  try {
    const out = execSync(`${shell} -ilc 'printf %s "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    base = trimmed || process.env.PATH || '';
  } catch (_) {
    base = process.env.PATH || '';
  }
  cachedPath = ensureStandardPaths(base);
  return cachedPath;
}

function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function enhancedEnv(extra = {}) {
  const PATH = loadShellPath();
  return {
    ...process.env,
    PATH,
    POWERLEVEL9K_INSTANT_PROMPT: 'quiet',
    POWERLEVEL9K_DISABLE_GITSTATUS: 'true',
    GITSTATUS_AUTO_INSTALL: '0',
    ...extra,
  };
}

module.exports = { loadShellPath, expandTilde, enhancedEnv, ensureStandardPaths };
