import { describe, expect, it } from 'vitest';
import { dispatch, USAGE, type DispatchDeps } from '../scripts/platform.js';

/**
 * scripts/platform.ts is the OS routing table behind `pnpm pack|dist|verify|
 * install-local`. Getting an entry wrong does not fail loudly — it builds the
 * wrong artifact, or runs the macOS pipeline on a machine that has no
 * codesign. These tests pin the exact script and argument list for every
 * (command, platform) pair.
 *
 * `fail` here RECORDS instead of throwing, on purpose: in production it calls
 * process.exit, and a routing branch that relied on that to stop would run
 * the build anyway if the exit ever became non-fatal. Recording makes each
 * "must not run" assertion real.
 */

type Call =
  | { kind: 'bash'; script: string }
  | { kind: 'node'; script: string; args: string[] }
  | { kind: 'fail'; message: string };

function route(
  command: string | undefined,
  platform: string,
  options: { isDev?: boolean; extraArgs?: string[] } = {},
): Call[] {
  const calls: Call[] = [];
  const deps: DispatchDeps = {
    platform,
    isDev: options.isDev ?? false,
    extraArgs: options.extraArgs ?? [],
    runBash: (script) => {
      calls.push({ kind: 'bash', script });
    },
    runNode: (script, args = []) => {
      calls.push({ kind: 'node', script, args });
    },
    fail: (message) => {
      calls.push({ kind: 'fail', message });
    },
  };
  dispatch(command, deps);
  return calls;
}

const UNSUPPORTED = (platform: string): Call => ({
  kind: 'fail',
  message: `unsupported platform: ${platform} — expected darwin, win32 or linux`,
});

