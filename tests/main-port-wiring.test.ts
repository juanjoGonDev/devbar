import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedPort, LogEntry } from '../src/domain-types.js';
import { createPortClassifier } from '../src/ports/http-probe.js';
import { attachPortDetection } from '../src/main/port-wiring.js';

class FakeProcessManager extends EventEmitter {
  roots: Array<{ id: string; pid: number }> = [];
  runningCommandRoots(): Array<{ id: string; pid: number }> {
    return this.roots;
  }
}

const ID = 'cmd:g:api';

function log(
  line: string,
  stream: LogEntry['stream'] = 'stdout',
): {
  id: string;
  entry: LogEntry;
} {
  return { id: ID, entry: { ts: 0, stream, level: null, line } };
}

describe('src/main/port-wiring.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const pm = new FakeProcessManager();
    const published = new Map<string, DetectedPort[]>();
    const scan = vi.fn((roots: number[]) =>
      Promise.resolve(
        new Map(roots.map((pid) => [pid, [{ pid, host: '*', port: 8080 }]])),
      ),
    );
    attachPortDetection(
      pm,
      { setProcessPorts: (id, ports) => published.set(id, ports) },
      {
        scan,
        classifier: createPortClassifier(() => Promise.resolve('web')),
      },
    );
    return { pm, published, scan };
  }

  it('scans ~1 s after a command starts and publishes what it listens on', async () => {
    const { pm, published, scan } = setup();
    pm.roots = [{ id: ID, pid: 42 }];
    pm.emit('change', { id: ID, status: 'running', startedAt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledWith([42]);
    expect(published.get(ID)).toEqual([
      {
        port: 8080,
        url: 'http://localhost:8080/',
        kind: 'web',
        source: 'socket',
        lanReachable: true,
      },
    ]);
  });

  it("feeds service output to the log parser but not DevBar's own lines", async () => {
    const { pm, published } = setup();
    pm.emit('change', { id: ID, status: 'running', startedAt: 1 });
    pm.emit('log', log('▶ start: zsh -ic "serve on port 9999"', 'sys'));
    pm.emit('log', log('Local: http://localhost:5173/'));
    await vi.advanceTimersByTimeAsync(0);
    expect(published.get(ID)?.map((p) => p.port)).toEqual([5173]);
  });

  it('does not scan while nothing runs', async () => {
    const { scan } = setup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).not.toHaveBeenCalled();
  });
});
