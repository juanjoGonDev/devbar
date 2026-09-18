import { describe, expect, it, vi } from 'vitest';
import {
  createShutdownController,
  withDeadline,
  type ShutdownDeps,
} from '../src/main/shutdown.js';
import type { ResumeExitReason } from '../src/session-resume.js';

interface Flush {
  exit: ResumeExitReason;
  ids: readonly string[] | undefined;
}

function harness(overrides: Partial<ShutdownDeps> = {}) {
  const flushes: Flush[] = [];
  const calls: string[] = [];
  let stopAllResult = { ok: true, failed: [] as string[] };
  let stopAllDelay: Promise<void> | null = null;
  const deps: ShutdownDeps = {
    isPrimary: true,
    smokeMode: false,
    repoWatcher: { closeAll: () => calls.push('closeAll') },
    preScriptRunner: {
      isRunning: () => false,
      cancel: () => calls.push('cancel'),
    },
    processManager: {
      stopAll: async () => {
        if (stopAllDelay) await stopAllDelay;
        return stopAllResult;
      },
    },
    sessionResume: () => ({
      flush: (exit, ids) => {
        flushes.push({ exit, ids });
        return true;
      },
    }),
    runningCommandIds: () => ['cmd:g1:web', 'cmd:g1:api'],
    releaseConfigCloseGuard: () => calls.push('releaseGuard'),
    appQuit: () => calls.push('quit'),
    processExit: (code) => calls.push(`exit:${code}`),
    setTimer: (fn) => {
      calls.push('timer');
      return fn;
    },
    ...overrides,
  };
  return {
    controller: createShutdownController(deps),
    flushes,
    calls,
    setStopAll: (value: { ok: boolean; failed: string[] }) => {
      stopAllResult = value;
    },
    blockStopAll: (promise: Promise<void>) => {
      stopAllDelay = promise;
    },
  };
}

