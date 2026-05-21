const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { expandTilde } = require('./path-helper');

/**
 * Watches `.git/HEAD` of each configured repo to detect external branch
 * changes (e.g. `git checkout` from VSCode or terminal). Uses
 * `fs.watchFile` (stat polling) because git rewrites HEAD atomically and
 * `fs.watch` loses its handle on inode change.
 */
class RepoWatcher extends EventEmitter {
  constructor() {
    super();
    this.watched = new Map(); // expanded repoPath → { headPath, listener }
  }

  /** Reconcile the set of watched repos with the new list. */
  sync(repoPaths) {
    const seen = new Set();
    for (const raw of repoPaths || []) {
      if (!raw) continue;
      const repo = expandTilde(raw);
      seen.add(repo);
      if (!this.watched.has(repo)) this.startWatching(repo);
    }
    for (const repo of [...this.watched.keys()]) {
      if (!seen.has(repo)) this.stopWatching(repo);
    }
  }

  startWatching(repoPath) {
    const headPath = path.join(repoPath, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) {
      // .git might be a file (worktree) or repo not present yet — skip.
      return;
    }
    const listener = (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        this.emit('change', repoPath);
      }
    };
    try {
      fs.watchFile(headPath, { interval: 1500 }, listener);
      this.watched.set(repoPath, { headPath, listener });
    } catch (_) {
      // ignore — not fatal
    }
  }

  stopWatching(repoPath) {
    const entry = this.watched.get(repoPath);
    if (!entry) return;
    try {
      fs.unwatchFile(entry.headPath, entry.listener);
    } catch (_) {}
    this.watched.delete(repoPath);
  }

  closeAll() {
    for (const repo of [...this.watched.keys()]) this.stopWatching(repo);
  }
}

module.exports = { RepoWatcher };
