import { describe, expect, it } from 'vitest';

import { latestWins } from '../renderer/latest-wins.js';

describe('renderer/latest-wins.ts', () => {
  describe('latestWins', () => {
    it('lets a claim win while nothing newer has landed', () => {
      const guard = latestWins();
      const current = guard.claim();
      expect(current()).toBe(true);
    });

    it('retires a claim once a newer value is applied', () => {
      const guard = latestWins();
      const current = guard.claim();
      guard.invalidate();
      expect(current()).toBe(false);
    });

    it('retires a claim captured before the push, not after it', () => {
      // The ordering that matters: capture, push, resolve. Capturing inside
      // the `then` would read the revision the push had already moved and
      // the stale write would win.
      const guard = latestWins();
      const beforePush = guard.claim();
      guard.invalidate();
      const afterPush = guard.claim();
      expect(beforePush()).toBe(false);
      expect(afterPush()).toBe(true);
    });

    it('retires every outstanding claim, not just the newest', () => {
      const guard = latestWins();
      const first = guard.claim();
      const second = guard.claim();
      guard.invalidate();
      expect(first()).toBe(false);
      expect(second()).toBe(false);
    });

    it('keeps a later claim valid across repeated pushes', () => {
      const guard = latestWins();
      guard.invalidate();
      guard.invalidate();
      const current = guard.claim();
      expect(current()).toBe(true);
      guard.invalidate();
      expect(current()).toBe(false);
    });

    it('keeps separate guards independent', () => {
      const groups = latestWins();
      const pipeline = latestWins();
      const groupClaim = groups.claim();
      const pipelineClaim = pipeline.claim();
      pipeline.invalidate();
      expect(groupClaim()).toBe(true);
      expect(pipelineClaim()).toBe(false);
    });
  });
});
