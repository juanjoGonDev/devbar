import { describe, expect, it } from 'vitest';
import { createArrivals } from '../src/main/remote/arrivals.js';

/**
 * When a linked device «connecting» is worth telling the user about: its
 * first connection since DevBar started, or one after at least ten minutes
 * of continuous absence — never a reload, a tab switch or a stream that
 * reconnected a moment later.
 */

const MINUTE = 60_000;

function harness() {
  let clock = 1_000_000;
  const arrivals = createArrivals({ now: () => clock });
  return {
    arrivals,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('src/main/remote/arrivals.ts', () => {
  it('announces the first connection of a device since start, once', () => {
    const h = harness();

    expect(h.arrivals.arrived('d1', false)).toBe(true);
    h.advance(100);
    // Its stream opening right after the auth is the same arrival.
    expect(h.arrivals.arrived('d1', false)).toBe(false);
    expect(h.arrivals.arrived('d2', false)).toBe(true);
  });

  it('stays quiet across reloads and reconnects', () => {
    const h = harness();
    h.arrivals.arrived('d1', false);
    h.advance(30 * MINUTE);

    h.arrivals.left('d1');
    h.advance(2000);

    expect(h.arrivals.arrived('d1', false)).toBe(false);
  });

  it('announces a device back after ten minutes away', () => {
    const h = harness();
    h.arrivals.arrived('d1', false);
    h.arrivals.left('d1');

    h.advance(9 * MINUTE);
    expect(h.arrivals.arrived('d1', false)).toBe(false);
    h.arrivals.left('d1');
    h.advance(10 * MINUTE);
    expect(h.arrivals.arrived('d1', false)).toBe(true);
  });

  it('never announces a device that is connected already', () => {
    const h = harness();
    h.arrivals.arrived('d1', false);
    h.advance(60 * MINUTE);

    expect(h.arrivals.arrived('d1', true)).toBe(false);
  });

  it('counts a device seen once and never again as absent', () => {
    const h = harness();
    h.arrivals.arrived('d1', false);
    h.advance(20 * MINUTE);

    expect(h.arrivals.arrived('d1', false)).toBe(true);
  });
});
