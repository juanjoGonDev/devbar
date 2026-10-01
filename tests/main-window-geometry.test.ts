import { describe, expect, it } from 'vitest';
import {
  adaptiveSize,
  bannerBounds,
  clampXToWorkArea,
  hasTrayBounds,
  nativeWaylandWorkArea,
  taskbarSideOf,
  trayPopoverBounds,
  trayPopoverHeight,
  trayPositionForTaskbarSide,
} from '../src/main/window-geometry.js';

const primary = { x: 0, y: 25, width: 1440, height: 875 };
/** A display to the right of the primary one, as macOS reports it. */
const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('src/main/window-geometry.ts', () => {
  describe('adaptiveSize', () => {
    it('centres the window inside the work area it is given', () => {
      const placement = adaptiveSize(primary, 820, 640);
      expect(placement).toEqual({
        width: 820,
        height: 640,
        x: Math.round((1440 - 820) / 2),
        y: Math.round(25 + (875 - 640) / 2),
      });
    });

    it('places relative to a secondary display, not the primary one', () => {
      expect(adaptiveSize(secondary, 800, 600).x).toBeGreaterThanOrEqual(1440);
    });

    it('shrinks to fit a small screen, keeping the margins', () => {
      const placement = adaptiveSize(
        { x: 0, y: 0, width: 700, height: 500 },
        1180,
        640,
      );
      expect(placement.width).toBe(640);
      expect(placement.height).toBe(400);
    });

    it('never goes below the readable minimum', () => {
      const placement = adaptiveSize(
        { x: 0, y: 0, width: 300, height: 200 },
        1180,
        640,
      );
      expect(placement.width).toBe(420);
      expect(placement.height).toBe(360);
    });

    it('honours custom margins', () => {
      expect(adaptiveSize(primary, 2000, 2000, 0, 0).width).toBe(1440);
    });
  });

  describe('bannerBounds', () => {
    it('pins the banner to the top-right of the work area', () => {
      expect(bannerBounds(primary)).toEqual({
        width: 360,
        height: 76,
        x: 1440 - 360 - 12,
        y: 25 + 12,
      });
    });

    it('follows the origin of a secondary display', () => {
      expect(bannerBounds(secondary).x).toBe(1440 + 1920 - 360 - 12);
    });
  });

  describe('trayPopoverHeight', () => {
    it('adds the 4px slack the renderer measurement needs', () => {
      expect(trayPopoverHeight(300, 900)).toBe(304);
    });

    it('rounds a fractional measurement up', () => {
      expect(trayPopoverHeight(300.2, 900)).toBe(305);
    });

    it('clamps to the work area minus the menubar allowance', () => {
      expect(trayPopoverHeight(5000, 900)).toBe(820);
    });

    it('keeps a floor even on a tiny screen', () => {
      expect(trayPopoverHeight(10, 100)).toBe(160);
      expect(trayPopoverHeight(5000, 100)).toBe(280);
    });
  });

  describe('trayPopoverBounds', () => {
    /** Windows 1080p with the taskbar along the bottom edge. */
    const winWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
    /** macOS: the menubar takes the top 25px. */
    const macWorkArea = { x: 0, y: 25, width: 1440, height: 875 };

    it('grows upward from a bottom taskbar, keeping the bottom edge on it', () => {
      const current = { x: 1500, y: 540, width: 410, height: 500 };
      expect(trayPopoverBounds(current, 696, winWorkArea)).toEqual({
        x: 1500,
        y: 340,
        width: 410,
        height: 700,
      });
    });

    it('shrinks toward a bottom taskbar instead of floating above it', () => {
      const current = { x: 1500, y: 340, width: 410, height: 700 };
      const next = trayPopoverBounds(current, 196, winWorkArea);
      expect(next.height).toBe(200);
      expect(next.y + next.height).toBe(1040);
    });

    it('grows downward from the macOS menubar, keeping the top edge', () => {
      const current = { x: 900, y: 25, width: 410, height: 300 };
      expect(trayPopoverBounds(current, 596, macWorkArea)).toEqual({
        x: 900,
        y: 25,
        width: 410,
        height: 600,
      });
    });

    it('caps the height to the work area of the display it is on', () => {
      const current = { x: 1500, y: 540, width: 410, height: 500 };
      const next = trayPopoverBounds(current, 5000, winWorkArea);
      expect(next.height).toBe(960);
      expect(next.y).toBeGreaterThanOrEqual(winWorkArea.y);
      expect(next.y + next.height).toBeLessThanOrEqual(1040);
    });

    it('places relative to a secondary display, not the primary one', () => {
      const second = { x: 1920, y: 0, width: 1920, height: 1040 };
      const current = { x: 3400, y: 840, width: 410, height: 200 };
      const next = trayPopoverBounds(current, 496, second);
      expect(next).toEqual({ x: 3400, y: 540, width: 410, height: 500 });
    });

    it('pulls a popover that would cross the bottom edge back on screen', () => {
      // A side taskbar with the icon low on it: the popover hangs from the
      // icon, so growing in place would run past the bottom of the screen.
      const current = { x: 60, y: 300, width: 410, height: 300 };
      const next = trayPopoverBounds(current, 896, winWorkArea);
      expect(next.y + next.height).toBeLessThanOrEqual(1040);
      expect(next.height).toBe(900);
    });

    it('keeps the popover inside the work area horizontally', () => {
      const current = { x: 1700, y: 540, width: 410, height: 500 };
      expect(trayPopoverBounds(current, 496, winWorkArea).x).toBe(1510);
    });
  });

  describe('taskbarSideOf', () => {
    it('reads a left panel from the x offset', () => {
      expect(
        taskbarSideOf({
          workArea: { x: 60, y: 0, width: 1380, height: 900 },
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
        }),
      ).toBe('left');
    });

    it('reads a top panel from the y offset', () => {
      expect(
        taskbarSideOf({
          workArea: { x: 0, y: 30, width: 1440, height: 870 },
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
        }),
      ).toBe('top');
    });

    it('reads a right panel from the narrower work area', () => {
      expect(
        taskbarSideOf({
          workArea: { x: 0, y: 0, width: 1380, height: 900 },
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
        }),
      ).toBe('right');
    });

    it('defaults to a bottom panel', () => {
      expect(
        taskbarSideOf({
          workArea: { x: 0, y: 0, width: 1440, height: 870 },
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
        }),
      ).toBe('bottom');
    });
  });

  describe('trayPositionForTaskbarSide', () => {
    it('maps every side to its positioner anchor', () => {
      expect(trayPositionForTaskbarSide('top')).toBe('trayCenter');
      expect(trayPositionForTaskbarSide('bottom')).toBe('trayBottomCenter');
      expect(trayPositionForTaskbarSide('left')).toBe('trayLeft');
      expect(trayPositionForTaskbarSide('right')).toBe('trayRight');
    });
  });

  describe('clampXToWorkArea', () => {
    it('leaves a panel that already fits alone', () => {
      expect(clampXToWorkArea(500, 410, primary)).toBe(500);
    });

    it('pulls a panel back from the left and right edges', () => {
      expect(clampXToWorkArea(-40, 410, primary)).toBe(0);
      expect(clampXToWorkArea(1400, 410, primary)).toBe(1440 - 410);
    });
  });

  describe('hasTrayBounds', () => {
    it('accepts real X11 bounds, including at the origin and off-screen', () => {
      expect(hasTrayBounds({ x: 0, y: 0, width: 22, height: 22 })).toBe(true);
      expect(hasTrayBounds({ x: -300, y: 12, width: 22, height: 22 })).toBe(
        true,
      );
    });

    it('rejects the empty Wayland rectangle and a missing one', () => {
      expect(hasTrayBounds({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);
      expect(hasTrayBounds(undefined)).toBe(false);
    });
  });
  describe('nativeWaylandWorkArea', () => {
    /** The reported Fedora/KDE case: 1280x800, workArea = the whole display. */
    const fedora = {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      workArea: { x: 0, y: 0, width: 1280, height: 800 },
    };

    it('caps the height at 75 % of the display when Wayland reports no panel', () => {
      // 800 - 2 * 56 = 688 vs 0.75 * 800 = 600: the smaller one wins.
      expect(nativeWaylandWorkArea(fedora)).toEqual({
        x: 0,
        y: 0,
        width: 1280,
        height: 600,
      });
    });

    it('keeps a real work area that is already smaller than the cap', () => {
      const display = {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 700 },
      };
      expect(nativeWaylandWorkArea(display).height).toBe(700);
    });

    it('uses the two-panel margin when it is tighter than 75 %', () => {
      const display = {
        bounds: { x: 0, y: 0, width: 800, height: 400 },
        workArea: { x: 0, y: 0, width: 800, height: 400 },
      };
      // 400 - 112 = 288 < 0.75 * 400 = 300.
      expect(nativeWaylandWorkArea(display).height).toBe(288);
    });

    it('keeps a popover under the cap even at the tallest content', () => {
      const capped = nativeWaylandWorkArea(fedora);
      const bounds = trayPopoverBounds(
        { x: 435, y: 150, width: 410, height: 500 },
        5000,
        capped,
      );
      expect(bounds.height).toBeLessThanOrEqual(600);
    });
  });
});
