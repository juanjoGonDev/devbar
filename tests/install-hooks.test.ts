import { describe, expect, it } from 'vitest';
import {
  installHooks,
  type HookRunOptions,
  type InstallHooksDeps,
} from '../scripts/install-hooks.js';

/**
 * `postinstall` runs on every `pnpm install`, including the ones where hooks
 * must NOT be installed: CI checkouts, production installs and a consumer's
 * unpacked tarball (no .git at all). A wrong skip either breaks an install
 * or silently leaves a developer with no hooks, so every branch is pinned.
 */

interface RunCall {
  command: string;
  args: string[];
  options: HookRunOptions;
}

interface Outcome {
  code: number | null;
  calls: RunCall[];
  existsChecks: string[];
}

function install(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    hasGitDir?: boolean;
    gitStatus?: number | null;
    lefthookStatus?: number | null;
  } = {},
): Outcome {
  const calls: RunCall[] = [];
  const existsChecks: string[] = [];
  const deps: InstallHooksDeps = {
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    exists: (target) => {
      existsChecks.push(target);
      return options.hasGitDir ?? true;
    },
    run: (command, args, runOptions) => {
      calls.push({ command, args, options: runOptions });
      // `??` is wrong here: `null` is a meaningful scripted status (a child
      // killed by a signal), not "the test did not say".
      const scripted =
        command === 'git' ? options.gitStatus : options.lefthookStatus;
      return { status: scripted === undefined ? 0 : scripted };
    },
  };
  return { code: installHooks(deps), calls, existsChecks };
}

describe('scripts/install-hooks.ts', () => {
  describe('skips', () => {
    it('skips when SKIP_GIT_HOOKS is set', () => {
      const outcome = install({ env: { SKIP_GIT_HOOKS: 'true' } });
      expect(outcome.code).toBeNull();
      expect(outcome.calls).toEqual([]);
    });

    it('skips on CI', () => {
      const outcome = install({ env: { CI: 'true' } });
      expect(outcome.code).toBeNull();
      expect(outcome.calls).toEqual([]);
    });

    it('skips a production install', () => {
      const outcome = install({ env: { NODE_ENV: 'production' } });
      expect(outcome.code).toBeNull();
      expect(outcome.calls).toEqual([]);
    });

    it('skips where there is no .git (a consumer unpacking the tarball)', () => {
      const outcome = install({ hasGitDir: false });
      expect(outcome.code).toBeNull();
      expect(outcome.calls).toEqual([]);
      expect(outcome.existsChecks).toEqual(['.git']);
    });

    it('does NOT skip on SKIP_GIT_HOOKS=false', () => {
      // The opt-out is an exact 'true'; anything else is a developer who
      // wants their hooks.
      const outcome = install({ env: { SKIP_GIT_HOOKS: 'false' } });
      expect(outcome.code).toBe(0);
      expect(outcome.calls.map((call) => call.command)).toEqual([
        'git',
        'lefthook',
      ]);
    });

    it('does NOT skip a development install', () => {
      const outcome = install({ env: { NODE_ENV: 'development' } });
      expect(outcome.calls.map((call) => call.command)).toEqual([
        'git',
        'lefthook',
      ]);
    });
  });

  describe('git probe', () => {
    it('probes git before touching lefthook', () => {
      const outcome = install({});
      expect(outcome.calls[0]).toEqual({
        command: 'git',
        args: ['--version'],
        options: { stdio: 'ignore', shell: false },
      });
    });

    it('gives up quietly when git is not installed', () => {
      // No git means no hooks to install — and no failed install either.
      const outcome = install({ gitStatus: 1 });
      expect(outcome.code).toBeNull();
      expect(outcome.calls.map((call) => call.command)).toEqual(['git']);
    });

    it('gives up quietly when the git probe is killed by a signal', () => {
      const outcome = install({ gitStatus: null });
      expect(outcome.code).toBeNull();
      expect(outcome.calls.map((call) => call.command)).toEqual(['git']);
    });
  });

  describe('lefthook install', () => {
    it('installs the hooks with inherited stdio', () => {
      const outcome = install({});
      expect(outcome.calls[1]).toEqual({
        command: 'lefthook',
        args: ['install'],
        options: { stdio: 'inherit', shell: false },
      });
    });

    it('reports success as 0', () => {
      expect(install({ lefthookStatus: 0 }).code).toBe(0);
    });

    it('propagates the exact failure code', () => {
      expect(install({ lefthookStatus: 3 }).code).toBe(3);
    });

    it('turns a signal kill (null status) into a failure', () => {
      // `process.exitCode = null` would report SUCCESS for an install that
      // never happened.
      expect(install({ lefthookStatus: null }).code).toBe(1);
    });
  });

  describe('shell resolution', () => {
    it('uses a shell on Windows (git.cmd / lefthook.cmd are not binaries)', () => {
      const outcome = install({ platform: 'win32' });
      expect(outcome.calls.map((call) => call.options.shell)).toEqual([
        true,
        true,
      ]);
    });

    it('does not interpose a shell on Linux', () => {
      const outcome = install({ platform: 'linux' });
      expect(outcome.calls.map((call) => call.options.shell)).toEqual([
        false,
        false,
      ]);
    });

    it('does not interpose a shell on macOS', () => {
      const outcome = install({ platform: 'darwin' });
      expect(outcome.calls.map((call) => call.options.shell)).toEqual([
        false,
        false,
      ]);
    });
  });
});
