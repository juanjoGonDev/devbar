import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkLauncher,
  main,
  type InstallContext,
  type LaunchApp,
  type ProbeProcess,
  type ProbeResult,
} from '../scripts/install-local.js';

/**
 * The install half: replacing the install directory and relaunching. It
 * runs against REAL directories under the OS temp dir — the copy, the
 * removal and the launcher symlink are the behaviour under test, so faking
 * the filesystem would test nothing — but never against a real install
 * location, and the app is never actually launched.
 */

class InstallAborted extends Error {
  constructor(readonly code: number) {
    super(`install aborted with code ${code}`);
  }
}

/** Nothing is running: `pgrep`/`tasklist` answer like a match that found
 *  nothing (nonzero status, empty output). The Windows dev-instance probe
 *  is inverted — its script exits 1 when it FINDS one — so a quiet machine
 *  answers 0 there. */
const NOTHING_MATCHED: ProbeResult = { status: 1, stdout: '' };
const NOTHING_RUNNING: ProbeProcess = (cmd) =>
  cmd === 'powershell' ? { status: 0, stdout: '' } : NOTHING_MATCHED;

function fakeLauncher() {
  const calls: {
    appPath: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }[] = [];
  const handlers: { error?: (error: Error) => void; spawn?: () => void } = {};
  const state = { unrefs: 0 };
  const launch: LaunchApp = (appPath, args, options) => {
    calls.push({
      appPath,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
    });
    return {
      onError: (listener) => {
        handlers.error = listener;
      },
      onSpawn: (listener) => {
        handlers.spawn = listener;
      },
      unref: () => {
        state.unrefs += 1;
      },
    };
  };
  return {
    launch,
    calls,
    state,
    confirmSpawn: () => handlers.spawn?.(),
    reportError: (error: Error) => handlers.error?.(error),
  };
}

