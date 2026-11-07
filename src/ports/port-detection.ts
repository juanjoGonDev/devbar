/**
 * Ties the three detection sources to the port registry, per running COMMAND
 * (actions and pre-scripts are one-shots and never get ports):
 *
 * - its log lines announce URLs (`extractLogPorts`) and name the tool;
 * - socket scans report what its process tree really listens on;
 * - an HTTP probe classifies each port once per run (`PortClassifier`).
 *
 * A port is published only once it is classified, so the UI never flashes a
 * port as «other» while its probe is still in flight. A log-announced port
 * nothing HTTP answers on, and no scan has seen, is dropped: a URL printed by
 * a config dump is not a server.
 */
import { parseProcessId } from '../compound-id.js';
import type { DetectedPort } from '../domain-types.js';
import type { PortClassifier } from './http-probe.js';
import {
  detectLabel,
  extractLogPorts,
  type LocalHostNames,
} from './log-urls.js';
import type { ListenSocket } from './socket-parsers.js';

interface Announced {
  url: string;
  label: string | null;
}

interface RunPorts {
  startedAt: number | null;
  label: string | null;
  announced: Map<number, Announced>;
  /** Last scan: port → the host it is bound to. */
  bound: Map<number, string>;
}

export interface PortDetectionDeps {
  setPorts: (processId: string, ports: DetectedPort[]) => void;
  classifier: PortClassifier;
  hostNames: () => LocalHostNames;
  /** Scan soon: a command started or announced a new port. */
  nudge: () => void;
}

export interface PortDetection {
  onLog: (processId: string, line: string) => void;
  onState: (state: {
    id: string;
    status: string;
    startedAt: number | null;
  }) => void;
  onScan: (processId: string, sockets: readonly ListenSocket[]) => void;
}

const WILDCARD = new Set(['*', '0.0.0.0', '[::]', '::']);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

function isCommand(processId: string): boolean {
  return parseProcessId(processId).kind === 'command';
}

function freshRun(startedAt: number | null): RunPorts {
  return {
    startedAt,
    label: null,
    announced: new Map(),
    bound: new Map(),
  };
}

function originOf(url: string): string {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return url;
  }
}

export function createPortDetection(deps: PortDetectionDeps): PortDetection {
  const runs = new Map<string, RunPorts>();
  let names: LocalHostNames = { hostname: null, lanAddresses: [] };

  function reachable(host: string): boolean {
    const value = host.toLowerCase();
    if (WILDCARD.has(value)) return true;
    if (LOOPBACK.has(value)) return false;
    return (
      names.lanAddresses.includes(value) ||
      value === names.hostname?.toLowerCase()
    );
  }

  function socketUrl(host: string, port: number): string {
    const name = WILDCARD.has(host) ? 'localhost' : host;
    return `http://${name}:${port}/`;
  }

  function candidates(run: RunPorts): Map<number, Omit<DetectedPort, 'kind'>> {
    const found = new Map<number, Omit<DetectedPort, 'kind'>>();
    for (const [port, host] of run.bound)
      found.set(port, {
        port,
        url: socketUrl(host, port),
        source: 'socket',
        lanReachable: reachable(host),
      });
    for (const [port, hit] of run.announced) {
      const bound = run.bound.get(port);
      const host = new URL(hit.url).hostname;
      found.set(port, {
        port,
        url: hit.url,
        source: 'log',
        lanReachable: reachable(bound ?? host),
        ...(hit.label ? { label: hit.label } : {}),
      });
    }
    return found;
  }

  function publish(processId: string): void {
    const run = runs.get(processId);
    if (!run) return;
    const ports: DetectedPort[] = [];
    for (const candidate of candidates(run).values()) {
      const kind = deps.classifier.known(processId, candidate.port);
      if (kind === null) {
        void deps.classifier
          .kind(processId, candidate.port, originOf(candidate.url))
          .then(() => {
            if (runs.get(processId) === run) publish(processId);
          });
        continue;
      }
      const unconfirmed = !run.bound.has(candidate.port);
      if (kind === 'other' && candidate.source === 'log' && unconfirmed)
        continue;
      ports.push({ ...candidate, kind });
    }
    deps.setPorts(processId, ports);
  }

  return {
    onState(state) {
      if (!isCommand(state.id)) return;
      const current = runs.get(state.id);
      if (state.status !== 'running') {
        if (!current) return;
        runs.delete(state.id);
        deps.classifier.forget(state.id);
        deps.setPorts(state.id, []);
        return;
      }
      if (current && current.startedAt === state.startedAt) return;
      deps.classifier.forget(state.id);
      names = deps.hostNames();
      runs.set(state.id, freshRun(state.startedAt));
      deps.setPorts(state.id, []);
      deps.nudge();
    },
    onLog(processId, line) {
      const run = runs.get(processId);
      if (!run) return;
      run.label = detectLabel(line) ?? run.label;
      let added = false;
      for (const hit of extractLogPorts(line, names)) {
        if (run.announced.has(hit.port)) continue;
        run.announced.set(hit.port, { url: hit.url, label: run.label });
        added = true;
      }
      if (!added) return;
      publish(processId);
      deps.nudge();
    },
    onScan(processId, sockets) {
      const run = runs.get(processId);
      if (!run) return;
      const bound = new Map<number, string>();
      for (const socket of sockets) {
        const previous = bound.get(socket.port);
        // The widest bind wins: `*:3000` next to `127.0.0.1:3000` is reachable.
        if (!previous || reachable(socket.host))
          bound.set(socket.port, socket.host);
      }
      run.bound = bound;
      publish(processId);
    },
  };
}
