import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORCE_POLLS,
  FORCE_POLL_MS,
  isAnyDevBarAlive,
  killLeftovers,
  killPatterns,
  killRunningInstances,
  layout,
  verifyStopped,
  VERIFY_POLLS,
  VERIFY_POLL_MS,
  windowsDevInstanceAlive,
  type ProbeProcess,
  type ProbeResult,
  type StopContext,
} from '../scripts/install-local.js';
import {
  POSIX_POST_KILL_POLL_MS,
  type ServiceGroup,
} from '../scripts/lib/kill-trees.js';

/**
 * install-local replaces the user's install directory, so everything it
 * does before that — deciding WHERE to install, killing the running
 * instance and its service trees, and proving nothing survived — has to be
 * exercisable without signalling a real process. Every probe, wait and
 * abort below is injected; nothing here reads the host process table.
 */

/** The abort the production context performs with process.exit(). */
class InstallAborted extends Error {
  constructor(readonly code: number) {
    super(`install aborted with code ${code}`);
  }
}

/** What a real `pgrep`/`tasklist` answers when nothing matched: a nonzero
 *  status and empty output — NOT a failure to run. */
const NOTHING_MATCHED: ProbeResult = { status: 1, stdout: '' };

interface Harness {
  context: StopContext;
  /** Every probed command, in order, as [cmd, ...args]. */
  calls: string[][];
  waits: number[];
}

function harness(
  options: {
    platform?: NodeJS.Platform;
    root?: string;
    installDir?: string;
    answer?: (cmd: string, args: readonly string[]) => ProbeResult | null;
    processIdentity?: (pid: string) => string | null;
    groupAlive?: (leaderPid: string) => boolean;
  } = {},
): Harness {
  const calls: string[][] = [];
  const waits: number[] = [];
  const probe: ProbeProcess = (cmd, args) => {
    calls.push([cmd, ...args]);
    return options.answer ? options.answer(cmd, args) : NOTHING_MATCHED;
  };
  return {
    calls,
    waits,
    context: {
      platform: options.platform ?? 'linux',
      root: options.root ?? '/repo',
      installDir: options.installDir ?? '/home/u/.local/share/DevBar',
      probe,
      wait: (ms) => {
        waits.push(ms);
      },
      processIdentity: options.processIdentity ?? (() => 'starttime:1234'),
      groupAlive: options.groupAlive ?? (() => false),
      fail: (code) => {
        throw new InstallAborted(code);
      },
    },
  };
}

