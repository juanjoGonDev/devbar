import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachProductionSampling,
  attachResourceSampling,
  createResourceMonitor,
  formatSampleLine,
  RESOURCE_INTERVAL_MS,
  type ResourceMonitorDeps,
} from '../src/main/resource-monitor.js';

/**
 * The resource sampler that explains "the fans spin up when I open the
 * menu": one app-log line per sample with CPU% over the window between
 * samples, RSS/heap, and the Chromium process count. Everything is
 * injected, so these tests feed fake gauges and read the lines.
 */

interface Harness {
  lines: string[];
  fireInterval: () => void;
  stopped: () => boolean;
  deps: ResourceMonitorDeps;
  monitor: ReturnType<typeof createResourceMonitor>;
}

function harness(
  overrides: Partial<ResourceMonitorDeps> = {},
  gauges?: {
    cpu?: [number, number, number, number];
    at?: [number, number];
  },
): Harness {
  const lines: string[] = [];
  const timers: { fn: () => void; cleared: boolean }[] = [];
  // gauges: [cpuUserMicros@t0, cpuSystem@t0, cpuUser@t1, cpuSystem@t1]
  const [u0 = 0, s0 = 0, u1 = 0, s1 = 0] = gauges?.cpu ?? [];
  const [t0 = 1_000, t1 = 2_000] = gauges?.at ?? [];
  let reads = 0;
  const deps: ResourceMonitorDeps = {
    memory: () => ({ rss: 200 * 1048576, heapUsed: 60 * 1048576 }),
    system: () => ({
      total: 8 * 1073741824,
      free: 1.5 * 1073741824,
      load1: 2.75,
    }),
    cpu: () => {
      const first = reads++ === 0;
      return { user: first ? u0 : u1, system: first ? s0 : s1 };
    },
    now: () => (reads <= 1 ? t0 : t1),
    processes: () => [{ type: 'browser' }, { type: 'renderer' }],
    log: (line) => lines.push(line),
    setTimer: (fn) => {
      const timer = { fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
    ...overrides,
  };
  const monitor = createResourceMonitor(deps);
  return {
    lines,
    fireInterval: () => {
      const t = timers[0] as { fn: () => void; cleared: boolean } | undefined;
      if (t && !t.cleared) t.fn();
    },
    stopped: () =>
      (timers[0] as unknown as { cleared: boolean } | undefined)?.cleared ??
      false,
    deps,
    monitor,
  };
}

describe('src/main/resource-monitor.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatSampleLine', () => {
    it('formats cpu, memory, processes and the reason', () => {
      expect(
        formatSampleLine('window-open', {
          cpuPercent: 12.34,
          rssMB: '180.2MB',
          heapMB: '64.0MB',
          processes: 5,
          freeMB: '1536.0MB',
          totalMB: '8192.0MB',
          load1: '2.75',
        }),
      ).toBe(
        '[resources] cpu=12.3% rss=180.2MB heap=64.0MB procs=5 ' +
          'sys-mem=1536.0MB/8192.0MB load1=2.75 (window-open)',
      );
    });

    it('shows n/a before there is a window to average over', () => {
      expect(
        formatSampleLine('monitor-start', {
          cpuPercent: null,
          rssMB: '1.0MB',
          heapMB: '0.5MB',
          processes: 1,
          freeMB: '1536.0MB',
          totalMB: '8192.0MB',
          load1: '0.10',
        }),
      ).toContain('cpu=n/a');
    });
  });

  describe('sample', () => {
    it('answers n/a on the first read and averages CPU on the second', () => {
      // 500ms of CPU across a 1000ms window → 50% of one core.
      const h = harness({}, { cpu: [0, 0, 500_000, 0], at: [1_000, 2_000] });
      const first = h.monitor.sample('boot');
      expect(first.cpuPercent).toBeNull();
      const second = h.monitor.sample('window-open');
      expect(second.cpuPercent).toBe(50);
    });

    it('records megabytes and the child process count', () => {
      const h = harness();
      const s = h.monitor.sample('window-open');
      expect(s.rssMB).toBe('200.0MB');
      expect(s.heapMB).toBe('60.0MB');
      expect(s.processes).toBe(2);
    });

    it('records machine-wide memory and load alongside the app gauges', () => {
      // "¿Es culpa nuestra o del OS?" — a Pi under memory pressure answers
      // with sys-mem and load1, not with app RSS.
      const h = harness({
        system: () => ({
          total: 4 * 1073741824,
          free: 0.2 * 1073741824,
          load1: 3.9,
        }),
      });
      const s = h.monitor.sample('interval');
      expect(s.freeMB).toBe('204.8MB');
      expect(s.totalMB).toBe('4096.0MB');
      expect(s.load1).toBe('3.90');
      expect(h.lines[0]).toContain('sys-mem=204.8MB/4096.0MB load1=3.90');
    });

    it('writes one line per sample into the log sink', () => {
      const h = harness({}, { cpu: [0, 0, 500_000, 0], at: [1_000, 2_000] });
      h.monitor.sample('boot');
      h.monitor.sample('window-open');
      expect(h.lines).toHaveLength(2);
      expect(h.lines[0]).toContain('(boot)');
      expect(h.lines[1]).toContain('(window-open)');
      expect(h.lines[1]).toContain('cpu=50.0%');
    });

    it('counts a lone process even without electron metrics', () => {
      const h = harness({ processes: undefined });
      expect(h.monitor.sample('interval').processes).toBe(1);
    });

    it('keeps the last sample valid when the clock stands still', () => {
      // A zero-length window would divide by zero: report n/a instead.
      const h = harness({}, { at: [1000, 1000], cpu: [0, 0, 999, 999] });
      h.monitor.sample('boot');
      expect(h.monitor.sample('interval').cpuPercent).toBeNull();
    });
  });

  describe('start / stop', () => {
    it('takes a baseline and schedules the periodic sample', () => {
      const h = harness();
      h.monitor.start();
      expect(h.lines).toEqual([expect.stringContaining('(monitor-start)')]);
      h.fireInterval();
      expect(h.lines[1]).toContain('(interval)');
    });

    it('uses the default budget', () => {
      const seen: number[] = [];
      const h = harness({
        setTimer: (fn, ms) => {
          seen.push(ms);
          return fn;
        },
      });
      h.monitor.start();
      expect(seen).toEqual([RESOURCE_INTERVAL_MS]);
    });

    it('stops sampling after stop()', () => {
      const h = harness();
      h.monitor.start();
      h.monitor.stop();
      expect(h.stopped()).toBe(true);
      const count = h.lines.length;
      h.fireInterval();
      expect(h.lines.length).toBe(count);
    });

    it('ignores a double start', () => {
      const h = harness();
      h.monitor.start();
      h.monitor.start();
      expect(h.lines).toHaveLength(1);
    });
  });

  describe('attachResourceSampling', () => {
    it('samples after the window exists, wraps the factory and starts the monitor', () => {
      const h = harness();
      const events: string[] = [];
      const host: { createWindow: (o: never) => unknown } = {
        createWindow: () => {
          // The creation is the expensive part: the gauge the sample will
          // read only moves once the factory has run.
          events.push('create');
          cpuBurned = true;
          return 'win';
        },
      };
      let cpuBurned = false;
      const realCpu = h.deps.cpu;
      h.deps.cpu = () => (cpuBurned ? { user: 0, system: 1 } : realCpu());
      const monitor = attachResourceSampling(host, h.deps);
      // Baseline from start()…
      expect(h.lines[0]).toContain('(monitor-start)');
      // …and the window-open sample lands AFTER the factory: it measures
      // the creation, not the idle time before it.
      const created = host.createWindow(null as never);
      expect(created).toBe('win');
      expect(events).toEqual(['create']);
      expect(h.lines[h.lines.length - 1]).toContain('(window-open)');
      expect(monitor.sample('probe')).toBeDefined();
    });

    it('still creates the window when sampling throws', () => {
      const h = harness({
        processes: () => {
          throw new Error('metrics down');
        },
      });
      const host: { createWindow: (o: never) => unknown } = {
        createWindow: () => 'win',
      };
      attachResourceSampling(host, h.deps);
      expect(host.createWindow(null as never)).toBe('win');
    });
  });

  describe('attachProductionSampling', () => {
    it('runs on the real gauges and samples window openings', () => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, 'info')
        .mockImplementation((line: unknown) => {
          lines.push(String(line));
        });
      const host: { createWindow: (o: never) => unknown } = {
        createWindow: () => 'win',
      };
      const monitor = attachProductionSampling(host, () => [
        { type: 'renderer' },
      ]);
      try {
        host.createWindow(null as never);
      } finally {
        spy.mockRestore();
        monitor.stop();
      }
      // Real memory/cpu/os all answered; the window-open sample logged.
      expect(lines.some((line) => line.includes('(window-open)'))).toBe(true);
      expect(lines.some((line) => line.includes('sys-mem='))).toBe(true);
    });
  });
});

describe('resource monitor failure containment', () => {
  it('a failed baseline still installs the periodic timer', () => {
    let calls = 0;
    const h = harness({
      memory: () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return { rss: 1048576, heapUsed: 1 };
      },
    });
    expect(() => h.monitor.start()).not.toThrow();
    expect(
      h.lines.some((l) => l.includes('[resources] baseline sample failed:')),
    ).toBe(true);
    h.fireInterval();
    expect(h.lines.some((l) => l.includes('(interval)'))).toBe(true);
  });

  it('a failed interval sample never escapes the timer callback', () => {
    const h = harness({
      memory: () => {
        throw new Error('boom');
      },
    });
    h.monitor.start();
    expect(() => h.fireInterval()).not.toThrow();
    expect(h.lines.some((l) => l.includes('[resources] sample failed:'))).toBe(
      true,
    );
    // The timer survived the failure: the monitor keeps sampling.
    expect(h.stopped()).toBe(false);
  });
});
