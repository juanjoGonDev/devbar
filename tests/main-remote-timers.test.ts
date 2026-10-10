import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_TIMERS } from '../src/main/remote/timers.js';

describe('src/main/remote/timers.ts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules and cancels through the real clock', () => {
    vi.useFakeTimers();
    const once = vi.fn();
    const repeated = vi.fn();
    const cancelled = vi.fn();

    NODE_TIMERS.setTimeout(once, 100);
    const interval = NODE_TIMERS.setInterval(repeated, 100);
    NODE_TIMERS.clearTimeout(NODE_TIMERS.setTimeout(cancelled, 100));
    vi.advanceTimersByTime(250);
    NODE_TIMERS.clearInterval(interval);
    vi.advanceTimersByTime(250);

    expect(once).toHaveBeenCalledOnce();
    expect(repeated).toHaveBeenCalledTimes(2);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
