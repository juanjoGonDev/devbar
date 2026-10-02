/**
 * Sliding-window limiter: at most `limit` allowed attempts per key within
 * `windowMs`. Refused attempts are not recorded, so hammering does not
 * extend the lock-out beyond the window. Keys whose attempts have all aged
 * out are dropped, which keeps the map from growing with every address
 * that ever knocked.
 */
export interface RateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now: () => number;
}): RateLimiter {
  const attempts = new Map<string, number[]>();

  const sweep = (now: number): void => {
    for (const [key, times] of attempts) {
      const recent = times.filter((time) => now - time < options.windowMs);
      if (recent.length) attempts.set(key, recent);
      else attempts.delete(key);
    }
  };

  return {
    allow: (key) => {
      const now = options.now();
      sweep(now);
      const recent = attempts.get(key) ?? [];
      if (recent.length >= options.limit) return false;
      attempts.set(key, [...recent, now]);
      return true;
    },
  };
}
