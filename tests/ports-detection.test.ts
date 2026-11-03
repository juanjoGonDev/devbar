import { describe, expect, it, vi } from 'vitest';
import type { DetectedPort } from '../src/domain-types.js';
import {
  createPortClassifier,
  type PortKind,
} from '../src/ports/http-probe.js';
import { createPortDetection } from '../src/ports/port-detection.js';

const ID = 'cmd:g:front';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(kinds: Record<string, PortKind> = {}) {
  const published = new Map<string, DetectedPort[]>();
  const probe = vi.fn((url: string) => Promise.resolve(kinds[url] ?? 'other'));
  const nudge = vi.fn();
  const detection = createPortDetection({
    setPorts: (id, ports) => published.set(id, ports),
    classifier: createPortClassifier(probe),
    hostNames: () => ({ hostname: 'mbp', lanAddresses: ['192.168.1.20'] }),
    nudge,
  });
  const start = (startedAt = 1): void =>
    detection.onState({ id: ID, status: 'running', startedAt });
  return { detection, published, probe, nudge, start };
}

describe('src/ports/port-detection.ts', () => {
  it('publishes a log-announced web port with its tool label once probed', async () => {
    const { detection, published, nudge, start } = setup({
      'http://localhost:5173/': 'web',
    });
    start();
    expect(nudge).toHaveBeenCalledOnce();
    detection.onLog(ID, '  VITE v5.2.0  ready in 312 ms');
    detection.onLog(ID, '  ➜  Local:   http://localhost:5173/');
    expect(nudge).toHaveBeenCalledTimes(2);
    await flush();
    expect(published.get(ID)).toEqual([
      {
        port: 5173,
        url: 'http://localhost:5173/',
        kind: 'web',
        source: 'log',
        label: 'Vite',
        lanReachable: false,
      },
    ]);
  });

  it('marks a log port reachable once a scan shows it bound to every interface', async () => {
    const { detection, published, start } = setup({
      'http://localhost:3000/': 'web',
    });
    start();
    detection.onLog(ID, 'Local: http://localhost:3000');
    detection.onScan(ID, [{ pid: 1, host: '*', port: 3000 }]);
    await flush();
    expect(published.get(ID)?.[0]).toMatchObject({
      port: 3000,
      source: 'log',
      lanReachable: true,
    });
  });

  it('publishes socket-only ports with their kind, primary web first', async () => {
    const { detection, published, start } = setup({
      'http://localhost:8080/': 'web',
      'http://127.0.0.1:9000/': 'http',
    });
    start();
    detection.onScan(ID, [
      { pid: 1, host: '0.0.0.0', port: 5432 },
      { pid: 1, host: '127.0.0.1', port: 9000 },
      { pid: 2, host: '0.0.0.0', port: 8080 },
      { pid: 2, host: '127.0.0.1', port: 8080 },
    ]);
    await flush();
    const ports = published.get(ID) ?? [];
    // The registry sorts; here the classified set is what matters.
    expect(
      ports.map((p) => [p.port, p.kind, p.source, p.lanReachable]).sort(),
    ).toEqual([
      [5432, 'other', 'socket', true],
      [8080, 'web', 'socket', true],
      [9000, 'http', 'socket', false],
    ]);
  });

  it('drops a log URL nothing HTTP answers on and no scan has seen', async () => {
    const { detection, published, start } = setup();
    start();
    detection.onLog(ID, 'Proxy target: listening on port 4000');
    await flush();
    expect(published.get(ID)).toEqual([]);
  });

  it('probes each port once per run and again after a restart', async () => {
    const { detection, probe, start } = setup({
      'http://localhost:3000/': 'web',
    });
    start(1);
    detection.onScan(ID, [{ pid: 1, host: '*', port: 3000 }]);
    await flush();
    detection.onScan(ID, [{ pid: 1, host: '*', port: 3000 }]);
    await flush();
    expect(probe).toHaveBeenCalledOnce();
    start(2);
    detection.onScan(ID, [{ pid: 1, host: '*', port: 3000 }]);
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('clears the ports when the command stops and ignores its late scans', async () => {
    const { detection, published, start } = setup({
      'http://localhost:3000/': 'web',
    });
    start();
    detection.onScan(ID, [{ pid: 1, host: '*', port: 3000 }]);
    await flush();
    detection.onState({ id: ID, status: 'stopped', startedAt: 1 });
    expect(published.get(ID)).toEqual([]);
    detection.onScan(ID, [{ pid: 1, host: '*', port: 3000 }]);
    await flush();
    expect(published.get(ID)).toEqual([]);
  });

  it('never tracks actions or pre-scripts', () => {
    const { detection, published, nudge } = setup();
    detection.onState({ id: 'act:g:seed', status: 'running', startedAt: 1 });
    detection.onLog('act:g:seed', 'listening on port 3000');
    expect(nudge).not.toHaveBeenCalled();
    expect(published.size).toBe(0);
  });
});
