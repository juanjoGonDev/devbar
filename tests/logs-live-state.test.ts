import { describe, expect, it } from 'vitest';

import {
  LIVE,
  isHolding,
  liveLabel,
  nextLive,
  type LiveEvent,
  type LiveState,
} from '../renderer/logs/live-state.js';

/** Fold a sequence of events from the live state. */
function run(...events: LiveEvent[]): LiveState {
  return events.reduce(nextLive, LIVE);
}

describe('renderer/logs/live-state.ts', () => {
  describe('nextLive', () => {
    it('starts live, following the tail', () => {
      expect(LIVE).toEqual({ following: true, cause: null, unseen: 0 });
    });

    it('scrolling away pauses without holding lines back', () => {
      const state = run({ type: 'leftTail' });
      expect(state).toEqual({ following: false, cause: 'scroll', unseen: 0 });
      expect(isHolding(state)).toBe(false);
    });

    it('pressing pauses and holds lines back, as «Pausa» did', () => {
      const state = run({ type: 'press' });
      expect(state).toEqual({ following: false, cause: 'manual', unseen: 0 });
      expect(isHolding(state)).toBe(true);
    });

    it('pressing again resumes', () => {
      expect(run({ type: 'press' }, { type: 'press' })).toBe(LIVE);
    });

    it('pressing while scrolled away resumes rather than pausing harder', () => {
      expect(run({ type: 'leftTail' }, { type: 'press' })).toBe(LIVE);
    });

    it('scrolling back to the tail resumes a scroll pause', () => {
      const state = run(
        { type: 'leftTail' },
        { type: 'reachedTail', canResume: true },
      );
      expect(state).toBe(LIVE);
    });

    it('never resumes on its own while lines are selected', () => {
      const state = run(
        { type: 'leftTail' },
        { type: 'reachedTail', canResume: false },
      );
      expect(state.following).toBe(false);
    });

    it('reaching the tail does not undo a pause the reader asked for', () => {
      const state = run(
        { type: 'press' },
        { type: 'reachedTail', canResume: true },
      );
      expect(state.cause).toBe('manual');
    });

    it('leaving the tail while manually paused keeps the manual pause', () => {
      expect(run({ type: 'press' }, { type: 'leftTail' }).cause).toBe('manual');
    });

    it('resume always lands on live, whatever the cause', () => {
      expect(run({ type: 'press' }, { type: 'resume' })).toBe(LIVE);
      expect(run({ type: 'leftTail' }, { type: 'resume' })).toBe(LIVE);
      expect(run({ type: 'resume' })).toBe(LIVE);
    });

    it('counts what arrives while paused, and nothing while live', () => {
      expect(run({ type: 'arrived', count: 3 })).toBe(LIVE);
      const state = run(
        { type: 'leftTail' },
        { type: 'arrived', count: 2 },
        { type: 'arrived', count: 1 },
      );
      expect(state.unseen).toBe(3);
    });

    it('a reset forgets the count but keeps the pause', () => {
      const state = run(
        { type: 'press' },
        { type: 'arrived', count: 4 },
        { type: 'reset' },
      );
      expect(state).toEqual({ following: false, cause: 'manual', unseen: 0 });
    });

    it('returns the same object when nothing changed', () => {
      const paused = run({ type: 'leftTail' });
      expect(nextLive(paused, { type: 'leftTail' })).toBe(paused);
      expect(nextLive(paused, { type: 'reset' })).toBe(paused);
      expect(nextLive(paused, { type: 'arrived', count: 0 })).toBe(paused);
    });
  });

  describe('liveLabel', () => {
    it('says it is live while following', () => {
      expect(liveLabel(LIVE).text).toBe('En directo');
    });

    it('says it is paused, and how much is waiting', () => {
      expect(liveLabel(run({ type: 'press' })).text).toBe('En pausa');
      expect(
        liveLabel(run({ type: 'leftTail' }, { type: 'arrived', count: 5 }))
          .text,
      ).toBe('En pausa · 5 nuevas');
    });

    it('tells the reader what pressing it does', () => {
      expect(liveLabel(LIVE).title).toMatch(/pausar/u);
      expect(liveLabel(run({ type: 'press' })).title).toMatch(/directo/u);
    });
  });
});
