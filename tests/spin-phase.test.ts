// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { spinPhase } from '../renderer/spin-phase.js';

/**
 * A running indicator is rebuilt whenever its elapsed time repaints; without
 * a phase lock every rebuild restarts its loop from frame zero, so it
 * stutters once a second. Locked to the page clock, a rebuilt one picks up
 * exactly where the one it replaced was.
 */

describe('renderer/spin-phase.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the loop as if it had been running since the page clock began', () => {
    vi.spyOn(performance, 'now').mockReturnValue(12_345.5);
    const node = spinPhase(document.createElement('span'));
    expect(node.style.animationDelay).toBe('-12345.5ms');
  });

  it('gives a rebuilt indicator the phase of the one it replaces', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const before = spinPhase(document.createElement('span'));
    clock.mockReturnValue(1_950);
    const after = spinPhase(document.createElement('span'));
    // Both started at clock 0: at any instant they sit on the same frame.
    expect(1_000 + Number.parseFloat(before.style.animationDelay)).toBe(0);
    expect(1_950 + Number.parseFloat(after.style.animationDelay)).toBe(0);
  });

  it('hands back the node it was given, for inline use', () => {
    const node = document.createElement('span');
    expect(spinPhase(node)).toBe(node);
  });
});