describe('scripts/install-local.ts', () => {
  let logged: string[];
  let errored: string[];
  let localAppData: string | undefined;

  beforeEach(() => {
    logged = [];
    errored = [];
    localAppData = process.env.LOCALAPPDATA;
    vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errored.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
  });

  describe('layout', () => {
    it('installs Linux under ~/.local/share/DevBar and packs from linux-unpacked', () => {
      expect(layout('linux', '/repo', '/home/u', 'x64')).toEqual({
        unpackedDir: '/repo/dist/electron-builder/linux-unpacked',
        installDir: '/home/u/.local/share/DevBar',
        executable: 'devbar',
      });
    });

    it('reads the ARCH-SUFFIXED unpacked dir on a 64-bit Raspberry Pi', () => {
      // electron-builder writes linux-arm64-unpacked on arm64 hosts; the
      // x64 spelling does not exist there, and pointing at it made every
      // `pnpm install-local` fail after a successful build.
      expect(layout('linux', '/repo', '/home/u', 'arm64')).toEqual({
        unpackedDir: '/repo/dist/electron-builder/linux-arm64-unpacked',
        installDir: '/home/u/.local/share/DevBar',
        executable: 'devbar',
      });
    });

    it('reads the armv7l unpacked dir on 32-bit Pi OS', () => {
      expect(layout('linux', '/repo', '/home/u', 'arm')?.unpackedDir).toBe(
        '/repo/dist/electron-builder/linux-armv7l-unpacked',
      );
    });

    it('suffixes the Windows unpacked dir on Windows on ARM too', () => {
      process.env.LOCALAPPDATA = '/abs/local';
      expect(layout('win32', '/repo', '/home/u', 'arm64')?.unpackedDir).toBe(
        '/repo/dist/electron-builder/win-arm64-unpacked',
      );
      expect(layout('win32', '/repo', '/home/u', 'x64')?.unpackedDir).toBe(
        '/repo/dist/electron-builder/win-unpacked',
      );
    });

    it('installs Windows into %LOCALAPPDATA%\\Programs\\DevBar (the path the NSIS installer uses)', () => {
      process.env.LOCALAPPDATA = '/abs/local';
      expect(layout('win32', '/repo', '/home/u', 'x64')?.installDir).toBe(
        '/abs/local/Programs/DevBar',
      );
    });

    it('ignores a RELATIVE LOCALAPPDATA instead of resolving it against the CWD', () => {
      // A relative value would put the install — and the rmSync that
      // precedes it — inside the checkout while still reporting success.
      process.env.LOCALAPPDATA = 'relative/local';
      expect(layout('win32', '/repo', '/home/u')?.installDir).toBe(
        '/home/u/AppData/Local/Programs/DevBar',
      );
    });

    it('ignores an EMPTY LOCALAPPDATA (?? alone would let it through)', () => {
      process.env.LOCALAPPDATA = '';
      expect(layout('win32', '/repo', '/home/u')?.installDir).toBe(
        '/home/u/AppData/Local/Programs/DevBar',
      );
    });

    it('has no layout for darwin — that OS has its own bash pipeline', () => {
      expect(layout('darwin', '/repo', '/home/u')).toBeNull();
    });
  });

  describe('killPatterns', () => {
    it('covers the installed copy, a dist/ run and a dev run from the checkout', () => {
      expect(killPatterns('/repo', '/install')).toEqual([
        '/install',
        '/repo/dist/electron-builder',
        '/repo/node_modules/electron',
      ]);
    });

    it('escapes ERE metacharacters so a checkout path cannot over-match', () => {
      // pgrep/pkill -f take EXTENDED regexes: unescaped parens and dots in
      // a checkout path would stop matching, or match unrelated processes.
      expect(killPatterns('/tmp/my.repo (1)', '/install+dir')).toEqual([
        '/install\\+dir',
        '/tmp/my\\.repo \\(1\\)/dist/electron-builder',
        '/tmp/my\\.repo \\(1\\)/node_modules/electron',
      ]);
    });
  });

  describe('windowsDevInstanceAlive', () => {
    it('reads the probe EXIT STATUS: 1 means a dev electron.exe is alive', () => {
      const { context } = harness({
        platform: 'win32',
        answer: () => ({ status: 1, stdout: '' }),
      });
      expect(windowsDevInstanceAlive('C:\\repo', context.probe)).toBe(true);
    });

    it('status 0 means the checkout has no dev instance', () => {
      const { context } = harness({
        platform: 'win32',
        answer: () => ({ status: 0, stdout: '' }),
      });
      expect(windowsDevInstanceAlive('C:\\repo', context.probe)).toBe(false);
    });

    it('a probe that could not run at all is not evidence of a live app', () => {
      // powershell missing must not read as "alive" — that would stall
      // every install on a machine without it.
      const { context } = harness({ platform: 'win32', answer: () => null });
      expect(windowsDevInstanceAlive('C:\\repo', context.probe)).toBe(false);
    });

    it('embeds the checkout path with the PowerShell -like escaping applied', () => {
      const { context, calls } = harness({
        platform: 'win32',
        answer: () => ({ status: 0, stdout: '' }),
      });
      windowsDevInstanceAlive("C:\\o'brien\\repo", context.probe);
      const command = calls[0]?.at(-1) ?? '';
      expect(command).toContain("*C:\\o''brien\\repo*");
      // The raw path would terminate the single-quoted -like pattern and
      // inject PowerShell.
      expect(command).not.toContain("C:\\o'brien\\repo");
    });
  });

  describe('isAnyDevBarAlive', () => {
    it('sees a packaged instance in the Windows task list', () => {
      const { context, calls } = harness({
        platform: 'win32',
        answer: (cmd) =>
          cmd === 'tasklist'
            ? { status: 0, stdout: 'DevBar.exe  1234 Console' }
            : NOTHING_MATCHED,
      });
      expect(isAnyDevBarAlive(context)).toBe(true);
      // The image-name hit is conclusive: no second probe is needed.
      expect(calls.map((call) => call[0])).toEqual(['tasklist']);
    });

    it('falls back to the dev-instance probe the image name cannot see', () => {
      // `pnpm start` runs electron.exe, not DevBar.exe.
      const { context, calls } = harness({
        platform: 'win32',
        answer: (cmd) =>
          cmd === 'tasklist'
            ? { status: 0, stdout: 'INFO: No tasks are running.' }
            : { status: 1, stdout: '' },
      });
      expect(isAnyDevBarAlive(context)).toBe(true);
      expect(calls.map((call) => call[0])).toEqual(['tasklist', 'powershell']);
    });

    it('a tasklist that could not run is not evidence of a live instance', () => {
      const { context } = harness({
        platform: 'win32',
        answer: (cmd) =>
          cmd === 'tasklist' ? null : { status: 0, stdout: '' },
      });
      expect(isAnyDevBarAlive(context)).toBe(false);
    });

    it('reports a POSIX instance matched by any one of the kill patterns', () => {
      const { context } = harness({
        answer: (cmd, args) =>
          cmd === 'pgrep' && args[1] === '/repo/node_modules/electron'
            ? { status: 0, stdout: '4242\n' }
            : NOTHING_MATCHED,
        root: '/repo',
      });
      expect(isAnyDevBarAlive(context)).toBe(true);
    });

    it('never counts its own process chain as a running instance', () => {
      // A shell or editor whose command line mentions the electron path is
      // matched by pgrep -f; counting it would stall every install.
      const { context } = harness({
        answer: () => ({
          status: 0,
          stdout: `${process.pid}\n${process.ppid}\n`,
        }),
      });
      expect(isAnyDevBarAlive(context)).toBe(false);
    });

    it('still reports a real instance alongside the caller family', () => {
      const { context } = harness({
        answer: () => ({ status: 0, stdout: `${process.pid}\n777\n` }),
      });
      expect(isAnyDevBarAlive(context)).toBe(true);
    });

    it('probes the SAME patterns the kill wave targets', () => {
      // If the two lists ever diverge, a surviving instance the
      // verification cannot see passes it — and the install swaps files
      // under a live process.
      const kill = harness({ root: '/repo', installDir: '/install' });
      killRunningInstances(kill.context);
      const alive = harness({ root: '/repo', installDir: '/install' });
      isAnyDevBarAlive(alive.context);
      const pgrepPatterns = (calls: string[][]): string[] =>
        calls.filter((call) => call[0] === 'pgrep').map((call) => call[2]);
      expect(pgrepPatterns(alive.calls)).toEqual(pgrepPatterns(kill.calls));
      expect(pgrepPatterns(alive.calls)).toEqual(
        killPatterns('/repo', '/install'),
      );
    });
  });

  describe('verifyStopped', () => {
    it('returns without waiting when nothing is running', () => {
      const { context, waits } = harness();
      verifyStopped(context);
      expect(waits).toEqual([]);
      expect(logged).toEqual([]);
    });

    it('stops polling as soon as the instance goes away', () => {
      let probes = 0;
      const { context, waits } = harness({
        answer: () => {
          probes += 1;
          // Alive for the first two rounds (one pattern each, because the
          // first pattern already answers), then gone.
          return probes <= 2
            ? { status: 0, stdout: '4242\n' }
            : NOTHING_MATCHED;
        },
      });
      verifyStopped(context);
      expect(waits).toEqual([VERIFY_POLL_MS, VERIFY_POLL_MS]);
      expect(logged).toEqual([]);
    });

    it('warns after the whole budget instead of installing silently over a live app', () => {
      const { context, waits } = harness({
        answer: () => ({ status: 0, stdout: '4242\n' }),
      });
      verifyStopped(context);
      expect(waits).toEqual(
        Array.from({ length: VERIFY_POLLS }, () => VERIFY_POLL_MS),
      );
      expect(logged.join('\n')).toContain('still running after the kill');
    });
  });

  describe('killRunningInstances', () => {
    it('kills the Windows image tree AND the dev instance of this checkout', () => {
      const { context, calls } = harness({
        platform: 'win32',
        root: 'C:\\repo',
      });
      expect(killRunningInstances(context)).toEqual([]);
      expect(calls.map((call) => call[0])).toEqual(['taskkill', 'powershell']);
      expect(calls[0]).toEqual(['taskkill', '/F', '/T', '/IM', 'DevBar.exe']);
      expect(calls[1]?.at(-1)).toContain("Name='electron.exe'");
    });

    it('TERMs each service GROUP before pkilling the instances', () => {
      // A service spawns detached into its own process group, so a bare
      // pkill of the app never reaches it: the group walk has to come
      // first, while the app is still there to be walked from.
      const { context, calls } = harness({
        root: '/repo',
        installDir: '/install',
        answer: (cmd, args) => {
          if (cmd === 'pgrep' && args[0] === '-f' && args[1] === '/install')
            return { status: 0, stdout: '100\n' };
          if (cmd === 'pgrep' && args[0] === '-P' && args[1] === '100')
            return { status: 0, stdout: '110\n' };
          return NOTHING_MATCHED;
        },
      });
      const groups = killRunningInstances(context);
      expect(groups).toEqual([{ pid: '110', identity: 'starttime:1234' }]);
      const signals = calls.filter(
        (call) => call[0] === 'kill' || call[0] === 'pkill',
      );
      expect(signals).toEqual([
        ['kill', '-s', 'TERM', '--', '-110'],
        ['kill', '-s', 'TERM', '110'],
        ['pkill', '-f', '/install'],
        ['pkill', '-f', '/repo/dist/electron-builder'],
        ['pkill', '-f', '/repo/node_modules/electron'],
      ]);
    });
  });

  describe('killLeftovers', () => {
    const group = (pid: string): ServiceGroup => ({
      pid,
      identity: 'starttime:1234',
    });

    it('does nothing when the graceful stop already worked', () => {
      const { context, calls } = harness();
      killLeftovers(context, []);
      // Only the liveness probe ran — no signal was sent to anything.
      expect(calls.map((call) => call[0])).toEqual(['pgrep', 'pgrep', 'pgrep']);
      expect(logged).toEqual([]);
    });

    it('still escalates a service group when no app instance is left', () => {
      // A service group matches none of the instance liveness patterns, so
      // "no instance alive" is not "nothing to force": it survives on its
      // own and keeps its port.
      const { context, calls } = harness();
      killLeftovers(context, [group('110')]);
      expect(calls).toContainEqual(['kill', '-s', 'KILL', '--', '-110']);
      expect(logged.join('\n')).toContain('ignored the graceful stop');
    });

    it('aborts before the install when a group survives SIGKILL', () => {
      const { context } = harness({
        groupAlive: () => true,
      });
      expect(() =>
        killLeftovers(context, [group('110'), group('210')]),
      ).toThrow(InstallAborted);
      expect(errored.join('\n')).toContain(
        'Service group(s) survived SIGKILL: 110, 210',
      );
    });

    it('spends the post-kill budget on the clock, not per group', () => {
      // Draining it group by group would leave a later group with only its
      // immediate probe and report a healthy, dying group as a survivor.
      const probes: Record<string, number> = { '110': 0, '210': 0 };
      const { context, waits } = harness({
        groupAlive: (pid) => {
          probes[pid] = (probes[pid] ?? 0) + 1;
          // '210' is reaped after one interval; '110' hangs on longer. A
          // per-group drain would probe '210' once, with the budget
          // already spent, and report a dying group as a survivor.
          return pid === '210'
            ? (probes[pid] ?? 0) < 2
            : (probes[pid] ?? 0) <= 2;
        },
      });
      killLeftovers(context, [group('110'), group('210')]);
      expect(waits).toEqual([POSIX_POST_KILL_POLL_MS, POSIX_POST_KILL_POLL_MS]);
      expect(probes['210']).toBeGreaterThan(1);
    });

    it('reports success once the forced stop took effect', () => {
      let forced = false;
      const { context } = harness({
        answer: (cmd) => {
          if (cmd === 'pkill') {
            forced = true;
            return NOTHING_MATCHED;
          }
          return cmd === 'pgrep' && !forced
            ? { status: 0, stdout: '4242\n' }
            : NOTHING_MATCHED;
        },
      });
      killLeftovers(context, []);
      expect(logged.join('\n')).toContain('all previous instances stopped');
    });

    it('aborts when an instance outlives even the forced stop', () => {
      // It still holds the single-instance socket, so the relaunch would
      // become a silent second instance.
      const { context, waits } = harness({
        answer: () => ({ status: 0, stdout: '4242\n' }),
      });
      expect(() => killLeftovers(context, [])).toThrow(InstallAborted);
      expect(waits).toEqual(
        Array.from({ length: FORCE_POLLS }, () => FORCE_POLL_MS),
      );
      expect(logged.join('\n')).toContain('survived even the forced stop');
    });

    it('force-kills the Windows image tree and the dev instance', () => {
      const { context, calls } = harness({
        platform: 'win32',
        root: 'C:\\repo',
        answer: (cmd) =>
          cmd === 'tasklist'
            ? { status: 0, stdout: 'DevBar.exe' }
            : NOTHING_MATCHED,
      });
      expect(() => killLeftovers(context, [])).toThrow(InstallAborted);
      expect(calls).toContainEqual([
        'taskkill',
        '/F',
        '/T',
        '/IM',
        'DevBar.exe',
      ]);
    });
  });
});
