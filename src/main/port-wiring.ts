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
  type PortClassifier,
} from '../ports/http-probe.js';
import { createPortDetection } from '../ports/port-detection.js';
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
}

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
  const detection = createPortDetection({
    setPorts: registry.setProcessPorts,
    classifier: overrides.classifier ?? createPortClassifier(),
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
