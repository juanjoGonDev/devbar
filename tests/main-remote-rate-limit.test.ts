import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/main/remote/rate-limit.js';

function harness(limit = 5) {
  let clock = 0;
  const limiter = createRateLimiter({
    limit,
    windowMs: 60_000,
    now: () => clock,
  });
  return {
    limiter,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('src/main/remote/rate-limit.ts', () => {
  it('allows up to the limit inside the window, then refuses', () => {
    const h = harness();
    const verdicts = Array.from({ length: 6 }, () => h.limiter.allow('ip'));

    expect(verdicts).toEqual([true, true, true, true, true, false]);
  });

  it('counts each key on its own', () => {
    const h = harness(1);
    h.limiter.allow('a');

    expect(h.limiter.allow('a')).toBe(false);
    expect(h.limiter.allow('b')).toBe(true);
  });

  it('frees a slot once the oldest attempt leaves the sliding window', () => {
    const h = harness(2);
    h.limiter.allow('ip');
    h.advance(30_000);
    h.limiter.allow('ip');
    expect(h.limiter.allow('ip')).toBe(false);

    h.advance(30_000);
    expect(h.limiter.allow('ip')).toBe(true);
    expect(h.limiter.allow('ip')).toBe(false);
  });

  it('does not count a refused attempt against the next window', () => {
    const h = harness(1);
    h.limiter.allow('ip');
    for (let i = 0; i < 10; i++) h.limiter.allow('ip');
    h.advance(60_000);

    expect(h.limiter.allow('ip')).toBe(true);
  });
});
