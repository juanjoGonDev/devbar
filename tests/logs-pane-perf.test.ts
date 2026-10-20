// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { entry, mountLogsDom } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';

/**
 * A logs window holds up to 50 000 lines and a busy service streams them fast,
 * so the pane must keep drawing a bounded window over the buffer however rich
 * a row gets. This drives a realistic mix — plain, debug, warnings, errors
 * with stack traces, JSON lines — through a full snapshot and a burst of
 * arrivals, and holds both to a DOM budget and a (generous, jsdom-sized) time
 * budget. The times are printed in the assertion messages for comparison.
 */
const HELD = 50_000;
const BURST = 5_000;
/** The pane's window plus one edge chunk: the most rows it may ever hold. */
const DOM_BUDGET = 900;

function mixed(i: number): LogEntry {
  switch (i % 10) {
    case 0:
      return entry(`Error: socket hang up ${i}`, { ts: i, level: 'error' });
    case 1:
      return entry(`    at TLSSocket.onClose (node:_tls:${i}:27)`, { ts: i });
    case 2:
      return entry(`    at emit (node:events:${i}:11)`, { ts: i });
    case 3:
      return entry(`[debug] tick ${i}`, { ts: i });
    case 4:
      return entry(`{"level":"info","route":"/api/users","ms":${i}}`, {
        ts: i,
      });
    case 5:
      return entry(`(node:1) DeprecationWarning ${i}`, {
        ts: i,
        level: 'warn',
      });
    default:
      return entry(`\u001b[32mGET\u001b[0m /api/health 200 ${i}ms`, { ts: i });
  }
}

describe('renderer/logs/pane.ts (large buffers)', () => {
  beforeEach(() => {
    mountLogsDom();
  });

  it('draws a 50k-line snapshot and a 5k-line burst inside the DOM budget', async () => {
    const pane = await import('../renderer/logs/pane.js');
    const { linesEl } = await import('../renderer/logs/elements.js');
    const { view } = await import('../renderer/logs/view.js');
    view.memoryCap = HELD + BURST;
    const held = Array.from({ length: HELD }, (_, i) => mixed(i));

    const t0 = performance.now();
    pane.resetBuffer(held);
    const snapshotMs = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < BURST; i += 1) pane.pushEntry(mixed(HELD + i));
    const burstMs = performance.now() - t1;

    const timing = `snapshot ${snapshotMs.toFixed(0)} ms, burst ${burstMs.toFixed(0)} ms`;
    if (process.env.LOGS_PERF) process.stdout.write(`${timing}\n`);
    expect(linesEl.childElementCount, timing).toBeLessThanOrEqual(DOM_BUDGET);
    expect(snapshotMs, timing).toBeLessThan(3_000);
    expect(burstMs, timing).toBeLessThan(6_000);
  }, 30_000);
});
