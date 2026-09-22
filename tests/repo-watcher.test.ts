import fs, { type StatsListener } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RepoWatcher } from '../src/repo-watcher.js';

/**
 * `fs.watchFile` polls on a 1.5s interval, so waiting for a real event would
 * make the suite slow and timing-dependent. Instead `watchFile`/`unwatchFile`
 * are spied: the test captures the listener the watcher registers and calls it
 * with the two stat snapshots node would pass, which is what actually decides
 * whether a change is emitted.
 */

const temporaryDirectories: string[] = [];
const watchers: RepoWatcher[] = [];
let registered: { file: string; listener: StatsListener }[] = [];
let unwatched: { file: string; listener: StatsListener }[] = [];

function makeRepo(withGit = true): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-repo-'));
  temporaryDirectories.push(directory);
  if (withGit) {
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.git', 'HEAD'), 'ref: main\n');
  }
  return directory;
}

function watcher(): RepoWatcher {
  const created = new RepoWatcher();
  watchers.push(created);
  return created;
}

function snapshot(mtimeMs: number, size: number): fs.Stats {
  return { mtimeMs, size } as fs.Stats;
}

describe('src/repo-watcher.ts', () => {
  beforeEach(() => {
    registered = [];
    unwatched = [];
    vi.spyOn(fs, 'watchFile').mockImplementation(((
      file: fs.PathLike,
      _options: unknown,
      listener: StatsListener,
    ) => {
      registered.push({ file: String(file), listener });
      return undefined as unknown as fs.StatWatcher;
    }) as unknown as typeof fs.watchFile);
    vi.spyOn(fs, 'unwatchFile').mockImplementation(((
      file: fs.PathLike,
      listener: StatsListener,
    ) => {
      unwatched.push({ file: String(file), listener });
    }) as unknown as typeof fs.unwatchFile);
  });

  afterEach(() => {
    while (watchers.length) watchers.pop()?.closeAll();
    vi.restoreAllMocks();
    while (temporaryDirectories.length) {
      const directory = temporaryDirectories.pop();
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('sync', () => {
    it('watches the HEAD file of a repository', () => {
      const repo = makeRepo();
      watcher().sync([repo]);
      expect(registered.map((entry) => entry.file)).toEqual([
        path.join(repo, '.git', 'HEAD'),
      ]);
    });

    it('does not register a second listener for a path it already watches', () => {
      const repo = makeRepo();
      const subject = watcher();
      subject.sync([repo]);
      subject.sync([repo, repo]);
      expect(registered).toHaveLength(1);
    });

    it('ignores a directory with no .git/HEAD', () => {
      watcher().sync([makeRepo(false)]);
      expect(registered).toEqual([]);
    });

    it('skips empty entries rather than watching the process directory', () => {
      watcher().sync(['', '']);
      expect(registered).toEqual([]);
    });

    it('unwatches a repository that dropped out of the list', () => {
      const first = makeRepo();
      const second = makeRepo();
      const subject = watcher();
      subject.sync([first, second]);
      subject.sync([second]);
      expect(unwatched.map((entry) => entry.file)).toEqual([
        path.join(first, '.git', 'HEAD'),
      ]);
      // The surviving repo keeps the listener it already had.
      expect(registered).toHaveLength(2);
    });

    it('keeps watching when the same paths are synced again', () => {
      const repo = makeRepo();
      const subject = watcher();
      subject.sync([repo]);
      subject.sync([repo]);
      expect(unwatched).toEqual([]);
    });

    it('survives a watchFile that throws', () => {
      vi.mocked(fs.watchFile).mockImplementation(() => {
        throw new Error('EMFILE');
      });
      const repo = makeRepo();
      const subject = watcher();
      expect(() => subject.sync([repo])).not.toThrow();
      // Nothing was recorded, so the failed watch is not later unwatched.
      subject.sync([]);
      expect(unwatched).toEqual([]);
    });
  });

  describe('change detection', () => {
    function listenerFor(repo: string): StatsListener {
      const entry = registered.find(
        (candidate) => candidate.file === path.join(repo, '.git', 'HEAD'),
      );
      if (!entry) throw new Error('no listener registered');
      return entry.listener;
    }

    it('emits the repository path when the HEAD mtime moved', () => {
      const repo = makeRepo();
      const subject = watcher();
      const changes: string[] = [];
      subject.on('change', (changed) => changes.push(changed));
      subject.sync([repo]);
      listenerFor(repo)(snapshot(200, 40), snapshot(100, 40));
      expect(changes).toEqual([repo]);
    });

    it('emits when only the size moved', () => {
      const repo = makeRepo();
      const subject = watcher();
      const changes: string[] = [];
      subject.on('change', (changed) => changes.push(changed));
      subject.sync([repo]);
      listenerFor(repo)(snapshot(100, 41), snapshot(100, 40));
      expect(changes).toEqual([repo]);
    });

    it('stays quiet when the poll saw no difference', () => {
      // watchFile fires on every interval, changed or not: without this
      // guard every repository would report a branch change twice a second.
      const repo = makeRepo();
      const subject = watcher();
      const changes: string[] = [];
      subject.on('change', (changed) => changes.push(changed));
      subject.sync([repo]);
      listenerFor(repo)(snapshot(100, 40), snapshot(100, 40));
      expect(changes).toEqual([]);
    });

    it('reports the repository path, not the HEAD file it watches', () => {
      const repo = makeRepo();
      const subject = watcher();
      const changes: string[] = [];
      subject.on('change', (changed) => changes.push(changed));
      subject.sync([repo]);
      listenerFor(repo)(snapshot(2, 1), snapshot(1, 1));
      expect(changes[0]).toBe(repo);
      expect(changes[0]).not.toContain('.git');
    });
  });

  describe('closeAll', () => {
    it('unwatches every repository', () => {
      const first = makeRepo();
      const second = makeRepo();
      const subject = watcher();
      subject.sync([first, second]);
      subject.closeAll();
      expect(unwatched.map((entry) => entry.file).sort()).toEqual(
        [
          path.join(first, '.git', 'HEAD'),
          path.join(second, '.git', 'HEAD'),
        ].sort(),
      );
    });

    it('leaves the watcher reusable', () => {
      const repo = makeRepo();
      const subject = watcher();
      subject.sync([repo]);
      subject.closeAll();
      subject.sync([repo]);
      expect(registered).toHaveLength(2);
    });

    it('survives an unwatchFile that throws', () => {
      const repo = makeRepo();
      const subject = watcher();
      subject.sync([repo]);
      vi.mocked(fs.unwatchFile).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => subject.closeAll()).not.toThrow();
      // The entry is dropped anyway, so a later sync re-registers it.
      vi.mocked(fs.unwatchFile).mockImplementation(() => undefined);
      subject.sync([repo]);
      expect(registered).toHaveLength(2);
    });
  });
});
