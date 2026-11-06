import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scanListeningSockets,
  type CommandRunner,
} from '../src/ports/socket-scanner.js';
import { createPortWatcher } from '../src/ports/port-watcher.js';
import type { ListenSocket } from '../src/ports/socket-parsers.js';

const PS = ['  100     1', '  101   100', '  102   101', '  200     1'].join(
  '\n',
);

function fakeRunner(outputs: Record<string, string | null>): {
  run: CommandRunner;
  calls: Array<{ file: string; args: readonly string[] }>;
} {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args });
      return Promise.resolve(file in outputs ? (outputs[file] ?? null) : '');
    },
  };
}

describe('src/ports/socket-scanner.ts + src/ports/port-watcher.ts', () => {
  describe('scanListeningSockets', () => {
    it('lists the sockets of each root tree with one ps and one lsof call', async () => {
      const { run, calls } = fakeRunner({
        ps: PS,
        lsof: 'p102\nf3\nn*:3000\np200\nf4\nn127.0.0.1:5173\np999\nf5\nn*:22\n',
      });
      const result = await scanListeningSockets([100, 200], {
        platform: 'darwin',
        run,
      });
      expect(result.get(100)).toEqual([{ pid: 102, host: '*', port: 3000 }]);
      expect(result.get(200)).toEqual([
        { pid: 200, host: '127.0.0.1', port: 5173 },
      ]);
      expect(calls.map((c) => c.file)).toEqual(['ps', 'lsof']);
      const pids = calls[1]?.args[calls[1].args.indexOf('-p') + 1];
      expect(pids?.split(',').map(Number).sort()).toEqual([100, 101, 102, 200]);
    });

    it('falls back to ss on Linux when lsof is not installed', async () => {
      const { run, calls } = fakeRunner({
        ps: PS,
        lsof: null,
        ss: 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=101,fd=3))\n',
      });
      const result = await scanListeningSockets([100], {
        platform: 'linux',
        run,
      });
      expect(result.get(100)).toEqual([
        { pid: 101, host: '0.0.0.0', port: 8080 },
      ]);
      expect(calls.map((c) => c.file)).toEqual(['ps', 'lsof', 'ss']);
    });

    it('does not try ss on macOS', async () => {
      const { run, calls } = fakeRunner({ ps: PS, lsof: null });
      const result = await scanListeningSockets([100], {
        platform: 'darwin',
        run,
      });
      expect(result.get(100)).toEqual([]);
      expect(calls.map((c) => c.file)).toEqual(['ps', 'lsof']);
    });

    it('uses netstat on Windows and keeps only the tree pids', async () => {
      const { run, calls } = fakeRunner({
        'powershell.exe': '100 1\r\n101 100\r\n',
        netstat:
          '  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   101\r\n' +
          '  TCP    0.0.0.0:135    0.0.0.0:0   LISTENING   4\r\n',
      });
      const result = await scanListeningSockets([100], {
        platform: 'win32',
        run,
      });
      expect(result.get(100)).toEqual([
        { pid: 101, host: '0.0.0.0', port: 3000 },
      ]);
      expect(calls.map((c) => c.file)).toEqual(['powershell.exe', 'netstat']);
    });

    it('runs nothing when there is no root', async () => {
      const { run, calls } = fakeRunner({});
      expect(
        (await scanListeningSockets([], { platform: 'darwin', run })).size,
      ).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  describe('createPortWatcher', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function setup(running: Array<{ id: string; pid: number }>) {
      const scan = vi.fn((roots: number[]) =>
        Promise.resolve(
          new Map<number, ListenSocket[]>(
            roots.map((pid) => [pid, [{ pid, host: '*', port: pid }]]),
          ),
        ),
      );
      const onScan = vi.fn();
      const watcher = createPortWatcher({
        listRunning: () => running,
        scan,
        onScan,
      });
      return { scan, onScan, watcher };
    }

    it('scans ~1 s after a nudge, batching every running command', async () => {
      const { scan, onScan, watcher } = setup([
        { id: 'cmd:g:a', pid: 10 },
        { id: 'cmd:g:b', pid: 20 },
      ]);
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(999);
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledExactlyOnceWith([10, 20]);
      expect(onScan).toHaveBeenCalledWith('cmd:g:a', [
        { pid: 10, host: '*', port: 10 },
      ]);
      watcher.stop();
    });

    it('keeps scanning every ~5 s while something runs', async () => {
      const { scan, watcher } = setup([{ id: 'cmd:g:a', pid: 10 }]);
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(1000 + 5000 * 2);
      expect(scan).toHaveBeenCalledTimes(3);
      watcher.stop();
      await vi.advanceTimersByTimeAsync(20000);
      expect(scan).toHaveBeenCalledTimes(3);
    });

    it('goes idle, without scanning, once nothing runs', async () => {
      const running = [{ id: 'cmd:g:a', pid: 10 }];
      const { scan, watcher } = setup(running);
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(1000);
      running.length = 0;
      await vi.advanceTimersByTimeAsync(30000);
      expect(scan).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('drops the result of a command that restarted meanwhile', async () => {
      const running = [{ id: 'cmd:g:a', pid: 10 }];
      let release: (value: Map<number, ListenSocket[]>) => void = () => {};
      const onScan = vi.fn();
      const watcher = createPortWatcher({
        listRunning: () => running,
        scan: () => new Promise((resolve) => (release = resolve)),
        onScan,
      });
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(1000);
      running[0] = { id: 'cmd:g:a', pid: 11 };
      release(new Map([[10, []]]));
      await vi.advanceTimersByTimeAsync(0);
      expect(onScan).not.toHaveBeenCalled();
      watcher.stop();
    });

    it('never overlaps two scans', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const watcher = createPortWatcher({
        listRunning: () => [{ id: 'cmd:g:a', pid: 10 }],
        scan: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          inFlight--;
          return new Map();
        },
        onScan: () => {},
        intervalMs: 100,
        nudgeMs: 100,
      });
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(150);
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(10000);
      expect(maxInFlight).toBe(1);
      watcher.stop();
    });

    it('reports a failed scan and keeps going', async () => {
      const onError = vi.fn();
      const scan = vi
        .fn<(roots: number[]) => Promise<Map<number, ListenSocket[]>>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(new Map());
      const watcher = createPortWatcher({
        listRunning: () => [{ id: 'cmd:g:a', pid: 10 }],
        scan,
        onScan: () => {},
        onError,
      });
      watcher.nudge();
      await vi.advanceTimersByTimeAsync(6000);
      expect(onError).toHaveBeenCalledOnce();
      expect(scan).toHaveBeenCalledTimes(2);
      watcher.stop();
    });
  });
});
