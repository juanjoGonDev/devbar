import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * `killGroup` — the only place DevBar signals a service, and the one place
 * the POSIX and Windows shapes are completely different: POSIX signals the
 * child's whole PROCESS GROUP (`kill(-pid)`), Windows has no such thing and
 * shells out to `taskkill /T /F`.
 *
 * Nothing real is signalled here: `process.kill` is spied on, and the
 * Windows branch runs against a mocked `node:child_process`. That is
 * deliberate — a real `process.kill(-pid)` from a unit test would signal
 * whatever process group happens to own that id on the contributor's box.
 */
const mocks = vi.hoisted(() => ({
  execFileCalls: [] as Array<{ file: string; args: readonly string[] }>,
  /** The callback the last `execFile` was given, so a test can fail it. */
  lastCallback: null as null | ((error: Error | null) => void),
  /** Makes `execFile` itself throw, the way a missing taskkill would. */
  throwOnExecFile: false,
}));

vi.mock('node:child_process', () => ({
  execFileSync: () => '/devbar-test/shell-bin',
  execFile: (
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => {
    if (mocks.throwOnExecFile) throw new Error('spawn taskkill ENOENT');
    mocks.execFileCalls.push({ file, args });
    mocks.lastCallback = callback;
    return {};
  },
  spawn: () => {
    throw new Error('this suite never spawns');
  },
}));

type KillGroup = (
  child: ChildProcessWithoutNullStreams | null,
  signal: NodeJS.Signals,
) => Error | null;

/**
 * Re-import with a faked `process.platform`: `isWin` is read at module load
 * (src/platform.ts), so the branch under test is chosen at import time.
 */
async function killGroupFor(
  platform: 'win32' | 'linux' | 'darwin',
): Promise<KillGroup> {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const mod = await import('../src/process/spawn.js');
  return mod.killGroup;
}

function fakeChild(
  pid: number | undefined,
  kill: () => boolean = () => true,
): ChildProcessWithoutNullStreams {
  return { pid, kill } as unknown as ChildProcessWithoutNullStreams;
}

describe('src/process/spawn.ts — killGroup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.execFileCalls.length = 0;
    mocks.lastCallback = null;
    mocks.throwOnExecFile = false;
  });

  describe('nothing to signal', () => {
    it('does nothing for a null child', async () => {
      const killGroup = await killGroupFor('linux');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killGroup(null, 'SIGTERM')).toBeNull();
      expect(kill).not.toHaveBeenCalled();
    });

    it('does nothing for a child that never got a pid', async () => {
      const killGroup = await killGroupFor('linux');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killGroup(fakeChild(undefined), 'SIGTERM')).toBeNull();
      expect(kill).not.toHaveBeenCalled();
    });
  });

  describe('POSIX', () => {
    it('signals the whole process group, not just the shell', async () => {
      // The NEGATIVE pid is the entire point: the tracked child is the login
      // shell, and the user's command (plus whatever it spawned) are its
      // children. Signalling `pid` alone would leave the real service alive.
      const killGroup = await killGroupFor('linux');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killGroup(fakeChild(4242), 'SIGTERM')).toBeNull();
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    });

    it('forwards the signal it was given, not a fixed one', async () => {
      const killGroup = await killGroupFor('darwin');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      killGroup(fakeChild(77), 'SIGKILL');
      expect(kill).toHaveBeenCalledWith(-77, 'SIGKILL');
    });

    it('falls back to the child alone when the group no longer exists', async () => {
      // ESRCH here means the group is gone (or setpgid had not landed yet);
      // the child itself may still be reachable, so the fallback is the
      // difference between a stop that works and one that times out.
      const killGroup = await killGroupFor('linux');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const childKill = vi.fn(() => true);
      expect(killGroup(fakeChild(4242, childKill), 'SIGTERM')).toBeNull();
      expect(childKill).toHaveBeenCalledTimes(1);
    });

    it('reports the failure when neither the group nor the child can be signalled', async () => {
      const killGroup = await killGroupFor('linux');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('EPERM on the group');
      });
      const error = killGroup(
        fakeChild(4242, () => {
          throw new Error('EPERM on the child');
        }),
        'SIGTERM',
      );
      // Reported, not swallowed: stop() turns this into a failed stop, which
      // keeps the entry RUNNING so a later start cannot duplicate it.
      expect(error?.message).toBe('EPERM on the child');
    });

    it('wraps a non-Error throw so the caller always gets an Error', async () => {
      const killGroup = await killGroupFor('linux');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const error = killGroup(
        fakeChild(4242, () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'not an Error at all';
        }),
        'SIGTERM',
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe('not an Error at all');
    });
  });

  describe('Windows', () => {
    it('walks the tree with taskkill instead of signalling a group', async () => {
      const killGroup = await killGroupFor('win32');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killGroup(fakeChild(4242), 'SIGTERM')).toBeNull();
      // /T reaches cmd.exe's children (the actual service); /F because there
      // is no portable graceful equivalent that reaches grandchildren.
      expect(mocks.execFileCalls).toEqual([
        { file: 'taskkill', args: ['/pid', '4242', '/T', '/F'] },
      ]);
      // A process-group signal would target a group id Windows does not have.
      expect(kill).not.toHaveBeenCalled();
    });

    it('logs an async taskkill failure instead of losing it', async () => {
      // A swallowed taskkill error is the only way stop() can reach its
      // 6.5 s give-up; without this line the give-up is unexplainable.
      const killGroup = await killGroupFor('win32');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      killGroup(fakeChild(4242), 'SIGTERM');
      expect(mocks.lastCallback).not.toBeNull();
      mocks.lastCallback?.(new Error('Access is denied.'));
      expect(logged).toHaveBeenCalledWith(
        'taskkill failed for pid 4242: Access is denied.',
      );
    });

    it('stays quiet when taskkill reports no error', async () => {
      const killGroup = await killGroupFor('win32');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      killGroup(fakeChild(4242), 'SIGTERM');
      mocks.lastCallback?.(null);
      expect(logged).not.toHaveBeenCalled();
    });

    it('reports a taskkill that could not even be launched', async () => {
      mocks.throwOnExecFile = true;
      const killGroup = await killGroupFor('win32');
      const error = killGroup(fakeChild(4242), 'SIGTERM');
      expect(error?.message).toBe('spawn taskkill ENOENT');
    });
  });
});
