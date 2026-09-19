/**
 * Resource sampling for the app log. Opening heavy windows on low-end
 * hosts (a Raspberry Pi's fans spin up when the config window opens)
 * was invisible after the fact: nothing recorded what it cost. One line
 * per sample lands in app.log — CPU% of this process since the previous
 * sample, RSS/heap, and how many Electron child processes are alive —
 * so a "se disparan los ventiladores al abrir el menú" report comes
 * with numbers attached.
 *
 * Everything is injected: tests feed fake memory/cpu/clock values and
 * read the emitted lines. The monitor itself never touches Electron.
 */

export interface ResourceSample {
  /** Percent of one core used since the PREVIOUS sample; null on the
   *  first sample (no window to average over). */
  cpuPercent: number | null;
  rssMB: string;
  heapMB: string;
  processes: number;
}

export interface ResourceMonitorDeps {
  /** Node's process.memoryUsage(). */
  memory: () => { rss: number; heapUsed: number };
  /** Node's process.cpuUsage(): cumulative user/system CPU, microseconds. */
  cpu: () => { user: number; system: number };
  /** Monotonic-ish wall clock, milliseconds. */
  now: () => number;
  /** Electron's app.getAppMetrics(), one entry per Chromium child. */
  processes?: () => readonly { type: string }[];
  /** Where samples go (console.info reaches app.log via the console
   *  mirror). */
  log: (line: string) => void;
  /** Injectable timers; production passes the globals. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  intervalMs?: number;
}

export const RESOURCE_INTERVAL_MS = 60_000;

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

export function formatSampleLine(
  reason: string,
  sample: ResourceSample,
): string {
  const cpu =
    sample.cpuPercent === null ? 'n/a' : `${sample.cpuPercent.toFixed(1)}%`;
  return (
    `[resources] cpu=${cpu} rss=${sample.rssMB} ` +
    `heap=${sample.heapMB} procs=${sample.processes} (${reason})`
  );
}

export interface ResourceMonitor {
  /** Take a sample now, attributed to `reason` (e.g. 'window-open'). */
  sample: (reason: string) => ResourceSample;
  /** Begin the periodic samples; also takes an immediate baseline. */
  start: () => void;
  stop: () => void;
}

/**
 * Wires sampling around a host object: every window creation takes an
 * immediate sample and the periodic baseline starts. Kept out of main.ts
 * (which is under a line budget) and tested with a fake host.
 */
export function attachResourceSampling(
  host: { createWindow: (options: never) => unknown },
  deps: ResourceMonitorDeps,
): ResourceMonitor {
  const monitor = createResourceMonitor(deps);
  const createWindow = host.createWindow.bind(host);
  host.createWindow = (options: never) => {
    try {
      monitor.sample('window-open');
    } catch {
      // Sampling must never break the window it is observing.
    }
    return createWindow(options);
  };
  try {
    monitor.start();
  } catch {
    // Neither the baseline nor the wrapper may take the app down.
  }
  return monitor;
}

export function createResourceMonitor(
  deps: ResourceMonitorDeps,
): ResourceMonitor {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));
  const intervalMs = deps.intervalMs ?? RESOURCE_INTERVAL_MS;
  let last: { user: number; system: number; at: number } | null = null;
  let timer: unknown = null;

  function sample(reason: string): ResourceSample {
    const mem = deps.memory();
    const cpu = deps.cpu();
    const at = deps.now();
    let cpuPercent: number | null = null;
    if (last) {
      const wallMs = at - last.at;
      if (wallMs > 0) {
        // Microseconds of CPU across the window, over wall time: percent
        // of one core (values above 100 mean more than one core busy).
        const cpuMs =
          (cpu.user - last.user) / 1000 + (cpu.system - last.system) / 1000;
        cpuPercent = (cpuMs / wallMs) * 100;
      }
    }
    last = { user: cpu.user, system: cpu.system, at };
    const procs = deps.processes?.() ?? [];
    const result: ResourceSample = {
      cpuPercent,
      rssMB: mb(mem.rss),
      heapMB: mb(mem.heapUsed),
      processes: Math.max(1, procs.length),
    };
    deps.log(formatSampleLine(reason, result));
    return result;
  }

  return {
    sample,
    start: () => {
      if (timer) return;
      sample('monitor-start');
      timer = setTimer(() => sample('interval'), intervalMs);
    },
    stop: () => {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
  };
}
