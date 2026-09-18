import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  currentBranch,
  listBranches,
  switchBranch,
} from '../src/git-manager.js';

/**
 * listBranches' failure classification drives the tray branch selector:
 * only the git diagnostics that PROVE "not a repository" may set
 * isRepo: false (the UI then hides the selector with a TTL); anything
 * else must stay an unclassified operational failure. These cases are
 * exercised against the real git binary (CI images always have it).
 */
// A bare `return` inside a test body is reported by vitest as PASSED, so a
// branch that never ran looks identical to one that did — and the root case
// below is the default in many container CI images. These conditions gate the
// tests through skipIf instead, so a vanished branch shows up in the summary.
const IS_WINDOWS = process.platform === 'win32';
const IS_ROOT =
  typeof process.geteuid === 'function' && process.geteuid() === 0;

describe('listBranches failure classification', () => {
  it('a plain directory (not a git repo) is classified isRepo: false', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-notrepo-'));
    try {
      const res = await listBranches(dir);
      expect(res.ok).toBe(false);
      expect(res.isRepo).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing directory is classified isRepo: false (cannot change to…)', async () => {
    // git -C <gone> fails with "fatal: cannot change to '<path>':
    // No such file or directory" (stable in the forced C locale) — the
    // same UI verdict as a non-repo, so a deleted/renamed project folder
    // hides the selector instead of leaving it stuck on "Cargando…".
    const res = await listBranches(
      path.join(os.tmpdir(), 'devbar-does-not-exist-xyz'),
    );
    expect(res.ok).toBe(false);
    expect(res.isRepo).toBe(false);
  });

  // Skipped on Windows (0o000 does not block traversal there, so the path
  // would read as "missing" — isRepo: false — and the assertion below would
  // fail for the wrong reason) and as root (or with CAP_DAC_OVERRIDE, which
  // traverses 0o000 anyway, so the premise only holds unprivileged).
  it.skipIf(IS_WINDOWS || IS_ROOT)(
    'a permission-denied path is an operational failure, not "not a repo"',
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-noperm-'));
      const locked = path.join(base, 'locked');
      fs.mkdirSync(locked, { mode: 0o000 });
      try {
        // git -C <locked>/inner fails with "fatal: cannot change to
        // '…': Permission denied" — that diagnostic says nothing about
        // whether the folder is a repository, so no isRepo verdict.
        const res = await listBranches(path.join(locked, 'inner'));
        expect(res.ok).toBe(false);
        expect(res.isRepo).toBeUndefined();
      } finally {
        fs.chmodSync(locked, 0o755);
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('an actual repository resolves its branches', async () => {
    // The devbar checkout itself is a repository (tests run from the repo
    // root). A missing git binary is NOT an environment to skip for: every
    // test in this suite drives the real binary, and this repo's CI always
    // ships it — so assert it is there rather than returning early, which
    // vitest would report as a pass with no assertion run at all.
    expect(() =>
      execFileSync('git', ['--version'], { stdio: 'ignore' }),
    ).not.toThrow();
    const res = await listBranches(process.cwd());
    expect(res.ok).toBe(true);
    expect(res.isRepo).toBe(true);
    expect(Array.isArray(res.branches)).toBe(true);
  });
});

/**
 * `currentBranch` and `switchBranch` drive the tray's branch selector. Both
 * shell out, so they are exercised against the real binary over a throwaway
 * repository with a throwaway `origin` beside it — the only way to reach the
 * branch that exists only on the remote, and the pull that follows a checkout.
 */
describe('switching branches against a real repository', () => {
  let base: string;
  let repo: string;
  let origin: string;

  /** git with an identity of its own, so a bare CI image can still commit. */
  function git(cwd: string, ...args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c',
        'user.email=devbar@example.com',
        '-c',
        'user.name=DevBar Tests',
        '-c',
        'commit.gpgsign=false',
        '-C',
        cwd,
        ...args,
      ],
      // stderr captured too: `git push` narrates on it, and that noise would
      // otherwise land in the middle of the test report.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  function commit(message: string): void {
    fs.writeFileSync(path.join(repo, 'file.txt'), `${message}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', message);
  }

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-git-'));
    origin = path.join(base, 'origin.git');
    repo = path.join(base, 'work');
    fs.mkdirSync(origin);
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], {
      stdio: 'ignore',
    });
    git(repo, 'init', '-b', 'main');
    // Off deliberately: with git's DWIM on, `git checkout <branch>` invents a
    // local branch from a unique remote-tracking one all by itself, which
    // would hide whether the code creates it explicitly. Plenty of people run
    // with it off, and the code must not depend on it.
    git(repo, 'config', 'checkout.guess', 'false');
    commit('primero');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');
    // A branch that lives ONLY on the remote, so a checkout has to create it.
    git(repo, 'checkout', '-b', 'solo-remota');
    commit('en la remota');
    git(repo, 'push', 'origin', 'solo-remota');
    git(repo, 'checkout', 'main');
    git(repo, 'branch', '-D', 'solo-remota');
    // And one that exists locally, for the plain checkout path.
    git(repo, 'branch', 'local-y-remota');
    git(repo, 'push', 'origin', 'local-y-remota');
    // A branch that was never pushed: there is no origin/<branch> to pull,
    // which is the ordinary state of work in progress.
    git(repo, 'branch', 'solo-local');
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('currentBranch', () => {
    it('reads the branch that is checked out', async () => {
      const res = await currentBranch(repo);
      expect(res.ok).toBe(true);
      expect(res.branch).toBe('main');
    });

    it('says so when the group has no path configured at all', async () => {
      const res = await currentBranch('');
      expect(res).toEqual({ ok: false, error: 'No git repo configured' });
    });

    it('reports git failing instead of inventing a branch', async () => {
      const res = await currentBranch(
        path.join(os.tmpdir(), 'devbar-no-existe-xyz'),
      );
      expect(res.ok).toBe(false);
      expect(res.branch).toBeUndefined();
      expect(res.error).toBeTruthy();
    });
  });

  describe('listBranches', () => {
    it('lists local and remote branches once each, sorted', async () => {
      const res = await listBranches(repo);
      expect(res.ok).toBe(true);
      // `solo-remota` exists only as origin/solo-remota, `solo-local` only
      // as a local ref, and `main` exists twice and must still appear once.
      expect(res.branches).toEqual([
        'local-y-remota',
        'main',
        'solo-local',
        'solo-remota',
      ]);
    });

    it('says so when the group has no path configured at all', async () => {
      const res = await listBranches('');
      expect(res).toEqual({
        ok: false,
        isRepo: false,
        error: 'No git repo configured',
      });
    });

    it('never offers the remote itself as a branch', async () => {
      // Every `git clone` writes refs/remotes/origin/HEAD, and its SHORT name
      // is plain `origin` — indistinguishable from a branch called that. It
      // was landing in the selector, where picking it detaches HEAD.
      const clone = path.join(base, 'clon');
      execFileSync('git', ['clone', origin, clone], { stdio: 'ignore' });
      const res = await listBranches(clone);
      expect(res.ok).toBe(true);
      expect(res.branches).not.toContain('origin');
      expect(res.branches).toContain('main');
    });

    it('leaves out the remote HEAD pointer, which is not a branch', async () => {
      execFileSync(
        'git',
        ['-C', repo, 'remote', 'set-head', 'origin', 'main'],
        {
          stdio: 'ignore',
        },
      );
      const res = await listBranches(repo);
      expect(res.branches).not.toContain('HEAD');
      expect(res.branches).toContain('main');
    });
  });

  describe('switchBranch', () => {
    it('says so when the group has no path configured at all', async () => {
      const res = await switchBranch('', 'main');
      expect(res).toEqual({ ok: false, error: 'No git repo configured' });
    });

    it('says so when no branch was named', async () => {
      const res = await switchBranch(repo, '');
      expect(res).toEqual({ ok: false, error: 'No branch specified' });
    });

    it('checks out a branch that already exists locally, and pulls it', async () => {
      const res = await switchBranch(repo, 'local-y-remota');
      expect(res).toEqual({ ok: true });
      expect((await currentBranch(repo)).branch).toBe('local-y-remota');
    });

    it('switches to a branch that was never pushed', async () => {
      // The checkout succeeds and there is nothing to pull, because there is
      // no origin/solo-local. Reporting the missing remote ref as a failure
      // told the user the switch had not worked while leaving them on the
      // branch they asked for.
      const res = await switchBranch(repo, 'solo-local');
      expect(res).toEqual({ ok: true });
      expect((await currentBranch(repo)).branch).toBe('solo-local');
      await switchBranch(repo, 'main');
    });

    it('fast-forwards a branch the remote has moved past', async () => {
      // The checkout alone would leave the reader on yesterday's commit: the
      // pull is what makes "switch to this branch" mean what it says.
      const clone = path.join(base, 'clone');
      execFileSync('git', ['clone', origin, clone], { stdio: 'ignore' });
      git(clone, 'checkout', 'local-y-remota');
      fs.writeFileSync(path.join(clone, 'file.txt'), 'desde otro sitio\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-m', 'avance');
      git(clone, 'push', 'origin', 'local-y-remota');

      await switchBranch(repo, 'main');
      const res = await switchBranch(repo, 'local-y-remota');
      expect(res).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe(
        'desde otro sitio\n',
      );
    });

    it('creates a branch that only exists on the remote', async () => {
      const res = await switchBranch(repo, 'solo-remota');
      expect(res).toEqual({ ok: true });
      expect((await currentBranch(repo)).branch).toBe('solo-remota');
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe(
        'en la remota\n',
      );
    });

    it('refuses to switch over uncommitted work', async () => {
      await switchBranch(repo, 'main');
      fs.writeFileSync(path.join(repo, 'file.txt'), 'a medias\n');
      try {
        const res = await switchBranch(repo, 'local-y-remota');
        expect(res).toEqual({
          ok: false,
          error: 'Working tree has uncommitted changes — commit or stash first',
        });
        // and it really did not move
        expect((await currentBranch(repo)).branch).toBe('main');
      } finally {
        execFileSync('git', ['-C', repo, 'checkout', '--', '.'], {
          stdio: 'ignore',
        });
      }
    });

    it('switches with untracked files present, as git itself would', () => {
      // An editor folder, a scratch note, a tool's config: untracked files
      // are the ordinary state of a working copy and a checkout carries them
      // across untouched. Refusing over them blocked switching on a tree git
      // considers clean.
      const stray = path.join(repo, 'NOTES-sin-seguimiento.md');
      const strayDir = path.join(repo, '.alguna-herramienta');
      return (async () => {
        await switchBranch(repo, 'main');
        fs.writeFileSync(stray, 'apuntes\n');
        fs.mkdirSync(strayDir, { recursive: true });
        fs.writeFileSync(path.join(strayDir, 'config.json'), '{}\n');
        try {
          const res = await switchBranch(repo, 'local-y-remota');
          expect(res).toEqual({ ok: true });
          expect((await currentBranch(repo)).branch).toBe('local-y-remota');
          // And they are still there afterwards.
          expect(fs.existsSync(stray)).toBe(true);
        } finally {
          fs.rmSync(stray, { force: true });
          fs.rmSync(strayDir, { recursive: true, force: true });
          await switchBranch(repo, 'main');
        }
      })();
    });

    it('reports a branch neither side has, without moving', async () => {
      await switchBranch(repo, 'main');
      const res = await switchBranch(repo, 'no-existe-en-ningun-sitio');
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
      expect((await currentBranch(repo)).branch).toBe('main');
    });

    it('reports the failure of the dirty-check itself', async () => {
      const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-plain-'));
      try {
        const res = await switchBranch(notRepo, 'main');
        expect(res.ok).toBe(false);
        expect(res.error).toContain('not a git repository');
      } finally {
        fs.rmSync(notRepo, { recursive: true, force: true });
      }
    });

    it('reports a fetch that could not reach its remote', async () => {
      const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-lonely-'));
      try {
        execFileSync('git', ['init', '-b', 'main', lonely], {
          stdio: 'ignore',
        });
        const res = await switchBranch(lonely, 'otra');
        expect(res.ok).toBe(false);
        expect(res.error).toBeTruthy();
      } finally {
        fs.rmSync(lonely, { recursive: true, force: true });
      }
    });
  });
});