describe('scripts/install-local.ts', () => {
  let workDir: string;
  let home: string;
  let root: string;
  let unpackedDir: string;
  let installDir: string;
  let logged: string[];
  let errored: string[];
  let steps: string[][];
  let launcher: ReturnType<typeof fakeLauncher>;
  let previousExitCode: typeof process.exitCode;

  const EXECUTABLE = 'devbar';

  /** A context whose stop waves are no-ops and whose build/launch steps are
   *  recorded instead of performed. */
  function context(overrides: Partial<InstallContext> = {}): InstallContext {
    return {
      platform: 'linux',
      root,
      home,
      installDir,
      unpackedDir,
      executable: EXECUTABLE,
      dev: false,
      noBuild: true,
      launchArgs: [],
      env: { PATH: '/usr/bin' },
      probe: NOTHING_RUNNING,
      wait: () => {},
      processIdentity: () => 'starttime:1234',
      groupAlive: () => false,
      runStep: (cmd, args) => {
        steps.push([cmd, ...args]);
      },
      launch: launcher.launch,
      fail: (code) => {
        throw new InstallAborted(code);
      },
      ...overrides,
    };
  }

  /** A packaged output with a nested file, so a copy that is not recursive
   *  is visible. */
  function packApp(): void {
    mkdirSync(path.join(unpackedDir, 'resources'), { recursive: true });
    writeFileSync(path.join(unpackedDir, EXECUTABLE), '#!/bin/sh\n');
    writeFileSync(path.join(unpackedDir, 'resources', 'app.asar'), 'payload');
  }

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'devbar-install-local-'));
    home = path.join(workDir, 'home');
    root = path.join(workDir, 'repo');
    unpackedDir = path.join(root, 'dist', 'electron-builder', 'linux-unpacked');
    installDir = path.join(home, '.local', 'share', 'DevBar');
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    logged = [];
    errored = [];
    steps = [];
    launcher = fakeLauncher();
    previousExitCode = process.exitCode;
    vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errored.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // main() reports a failed relaunch through process.exitCode; leaving it
    // set would fail the whole suite.
    process.exitCode = previousExitCode;
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('linkLauncher', () => {
    it('symlinks ~/.local/bin/devbar at the installed executable', () => {
      mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      const launcherPath = linkLauncher(context());
      expect(launcherPath).toBe(path.join(home, '.local', 'bin', 'devbar'));
      expect(readlinkSync(launcherPath as string)).toBe(
        path.join(installDir, EXECUTABLE),
      );
    });

    it('replaces a launcher left by a previous install', () => {
      const binDir = path.join(home, '.local', 'bin');
      mkdirSync(binDir, { recursive: true });
      symlinkSync('/somewhere/old/devbar', path.join(binDir, 'devbar'));
      linkLauncher(context());
      expect(readlinkSync(path.join(binDir, 'devbar'))).toBe(
        path.join(installDir, EXECUTABLE),
      );
    });

    it('warns with the full path instead of creating ~/.local/bin itself', () => {
      expect(linkLauncher(context())).toBeNull();
      expect(logged.join('\n')).toContain(
        `~/.local/bin not found — launch it with: ${path.join(installDir, EXECUTABLE)}`,
      );
    });
  });

  describe('entrypoint guard', () => {
    const SCRIPT = fileURLToPath(
      new URL('../scripts/install-local.ts', import.meta.url),
    );

    it('loads under --experimental-strip-types without running an install', () => {
      // Two things at once. The module resolves its `./lib/kill-trees.ts`
      // import in strip-only mode (the reason the kill helpers used to be
      // duplicated here), and importing it runs NOTHING: without the
      // entrypoint guard this would stop processes and replace an install
      // directory. HOME/LOCALAPPDATA point at a throwaway directory so a
      // regression cannot reach the real one.
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
           process.stdout.write(typeof m.main + ',' + typeof m.killPatterns);`,
        ],
        {
          encoding: 'utf8',
          cwd: workDir,
          env: {
            ...process.env,
            HOME: workDir,
            LOCALAPPDATA: workDir,
            DEVBAR_LAUNCH_ARGS: '',
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('function,function');
      // The very first thing an install prints.
      expect(result.stderr).not.toContain('Stopping any running DevBar');
    }, 20_000);
  });

  describe('main', () => {
    it('copies the packaged output into the install location and relaunches it', () => {
      packApp();
      main(context());
      expect(existsSync(path.join(installDir, EXECUTABLE))).toBe(true);
      expect(
        readFileSync(path.join(installDir, 'resources', 'app.asar'), 'utf8'),
      ).toBe('payload');
      expect(launcher.calls).toEqual([
        {
          appPath: path.join(installDir, EXECUTABLE),
          args: [],
          cwd: installDir,
          env: { PATH: '/usr/bin' },
        },
      ]);
    });

    it('unrefs only once the relaunch is CONFIRMED, then reports success', () => {
      packApp();
      main(context());
      expect(launcher.state.unrefs).toBe(0);
      launcher.confirmSpawn();
      expect(launcher.state.unrefs).toBe(1);
      expect(logged).toContain('✓ Installed and launched');
      expect(logged).toContain('✓ Tail logs with: pnpm logs');
    });

    it('reports a relaunch that never started instead of claiming success', () => {
      packApp();
      main(context());
      launcher.reportError(new Error('ENOENT'));
      expect(process.exitCode).toBe(1);
      expect(errored.join('\n')).toContain(
        `failed to launch ${path.join(installDir, EXECUTABLE)}: ENOENT`,
      );
      expect(logged).not.toContain('✓ Installed and launched');
    });

    it('wipes a previous install instead of merging into it', () => {
      packApp();
      mkdirSync(installDir, { recursive: true });
      writeFileSync(path.join(installDir, 'stale-from-old-version'), 'x');
      main(context());
      expect(existsSync(path.join(installDir, 'stale-from-old-version'))).toBe(
        false,
      );
      expect(existsSync(path.join(installDir, EXECUTABLE))).toBe(true);
    });

    it('aborts --no-build without touching the install when nothing was packaged', () => {
      // The abort has to come BEFORE the rmSync, or a mistyped flag wipes a
      // working install and replaces it with nothing.
      mkdirSync(installDir, { recursive: true });
      writeFileSync(path.join(installDir, 'previous-install'), 'x');
      expect(() => main(context())).toThrow(InstallAborted);
      expect(existsSync(path.join(installDir, 'previous-install'))).toBe(true);
      expect(errored.join('\n')).toContain(
        `--no-build: no packaged app at ${unpackedDir}`,
      );
    });

    it('builds and then packages for the host when --no-build is absent', () => {
      packApp();
      main(context({ noBuild: false }));
      expect(steps).toEqual([
        [process.execPath, '--experimental-strip-types', 'scripts/build.ts'],
        [
          process.execPath,
          '--experimental-strip-types',
          'scripts/package-win-linux.ts',
          'linux',
          'dir',
        ],
      ]);
    });

    it('packages the win target on Windows', () => {
      packApp();
      main(context({ noBuild: false, platform: 'win32' }));
      expect(steps[1]).toContain('win');
      expect(steps[1]).not.toContain('linux');
    });

    it('aborts when the packaging step produced no executable', () => {
      mkdirSync(unpackedDir, { recursive: true });
      expect(() => main(context({ noBuild: false }))).toThrow(InstallAborted);
      expect(errored.join('\n')).toContain(
        `packaged executable not found at ${path.join(unpackedDir, EXECUTABLE)}`,
      );
      expect(existsSync(installDir)).toBe(false);
    });

    it('stops the running app BEFORE the fallible build step', () => {
      // If the build aborts first, a surviving instance is left holding the
      // single-instance lock with no forced cleanup behind it.
      packApp();
      const order: string[] = [];
      main(
        context({
          noBuild: false,
          probe: (cmd, args) => {
            order.push(`probe:${cmd}`);
            return NOTHING_RUNNING(cmd, args);
          },
          runStep: (_cmd, args) => {
            order.push(`step:${args[1]}`);
          },
        }),
      );
      expect(order[0]).toBe('probe:pgrep');
      expect(order.filter((entry) => entry.startsWith('step:'))).toEqual([
        'step:scripts/build.ts',
        'step:scripts/package-win-linux.ts',
      ]);
      expect(order.indexOf('step:scripts/build.ts')).toBeGreaterThan(
        order.lastIndexOf('probe:pgrep'),
      );
    });

    it('turns the dev panel on for --dev, and leaves it off otherwise', () => {
      packApp();
      main(context({ dev: true }));
      expect(launcher.calls[0]?.env).toEqual({
        PATH: '/usr/bin',
        DEVBAR_DEV_PANEL: '1',
      });
      launcher.confirmSpawn();
      expect(logged).toContain('✓ Installed (dev panel enabled) and launched');
    });

    it('never sets DEVBAR_DEV_PANEL on a normal install', () => {
      packApp();
      main(context());
      expect(launcher.calls[0]?.env).not.toHaveProperty('DEVBAR_DEV_PANEL');
    });

    it('forwards DEVBAR_LAUNCH_ARGS to the relaunched app', () => {
      packApp();
      main(context({ launchArgs: ['--no-sandbox'] }));
      expect(launcher.calls[0]?.args).toEqual(['--no-sandbox']);
    });

    it('reports the launcher path it created on Linux', () => {
      packApp();
      mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      main(context());
      launcher.confirmSpawn();
      expect(logged).toContain(
        `✓ Launcher: ${path.join(home, '.local', 'bin', 'devbar')}`,
      );
    });

    it('creates no ~/.local/bin launcher on Windows', () => {
      packApp();
      mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      main(context({ platform: 'win32' }));
      launcher.confirmSpawn();
      expect(existsSync(path.join(home, '.local', 'bin', 'devbar'))).toBe(
        false,
      );
      expect(logged.join('\n')).not.toContain('Launcher:');
    });
  });
});