describe('scripts/platform.ts', () => {
  describe('no command', () => {
    it('prints the usage and routes nothing', () => {
      expect(route(undefined, 'darwin')).toEqual([
        { kind: 'fail', message: USAGE },
      ]);
    });

    it('names every command it accepts', () => {
      expect(USAGE).toBe(
        'usage: platform.ts <pack|dist|verify|dist:mac|install-local> [--dev]',
      );
    });
  });

  describe('unknown command', () => {
    it('refuses it by name and runs nothing', () => {
      expect(route('publish', 'darwin')).toEqual([
        {
          kind: 'fail',
          message:
            'unknown command: publish — expected pack|dist|verify|dist:mac|install-local',
        },
      ]);
    });
  });

  describe('pack', () => {
    it('runs the bash packager on macOS', () => {
      expect(route('pack', 'darwin')).toEqual([
        { kind: 'bash', script: 'package-macos-app.sh' },
      ]);
    });

    it('asks electron-builder for an unpacked win dir on Windows', () => {
      expect(route('pack', 'win32')).toEqual([
        {
          kind: 'node',
          script: 'scripts/package-win-linux.ts',
          args: ['win', 'dir'],
        },
      ]);
    });

    it('asks electron-builder for an unpacked linux dir on Linux', () => {
      expect(route('pack', 'linux')).toEqual([
        {
          kind: 'node',
          script: 'scripts/package-win-linux.ts',
          args: ['linux', 'dir'],
        },
      ]);
    });

    it('rejects an OS it has no packager for', () => {
      expect(route('pack', 'freebsd')).toEqual([UNSUPPORTED('freebsd')]);
    });
  });

  describe('dist', () => {
    it('runs the bash release pipeline on macOS', () => {
      expect(route('dist', 'darwin')).toEqual([
        { kind: 'bash', script: 'build-macos-release.sh' },
      ]);
    });

    it('drops the `dir` argument on Windows (a real installer, not a dir)', () => {
      expect(route('dist', 'win32')).toEqual([
        { kind: 'node', script: 'scripts/package-win-linux.ts', args: ['win'] },
      ]);
    });

    it('drops the `dir` argument on Linux too', () => {
      expect(route('dist', 'linux')).toEqual([
        {
          kind: 'node',
          script: 'scripts/package-win-linux.ts',
          args: ['linux'],
        },
      ]);
    });

    it('rejects an OS it has no builder for', () => {
      expect(route('dist', 'aix')).toEqual([UNSUPPORTED('aix')]);
    });
  });

  describe('dist:mac', () => {
    it('runs the macOS release pipeline on macOS', () => {
      expect(route('dist:mac', 'darwin')).toEqual([
        { kind: 'bash', script: 'build-macos-release.sh' },
      ]);
    });

    it('refuses to run the macOS pipeline anywhere else, and runs NOTHING', () => {
      // The guard must stop dispatch by itself: `fail` records here instead
      // of exiting, so a missing stop would show up as a bash call.
      const calls = route('dist:mac', 'linux');
      expect(calls).toEqual([
        {
          kind: 'fail',
          message:
            'dist:mac builds macOS release artifacts and requires macOS — on this OS use `pnpm dist`',
        },
      ]);
    });

    it('refuses on Windows as well', () => {
      expect(route('dist:mac', 'win32').map((call) => call.kind)).toEqual([
        'fail',
      ]);
    });
  });

  describe('verify', () => {
    it('runs the bash verifier on macOS', () => {
      expect(route('verify', 'darwin')).toEqual([
        { kind: 'bash', script: 'verify-macos-release.sh' },
      ]);
    });

    it('runs the COMPILED win verifier (build/, not scripts/)', () => {
      expect(route('verify', 'win32')).toEqual([
        {
          kind: 'node',
          script: 'build/scripts/verify-win-release.js',
          args: [],
        },
      ]);
    });

    it('runs the COMPILED linux verifier', () => {
      expect(route('verify', 'linux')).toEqual([
        {
          kind: 'node',
          script: 'build/scripts/verify-linux-release.js',
          args: [],
        },
      ]);
    });

    it('rejects an OS it has no verifier for', () => {
      expect(route('verify', 'sunos')).toEqual([UNSUPPORTED('sunos')]);
    });
  });

  describe('install-local', () => {
    it('runs the bash installer on macOS and registers no launcher', () => {
      // The macOS bundle IS the OS integration; register-launcher is only
      // for the unpacked win/linux copies.
      expect(route('install-local', 'darwin')).toEqual([
        { kind: 'bash', script: 'install-local.sh' },
      ]);
    });

    it('installs then registers the launcher on Windows, in that order', () => {
      expect(route('install-local', 'win32')).toEqual([
        { kind: 'node', script: 'scripts/install-local.ts', args: [] },
        { kind: 'node', script: 'scripts/register-launcher.ts', args: [] },
      ]);
    });

    it('installs then registers the launcher on Linux too', () => {
      expect(route('install-local', 'linux')).toEqual([
        { kind: 'node', script: 'scripts/install-local.ts', args: [] },
        { kind: 'node', script: 'scripts/register-launcher.ts', args: [] },
      ]);
    });

    it('forwards --dev to the installer only', () => {
      expect(route('install-local', 'linux', { isDev: true })).toEqual([
        { kind: 'node', script: 'scripts/install-local.ts', args: ['--dev'] },
        { kind: 'node', script: 'scripts/register-launcher.ts', args: [] },
      ]);
    });

    it('forwards the extra flags after --dev, in order', () => {
      expect(
        route('install-local', 'win32', {
          isDev: true,
          extraArgs: ['--no-build', '--quiet'],
        }),
      ).toEqual([
        {
          kind: 'node',
          script: 'scripts/install-local.ts',
          args: ['--dev', '--no-build', '--quiet'],
        },
        { kind: 'node', script: 'scripts/register-launcher.ts', args: [] },
      ]);
    });

    it('forwards the extra flags without --dev when it was not passed', () => {
      expect(
        route('install-local', 'linux', { extraArgs: ['--no-build'] }),
      ).toEqual([
        {
          kind: 'node',
          script: 'scripts/install-local.ts',
          args: ['--no-build'],
        },
        { kind: 'node', script: 'scripts/register-launcher.ts', args: [] },
      ]);
    });

    it('forwards --dev twice for the real `pnpm install-local:dev` argv', () => {
      // `isDev` is derived from the same argv `extraArgs` is sliced out of,
      // so on the real command line --dev is in BOTH. install-local.ts reads
      // its flags with argv.includes, which makes the repeat harmless — this
      // pins that it stays harmless rather than pretending it cannot happen.
      expect(
        route('install-local', 'linux', {
          isDev: true,
          extraArgs: ['--dev'],
        }),
      ).toEqual([
        {
          kind: 'node',
          script: 'scripts/install-local.ts',
          args: ['--dev', '--dev'],
        },
        { kind: 'node', script: 'scripts/register-launcher.ts', args: [] },
      ]);
    });

    it('rejects an OS it has no installer for', () => {
      expect(route('install-local', 'openbsd')).toEqual([
        UNSUPPORTED('openbsd'),
      ]);
    });
  });
});