describe('src/main/shutdown.ts', () => {
  describe('withDeadline', () => {
    it('passes a value through', async () => {
      await expect(withDeadline(Promise.resolve(7), 50)).resolves.toBe(7);
    });

    it('propagates a rejection as an Error', async () => {
      await expect(
        withDeadline(Promise.reject(new Error('nope')), 50),
      ).rejects.toThrow('nope');
    });

    it('rejects when the promise outlives the deadline', async () => {
      await expect(
        withDeadline(new Promise(() => undefined), 5),
      ).rejects.toThrow(/still not done after 5 ms/);
    });
  });

  describe('cleanup', () => {
    it('drops the config close veto and stops the watchers before stopping services', async () => {
      const h = harness();
      await h.controller.cleanup();
      expect(h.calls.slice(0, 2)).toEqual(['releaseGuard', 'closeAll']);
      expect(h.controller.phase()).toBe('done');
    });

    it('cancels a running pipeline', async () => {
      const h = harness({
        preScriptRunner: { isRunning: () => true, cancel: () => 'cancelled' },
      });
      await h.controller.cleanup();
      expect(h.controller.phase()).toBe('done');
    });

    it('survives a pipeline cancel that throws', async () => {
      const h = harness({
        preScriptRunner: {
          isRunning: () => true,
          cancel: () => {
            throw new Error('nope');
          },
        },
      });
      await expect(h.controller.cleanup()).resolves.toBeUndefined();
    });

    it('flushes the running set as a deliberate quit by default', async () => {
      const h = harness();
      await h.controller.cleanup();
      expect(h.flushes).toEqual([
        { exit: 'quit', ids: ['cmd:g1:web', 'cmd:g1:api'] },
      ]);
    });

    it('records an update exit once the updater marks one', async () => {
      const h = harness();
      h.controller.markUpdateExit();
      await h.controller.cleanup();
      expect(h.flushes[0]?.exit).toBe('update');
    });

    it('writes no snapshot in smoke mode', async () => {
      const h = harness({ smokeMode: true });
      await h.controller.cleanup();
      expect(h.flushes).toEqual([]);
    });

    it('writes no snapshot before the tracker exists', async () => {
      const h = harness({ sessionResume: () => null });
      await h.controller.cleanup();
      expect(h.flushes).toEqual([]);
    });

    it('rewrites the snapshot without the services that survived the stop', async () => {
      const h = harness();
      h.setStopAll({ ok: false, failed: ['cmd:g1:api'] });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      await h.controller.cleanup();
      expect(h.flushes).toHaveLength(2);
      expect(h.flushes[1]?.ids).toEqual(['cmd:g1:web']);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('still finishes when stopAll blows up', async () => {
      const h = harness({
        processManager: {
          stopAll: () => Promise.reject(new Error('wedged')),
        },
      });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      await h.controller.cleanup();
      expect(h.controller.phase()).toBe('done');
      expect(error).toHaveBeenCalledWith('shutdown cleanup failed: wedged');
      error.mockRestore();
    });

    it('is a no-op once it has finished', async () => {
      const h = harness();
      await h.controller.cleanup();
      await h.controller.cleanup();
      expect(h.flushes).toHaveLength(1);
    });

    it('shares the in-flight cleanup with a second caller', async () => {
      let release = (): void => undefined;
      const h = harness();
      h.blockStopAll(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const first = h.controller.cleanup();
      const second = h.controller.cleanup();
      expect(h.controller.phase()).toBe('cleaning');
      release();
      await Promise.all([first, second]);
      expect(h.flushes).toHaveLength(1);
    });
  });

  describe('onBeforeQuit', () => {
    it('holds the quit and re-issues it after the cleanup', async () => {
      const h = harness();
      const event = { preventDefault: vi.fn() };
      h.controller.onBeforeQuit(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      await h.controller.cleanup();
      await Promise.resolve();
      expect(h.calls).toContain('quit');
    });

    it('queues exactly one follow-up quit', async () => {
      const h = harness();
      h.controller.onBeforeQuit({ preventDefault: vi.fn() });
      h.controller.onBeforeQuit({ preventDefault: vi.fn() });
      await h.controller.cleanup();
      await Promise.resolve();
      expect(h.calls.filter((c) => c === 'quit')).toHaveLength(1);
    });

    it('lets a finished shutdown die', async () => {
      const h = harness();
      await h.controller.cleanup();
      const event = { preventDefault: vi.fn() };
      h.controller.onBeforeQuit(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('never holds a second instance, which owns no snapshot', () => {
      const h = harness({ isPrimary: false });
      const event = { preventDefault: vi.fn() };
      h.controller.onBeforeQuit(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('onTerminalSignal', () => {
    it('exits a second instance immediately', () => {
      const h = harness({ isPrimary: false });
      h.controller.onTerminalSignal();
      expect(h.calls).toEqual(['exit:0']);
    });

    it('records a kill exit and quits once the cleanup finishes', async () => {
      const h = harness();
      h.controller.onTerminalSignal();
      await h.controller.cleanup();
      await Promise.resolve();
      expect(h.flushes[0]?.exit).toBe('kill');
      expect(h.calls).toContain('quit');
      expect(h.calls).toContain('timer');
    });

    it('exits immediately on a second signal', async () => {
      const h = harness();
      h.blockStopAll(new Promise(() => undefined));
      h.controller.onTerminalSignal();
      h.controller.onTerminalSignal();
      expect(h.calls).toContain('exit:0');
      await Promise.resolve();
    });

    it('exits at once when the cleanup already finished', async () => {
      const h = harness();
      await h.controller.cleanup();
      h.controller.onTerminalSignal();
      expect(h.calls).toContain('exit:0');
    });

    it('lets a cleanup already in flight terminate the process', () => {
      const h = harness();
      h.blockStopAll(new Promise(() => undefined));
      void h.controller.cleanup();
      h.calls.length = 0;
      h.controller.onTerminalSignal();
      expect(h.calls).toEqual([]);
    });
  });

  describe('defaults', () => {
    it('falls back to a real timer', async () => {
      const h = harness({ setTimer: undefined, forceExitDelayMs: 1 });
      h.controller.onTerminalSignal();
      await h.controller.cleanup();
      await Promise.resolve();
      expect(h.calls).toContain('quit');
    });
  });
});
