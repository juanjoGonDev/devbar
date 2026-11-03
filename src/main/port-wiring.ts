/**
 * Production wiring of port detection: the process manager's events feed the
 * detector, one shared watcher batches the socket scans, and every verdict
 * lands in the port registry the broadcasts read. Kept out of `main.ts`,
 * which is under a line budget, and tested with a fake process manager.
 */
import os from 'node:os';
import type { LogEntry } from '../domain-types.js';
import {
  createPortClassifier,
  isProbeNoise,
  type PortClassifier,
} from '../ports/http-probe.js';
import { createPortDetection } from '../ports/port-detection.js';
import type { ProbeNoise } from '../ports/probe-noise.js';
import type { PortRegistry } from '../ports/port-registry.js';
import { createPortWatcher } from '../ports/port-watcher.js';
import type { ListenSocket } from '../ports/socket-parsers.js';
import { scanListeningSockets } from '../ports/socket-scanner.js';
import { lanAddresses } from './remote/lan.js';

interface PortEventSource {
  on(
    event: 'change',
    listener: (state: {
      id: string;
      status: string;
      startedAt: number | null;
    }) => void,
  ): unknown;
  on(
    event: 'log',
    listener: (payload: { id: string; entry: LogEntry }) => void,
  ): unknown;
  runningCommandRoots(): Array<{ id: string; pid: number }>;
  probeNoise: Pick<ProbeNoise, 'mute'>;
}

/** How long after a probe answers its echo may still reach the log. */
const PROBE_ECHO_MS = 3000;

export interface PortWiringOverrides {
  scan?: (roots: number[]) => Promise<Map<number, ListenSocket[]>>;
  classifier?: PortClassifier;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function attachPortDetection(
  processManager: PortEventSource,
  registry: Pick<PortRegistry, 'setProcessPorts'>,
  overrides: PortWiringOverrides = {},
): void {
  const watcher = createPortWatcher({
    listRunning: () => processManager.runningCommandRoots(),
    scan: overrides.scan ?? ((roots) => scanListeningSockets(roots)),
    onScan: (id, sockets) => detection.onScan(id, sockets),
    onError: (error) => console.warn(`[ports] scan failed: ${String(error)}`),
    ...(overrides.setTimer ? { setTimer: overrides.setTimer } : {}),
    ...(overrides.clearTimer ? { clearTimer: overrides.clearTimer } : {}),
  });
  const base = overrides.classifier ?? createPortClassifier();
  // The service answers our `GET /`, often with a 404 it logs as an error:
  // muted while the probe runs and for a moment after.
  const mute = (id: string): void =>
    processManager.probeNoise.mute(
      id,
      Date.now() + PROBE_ECHO_MS,
      isProbeNoise,
    );
  const classifier: PortClassifier = {
    ...base,
    kind: (id, port, url) => {
      mute(id);
      return base.kind(id, port, url).finally(() => mute(id));
    },
  };
  const detection = createPortDetection({
    setPorts: registry.setProcessPorts,
    classifier,
    hostNames: () => ({
      hostname: os.hostname() || null,
      lanAddresses: lanAddresses(os.networkInterfaces()),
    }),
    nudge: watcher.nudge,
  });
  processManager.on('change', (state) => detection.onState(state));
  processManager.on('log', ({ id, entry }) => {
    // DevBar's own ▶/■ lines quote the command line, not the service.
    if (entry.stream !== 'sys') detection.onLog(id, entry.line);
  });
}
