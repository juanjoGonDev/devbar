import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stripGitEnv } from './setup/isolate-git-env.ts';

const temporaryDirectories: string[] = [];
const touchedKeys = ['GIT_DIR', 'GIT_INDEX_FILE'] as const;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

/** The same steps the suites use to build a throwaway repository. */
function newCommittedRepository(): string {
  const directory = temporaryDirectory('devbar-git-env-repo-');
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'DevBar Test');
  git(directory, 'config', 'user.email', 'devbar@example.test');
  git(directory, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(directory, 'file.txt'), 'content\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'chore: baseline');
  git(directory, 'tag', 'v1.0.0');
  return directory;
}

/** What a hook's GIT_DIR would point at: a repository that must not move. */
function snapshot(directory: string): {
  head: string;
  config: string;
  tags: string;
} {
  return {
    head: git(directory, 'rev-parse', 'HEAD'),
    config: git(directory, 'config', '--local', '--list'),
    tags: git(directory, 'tag', '--list'),
  };
}

describe('git environment isolation', () => {
  afterEach(() => {
    for (const key of touchedKeys) delete process.env[key];
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts every test file without inherited GIT_* variables', () => {
    expect(
      Object.keys(process.env).filter((key) => key.startsWith('GIT_')),
    ).toEqual([]);
  });

  it('keeps a hook-exported GIT_DIR from redirecting a throwaway repository', () => {
    const outer = temporaryDirectory('devbar-git-env-outer-');
    git(outer, 'init', '-b', 'main');
    git(
      outer,
      '-c',
      'user.name=Outer',
      '-c',
      'user.email=outer@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'outer root',
    );
    const before = snapshot(outer);

    // What lefthook's pre-push hands `pnpm quality`, and what the setup file
    // removes before the suite runs.
    process.env.GIT_DIR = join(outer, '.git');
    process.env.GIT_INDEX_FILE = join(outer, '.git', 'index');
    stripGitEnv(process.env);

    const repository = newCommittedRepository();

    expect(snapshot(outer)).toEqual(before);
    expect(git(repository, 'log', '--format=%s')).toBe('chore: baseline');
    expect(git(repository, 'tag', '--list')).toBe('v1.0.0');
  });
});
