import fs, { type StatsListener } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { expandTilde } from './path-helper.js';
interface WatchedRepo {
  headPath: string;
  listener: StatsListener;
}
interface RepoWatcherEvents {
  change: [repoPath: string];
}
export class RepoWatcher extends EventEmitter<RepoWatcherEvents> {
  private readonly watched = new Map<string, WatchedRepo>();
  sync(repoPaths: readonly string[]): void {
    const seen = new Set<string>();
    for (const raw of repoPaths) {
      if (!raw) continue;
      const repo = expandTilde(raw);
      seen.add(repo);
      if (!this.watched.has(repo)) this.startWatching(repo);
    }
    for (const repo of [...this.watched.keys()])
      if (!seen.has(repo)) this.stopWatching(repo);
  }
  private startWatching(repoPath: string): void {
    const headPath = path.join(repoPath, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return;
    const listener: StatsListener = (current, previous) => {
      if (
        current.mtimeMs !== previous.mtimeMs ||
        current.size !== previous.size
      )
        this.emit('change', repoPath);
    };
    try {
      fs.watchFile(headPath, { interval: 1500 }, listener);
      this.watched.set(repoPath, { headPath, listener });
    } catch {}
  }
  private stopWatching(repoPath: string): void {
    const entry = this.watched.get(repoPath);
    if (!entry) return;
    try {
      fs.unwatchFile(entry.headPath, entry.listener);
    } catch {}
    this.watched.delete(repoPath);
  }
  closeAll(): void {
    for (const repo of [...this.watched.keys()]) this.stopWatching(repo);
  }
}
