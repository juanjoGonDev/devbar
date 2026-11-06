/**
 * When socket scans run. One timer for the whole app: every ~5 s while at
 * least one command runs, sooner (~1 s) right after something worth looking
 * at — a start, a first announced URL — and not at all while nothing runs.
 * Scans never overlap: a tick that lands during one is folded into a quick
 * follow-up once it finishes.
 */
import type { ListenSocket } from './socket-parsers.js';

interface RunningRoot {
  id: string;
  pid: number;
}

export interface PortWatcherDeps {
  listRunning: () => RunningRoot[];
  scan: (roots: number[]) => Promise<Map<number, ListenSocket[]>>;
  /** One call per command still running (same pid) when its scan returns. */
  onScan: (id: string, sockets: ListenSocket[]) => void;
  onError?: (error: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  intervalMs?: number;
  nudgeMs?: number;
}

export interface PortWatcher {
  /** Scan soon (a command started, or announced a URL). */
  nudge: () => void;
  stop: () => void;
}

const PORT_SCAN_INTERVAL_MS = 5000;
const PORT_SCAN_NUDGE_MS = 1000;

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const timer = setTimeout(fn, ms);
  // Observation only: never a reason for the process to stay alive.
  timer.unref?.();
  return timer;
}

export function createPortWatcher(deps: PortWatcherDeps): PortWatcher {
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer =
    deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const intervalMs = deps.intervalMs ?? PORT_SCAN_INTERVAL_MS;
  const nudgeMs = deps.nudgeMs ?? PORT_SCAN_NUDGE_MS;
  let timer: unknown = null;
  let dueAt = Infinity;
  let scanning = false;
  let pending = false;
  let stopped = false;

  function schedule(ms: number): void {
    if (stopped) return;
    const at = Date.now() + ms;
    if (timer !== null && dueAt <= at) return;
    if (timer !== null) clearTimer(timer);
    dueAt = at;
    timer = setTimer(() => {
      timer = null;
      dueAt = Infinity;
      void tick();
    }, ms);
  }

  function report(
    roots: readonly RunningRoot[],
    found: ReadonlyMap<number, ListenSocket[]>,
  ): void {
    const still = new Map(deps.listRunning().map((r) => [r.id, r.pid]));
    for (const { id, pid } of roots)
      if (still.get(id) === pid) deps.onScan(id, found.get(pid) ?? []);
  }

  async function tick(): Promise<void> {
    if (scanning) {
      pending = true;
      return;
    }
    const roots = [...deps.listRunning()];
    if (roots.length === 0) return;
    scanning = true;
    try {
      report(roots, await deps.scan(roots.map((root) => root.pid)));
    } catch (error) {
      deps.onError?.(error);
    } finally {
      scanning = false;
    }
    if (pending) {
      pending = false;
      schedule(nudgeMs);
    } else if (deps.listRunning().length > 0) schedule(intervalMs);
  }

  return {
    nudge: () => schedule(nudgeMs),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
