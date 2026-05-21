const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

let cachedPath = null;

function loadShellPath() {
  if (cachedPath !== null) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execSync(`${shell} -ilc 'printf %s "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    cachedPath = trimmed || process.env.PATH || '';
  } catch (_) {
    cachedPath = process.env.PATH || '';
  }
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

module.exports = { loadShellPath, expandTilde, enhancedEnv };
