import { describe, expect, it } from 'vitest';
import {
  nextPinnedFrame,
  normalizePinnedPopover,
  pinnedAutoHeightBounds,
  restorePinnedBounds,
  toPinnedPopover,
} from '../src/main/pinned-popover-geometry.js';

/** The macOS built-in display, under a 25px menu bar. */
const builtIn = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
/** An external display to the right of it. */
const external = {
  id: 2,
  workArea: { x: 1440, y: 0, width: 1920, height: 1080 },
};

describe('src/main/pinned-popover-geometry.ts', () => {
  describe('toPinnedPopover', () => {
    it('stores the position relative to the display work area', () => {
      expect(
        toPinnedPopover({ x: 1540, y: 200, width: 420, height: 600 }, external),
      ).toEqual({ displayId: 2, x: 100, y: 200, width: 420, height: 600 });
    });

    it('rounds fractional DIPs a scaled Windows display can report', () => {
      expect(
        toPinnedPopover(
          { x: 10.4, y: 125.6, width: 420.5, height: 599.5 },
          builtIn,
        ),
      ).toEqual({ displayId: 1, x: 10, y: 101, width: 421, height: 600 });
    });
  });

  describe('normalizePinnedPopover', () => {
    it('keeps a well-formed record', () => {
      const saved = { displayId: 2, x: 100, y: 200, width: 420, height: 600 };
      expect(normalizePinnedPopover(saved)).toEqual(saved);
    });

    it('drops a hand-edited record with a missing or non-numeric field', () => {
      expect(normalizePinnedPopover(null)).toBeNull();
      expect(normalizePinnedPopover('pinned')).toBeNull();
      expect(
        normalizePinnedPopover({ displayId: 2, x: 'a', y: 0, width: 420 }),
      ).toBeNull();
    });

    it('drops a record too small to be a usable popover', () => {
      expect(
        normalizePinnedPopover({
          displayId: 1,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        }),
      ).toBeNull();
    });
  });

  describe('restorePinnedBounds', () => {
    it('turns the saved record back into screen coordinates on its display', () => {
      expect(
        restorePinnedBounds(
          { displayId: 2, x: 100, y: 200, width: 420, height: 600 },
          [builtIn, external],
        ),
      ).toEqual({ x: 1540, y: 200, width: 420, height: 600 });
    });

    it('gives up when the saved display is no longer connected', () => {
      expect(
        restorePinnedBounds(
          { displayId: 2, x: 100, y: 200, width: 420, height: 600 },
          [builtIn],
        ),
      ).toBeNull();
    });

    it('gives up when less than half of the popover would be visible', () => {
      // The display's resolution changed: the saved spot now sits mostly
      // beyond its right edge.
      expect(
        restorePinnedBounds(
          { displayId: 1, x: 1300, y: 100, width: 420, height: 600 },
          [builtIn],
        ),
      ).toBeNull();
    });

    it('pulls a mostly visible popover fully inside the work area', () => {
      expect(
        restorePinnedBounds(
          { displayId: 1, x: 1100, y: 400, width: 420, height: 600 },
          [builtIn],
        ),
      ).toEqual({ x: 1020, y: 300, width: 420, height: 600 });
    });

    it('counts the part that spills onto a neighbouring display as visible', () => {
      // The same spot that is lost on a lone built-in display: with the
      // external one plugged in, the part past the seam is on screen too.
      expect(
        restorePinnedBounds(
          { displayId: 1, x: 1300, y: 100, width: 420, height: 600 },
          [builtIn, external],
        ),
      ).toEqual({ x: 1020, y: 125, width: 420, height: 600 });
    });

    it('shrinks a popover larger than its display down to the work area', () => {
      expect(
        restorePinnedBounds(
          { displayId: 1, x: 0, y: 0, width: 2000, height: 1200 },
          [builtIn],
        ),
      ).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    });
  });

  describe('pinnedAutoHeightBounds', () => {
    const frame = { x: 300, y: 100, width: 420, height: 600 };

    it('shrinks to the content, keeping the top edge in the upper half', () => {
      expect(pinnedAutoHeightBounds(frame, 296, builtIn.workArea)).toEqual({
        x: 300,
        y: 100,
        width: 420,
        height: 300,
      });
    });

    it('never grows past the height the user gave it', () => {
      expect(pinnedAutoHeightBounds(frame, 2000, builtIn.workArea).height).toBe(
        600,
      );
    });

    it('keeps the bottom edge when the popover sits in the lower half', () => {
      const low = { x: 300, y: 500, width: 420, height: 380 };
      expect(pinnedAutoHeightBounds(low, 196, builtIn.workArea)).toEqual({
        x: 300,
        y: 680,
        width: 420,
        height: 200,
      });
    });

    it('stays inside the work area', () => {
      const offRight = { x: 1300, y: 10, width: 420, height: 600 };
      expect(pinnedAutoHeightBounds(offRight, 296, builtIn.workArea)).toEqual({
        x: 1020,
        y: 25,
        width: 420,
        height: 300,
      });
    });
  });

  describe('nextPinnedFrame', () => {
    const shown = { x: 300, y: 100, width: 420, height: 300 };

    it('starts from the current bounds on the first user change', () => {
      const moved = { x: 340, y: 160, width: 420, height: 300 };
      expect(nextPinnedFrame(null, shown, moved)).toEqual(moved);
    });

    it('moves the frame by the drag delta, keeping the saved max height', () => {
      const frame = { x: 300, y: 100, width: 420, height: 600 };
      const moved = { x: 350, y: 80, width: 420, height: 300 };
      expect(nextPinnedFrame(frame, shown, moved)).toEqual({
        x: 350,
        y: 80,
        width: 420,
        height: 600,
      });
    });

    it('takes the new size as the frame after a resize', () => {
      const frame = { x: 300, y: 100, width: 420, height: 600 };
      const resized = { x: 300, y: 100, width: 500, height: 450 };
      expect(nextPinnedFrame(frame, shown, resized)).toEqual(resized);
    });
  });
});
