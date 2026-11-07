import { describe, expect, it } from 'vitest';
import {
  EDGE_PX,
  endGesture,
  moveGesture,
  startGesture,
  type Gesture,
  type Sample,
} from '../renderer/remote/drawer-gesture.js';

/**
 * The swipe that opens and closes the phone's side menu, as pure decisions
 * over pointer samples: whether a press may start it, how far the drawer
 * follows the finger, and where it settles on release.
 */

const WIDTH = 286;
const at = (x: number, t = 0, y = 400): Sample => ({ x, y, t });

/** Feeds the moves in order; throws if the press could not start. */
function drag(open: boolean, ...samples: Sample[]): Gesture {
  const [first, ...rest] = samples;
  if (!first) throw new Error('no samples');
  let gesture = startGesture(first, open);
  if (!gesture) throw new Error('the press did not start a gesture');
  for (const sample of rest) gesture = moveGesture(gesture, sample, WIDTH);
  return gesture;
}

describe('renderer/remote/drawer-gesture.ts', () => {
  describe('starting', () => {
    it('opens only from a press at the left edge of the screen', () => {
      expect(startGesture(at(EDGE_PX), false)).not.toBeNull();
      expect(startGesture(at(EDGE_PX + 1), false)).toBeNull();
    });

    it('closes from a press anywhere while the drawer is open', () => {
      expect(startGesture(at(200), true)).not.toBeNull();
    });
  });

  describe('following the finger', () => {
    it('waits until the finger has really moved', () => {
      const gesture = drag(false, at(4), at(8, 10));

      expect(gesture.phase).toBe('pending');
      expect(gesture.progress).toBe(0);
    });

    it('lets a mostly vertical move scroll the page instead', () => {
      const gesture = drag(false, at(4, 0, 400), at(10, 10, 440));

      expect(gesture.phase).toBe('ignored');
      expect(endGesture(gesture, WIDTH)).toBeNull();
    });

    it('tracks a horizontal drag as a share of the drawer width', () => {
      const gesture = drag(false, at(0), at(20, 10), at(143, 200));

      expect(gesture.phase).toBe('dragging');
      expect(gesture.progress).toBeCloseTo(0.5);
    });

    it('never goes past fully open or fully closed', () => {
      expect(drag(false, at(0), at(20, 10), at(600, 400)).progress).toBe(1);
      expect(drag(true, at(200), at(180, 10), at(-300, 400)).progress).toBe(0);
    });

    it('starts an open drawer from fully open', () => {
      const gesture = drag(true, at(250), at(230, 10), at(200, 400));

      expect(gesture.progress).toBeCloseTo(1 - 50 / WIDTH);
    });
  });

  describe('settling on release', () => {
    it('opens once dragged past 40% of its width', () => {
      expect(
        endGesture(drag(false, at(0), at(20, 100), at(120, 600)), WIDTH),
      ).toBe(true);
    });

    it('snaps back closed when released short of it', () => {
      expect(
        endGesture(drag(false, at(0), at(20, 100), at(100, 600)), WIDTH),
      ).toBe(false);
    });

    it('opens on a quick flick, however short', () => {
      expect(
        endGesture(drag(false, at(0), at(20, 10), at(60, 40)), WIDTH),
      ).toBe(true);
    });

    it('closes when the open drawer is dragged 40% to the left', () => {
      expect(
        endGesture(drag(true, at(260), at(240, 100), at(140, 600)), WIDTH),
      ).toBe(false);
    });

    it('stays open after a small slow drag to the left', () => {
      expect(
        endGesture(drag(true, at(260), at(240, 100), at(220, 600)), WIDTH),
      ).toBe(true);
    });

    it('closes the open drawer on a quick flick to the left', () => {
      expect(
        endGesture(drag(true, at(260), at(240, 10), at(200, 40)), WIDTH),
      ).toBe(false);
    });

    it('reads a flick from the last moves only, not the whole drag', () => {
      // A fast start, then a long pause: no longer a flick.
      expect(
        endGesture(
          drag(false, at(0), at(60, 20), at(80, 40), at(80, 900)),
          WIDTH,
        ),
      ).toBe(false);
    });

    it('decides nothing for a press that never became a drag (a tap)', () => {
      expect(endGesture(drag(true, at(300)), WIDTH)).toBeNull();
    });
  });
});
