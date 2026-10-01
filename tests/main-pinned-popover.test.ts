import { describe, expect, it } from 'vitest';
import {
  createMenubarPinnedPopover,
  createPinnedPopover,
  patchPinnedPositioning,
  type PinnedPopoverDeps,
  type PopoverWindow,
} from '../src/main/pinned-popover.js';
import type {
  DisplayArea,
  PinnedPopover,
} from '../src/main/pinned-popover-geometry.js';
import type { Rect } from '../src/main/window-geometry.js';

type WindowEvent = 'move' | 'resize' | 'will-move' | 'will-resize';

const builtIn: DisplayArea = {
  id: 1,
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
};
const external: DisplayArea = {
  id: 2,
  workArea: { x: 1440, y: 0, width: 1920, height: 1080 },
};

/** The popover where menubar anchors it, under the macOS tray icon. */
const anchored: Rect = { x: 900, y: 25, width: 410, height: 300 };

function fakeWindow(initial: Rect) {
  let bounds = { ...initial };
  let visible = true;
  const listeners = new Map<WindowEvent, (() => void)[]>();
  const setBoundsCalls: Rect[] = [];
  const emit = (event: WindowEvent): void => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  const win: PopoverWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    getBounds: () => ({ ...bounds }),
    // Like Electron on Linux: a programmatic setBounds still emits
    // move/resize — the controller has to tell those apart itself.
    setBounds: (next) => {
      setBoundsCalls.push({ ...next });
      const resized =
        next.width !== bounds.width || next.height !== bounds.height;
      const moved = next.x !== bounds.x || next.y !== bounds.y;
      bounds = { ...next };
      if (moved) emit('move');
      if (resized) emit('resize');
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return win;
    },
  };
  return {
    win,
    setBoundsCalls,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
    /** The user dragging the window: the OS moves it, no setBounds call. */
    userDrag(next: Partial<Rect>, intent: boolean): void {
      if (intent) emit('will-move');
      bounds = { ...bounds, ...next };
      emit('move');
    },
    userResize(next: Partial<Rect>, intent: boolean): void {
      if (intent) emit('will-resize');
      bounds = { ...bounds, ...next };
      emit('resize');
    },
  };
}

function harness(
  options: {
    saved?: PinnedPopover | null;
    displays?: DisplayArea[];
    overrides?: Partial<PinnedPopoverDeps>;
    bounds?: Rect;
  } = {},
) {
  let clock = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const saves: (PinnedPopover | null)[] = [];
  const notified: boolean[] = [];
  const calls: string[] = [];
  const displays = options.displays ?? [builtIn, external];
  const fake = fakeWindow(options.bounds ?? anchored);
  const controller = createPinnedPopover({
    window: () => fake.win,
    displays: () => displays,
    displayMatching: (rect) =>
      displays.find(
        (d) =>
          rect.x + rect.width / 2 >= d.workArea.x &&
          rect.x + rect.width / 2 < d.workArea.x + d.workArea.width,
      ) ?? builtIn,
    load: () => options.saved ?? null,
    save: (value) => saves.push(value),
    notify: (pinned) => notified.push(pinned),
    reanchor: () => calls.push('reanchor'),
    restorePosition: true,
    intentEvents: false,
    anchoredWidth: 410,
    now: () => clock,
    setTimer: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
    ...options.overrides,
  });
  controller.attach(fake.win);
  return {
    controller,
    fake,
    saves,
    notified,
    calls,
    /** Moves the clock, firing every timer that falls due. */
    advance(ms: number): void {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}

/** What menubar does on every show: emit, position, show, emit. */
function menubarShow(h: ReturnType<typeof harness>): void {
  h.controller.beforeShow();
  const position = h.controller.position();
  const current = h.fake.win.getBounds();
  h.fake.win.setBounds({
    ...current,
    ...(position ?? { x: anchored.x, y: anchored.y }),
  });
  h.fake.show();
  h.controller.afterShow();
}

describe('src/main/pinned-popover.ts', () => {
  describe('telling user moves from DevBar’s own', () => {
    it('ignores the auto-height setBounds and menubar’s own positioning', () => {
      const h = harness();
      menubarShow(h);
      h.controller.programmatic(() =>
        h.fake.win.setBounds({ ...anchored, height: 500 }),
      );
      h.advance(1_000);
      expect(h.controller.isPinned()).toBe(false);
      expect(h.saves).toEqual([]);
    });

    it('pins on the first move the user makes once things settle', () => {
      const h = harness();
      menubarShow(h);
      h.advance(1_000);
      h.fake.userDrag({ x: 500, y: 200 }, false);
      expect(h.controller.isPinned()).toBe(true);
      expect(h.notified).toEqual([true]);
    });

    it('treats a resize as pinning too', () => {
      const h = harness();
      menubarShow(h);
      h.advance(1_000);
      h.fake.userResize({ width: 520, height: 640 }, false);
      expect(h.controller.isPinned()).toBe(true);
    });

    it('ignores bounds changes while the popover is hidden', () => {
      const h = harness();
      h.fake.hide();
      h.advance(1_000);
      h.fake.userDrag({ x: 500 }, false);
      expect(h.controller.isPinned()).toBe(false);
    });

    describe('where the OS reports manual moves (macOS, Windows)', () => {
      const intent = { overrides: { intentEvents: true } };

      it('pins only a change announced by will-move / will-resize', () => {
        const h = harness(intent);
        menubarShow(h);
        h.advance(1_000);
        // A move nobody announced: the system shuffling windows around.
        h.fake.userDrag({ x: 500 }, false);
        expect(h.controller.isPinned()).toBe(false);
        h.fake.userDrag({ x: 520 }, true);
        expect(h.controller.isPinned()).toBe(true);
      });

      it('pins a drag that starts right after the popover opened', () => {
        const h = harness(intent);
        menubarShow(h);
        h.fake.userDrag({ x: 500 }, true);
        expect(h.controller.isPinned()).toBe(true);
      });

      it('follows the whole drag after a single will-move', () => {
        const h = harness(intent);
        menubarShow(h);
        h.fake.userDrag({ x: 500, y: 200 }, true);
        h.advance(100);
        h.fake.userDrag({ x: 600, y: 240 }, false);
        h.advance(1_000);
        expect(h.saves.at(-1)).toMatchObject({ x: 600, y: 215 });
      });
    });
  });

  describe('persistence', () => {
    it('writes the spot relative to its display, once the drag settles', () => {
      const h = harness();
      menubarShow(h);
      h.advance(1_000);
      h.fake.userDrag({ x: 1500, y: 100 }, false);
      h.advance(50);
      h.fake.userDrag({ x: 1600, y: 120 }, false);
      expect(h.saves).toEqual([]);
      h.advance(1_000);
      expect(h.saves).toEqual([
        { displayId: 2, x: 160, y: 120, width: 410, height: 300 },
      ]);
    });
  });

  describe('restoring on show', () => {
    const saved: PinnedPopover = {
      displayId: 2,
      x: 100,
      y: 200,
      width: 460,
      height: 600,
    };

    it('reopens where the user left it instead of under the tray icon', () => {
      const h = harness({ saved });
      expect(h.controller.isPinned()).toBe(true);
      menubarShow(h);
      expect(h.fake.win.getBounds()).toEqual({
        x: 1540,
        y: 200,
        width: 460,
        height: 600,
      });
    });

    it('does not take its own restore for a user move', () => {
      const h = harness({ saved });
      menubarShow(h);
      h.advance(1_000);
      expect(h.saves).toEqual([]);
    });

    it('anchors to the icon again and forgets the spot when its display is gone', () => {
      const h = harness({ saved, displays: [builtIn] });
      menubarShow(h);
      expect(h.controller.isPinned()).toBe(false);
      expect(h.saves).toEqual([null]);
      expect(h.notified).toEqual([false]);
      expect(h.fake.win.getBounds()).toMatchObject({
        x: anchored.x,
        width: 410,
      });
    });

    it('restores only the size where the compositor owns positions', () => {
      const h = harness({ saved, overrides: { restorePosition: false } });
      menubarShow(h);
      expect(h.controller.position()).toBeNull();
      expect(h.fake.win.getBounds()).toEqual({
        x: anchored.x,
        y: anchored.y,
        width: 460,
        height: 600,
      });
    });
  });

  describe('auto-height while pinned', () => {
    const saved: PinnedPopover = {
      displayId: 1,
      x: 300,
      y: 75,
      width: 420,
      height: 600,
    };

    it('leaves the tray-anchored popover to the anchored rule', () => {
      const h = harness();
      menubarShow(h);
      expect(h.controller.autoHeightBounds(anchored, 200)).toBeNull();
    });

    it('fits the content under the user’s height, keeping the top edge', () => {
      const h = harness({ saved });
      menubarShow(h);
      expect(
        h.controller.autoHeightBounds(h.fake.win.getBounds(), 296),
      ).toEqual({ x: 300, y: 100, width: 420, height: 300 });
    });

    it('opens at the last content height, not the full frame', () => {
      const h = harness({ saved });
      h.controller.autoHeightBounds(anchored, 296);
      menubarShow(h);
      expect(h.fake.win.getBounds().height).toBe(300);
    });

    it('keeps the saved height as the ceiling after a drag of a shrunk popover', () => {
      const h = harness({ saved });
      menubarShow(h);
      const fitted = h.controller.autoHeightBounds(h.fake.win.getBounds(), 296);
      if (fitted) h.controller.programmatic(() => h.fake.win.setBounds(fitted));
      h.advance(1_000);
      h.fake.userDrag({ x: 340, y: 140 }, false);
      h.advance(1_000);
      expect(h.saves.at(-1)).toEqual({
        displayId: 1,
        x: 340,
        y: 115,
        width: 420,
        height: 600,
      });
    });

    it('does not fight a drag in progress', () => {
      const h = harness({ saved });
      menubarShow(h);
      h.advance(1_000);
      h.fake.userDrag({ x: 340 }, false);
      const current = h.fake.win.getBounds();
      expect(h.controller.autoHeightBounds(current, 100)).toEqual(current);
    });
  });

  describe('reset', () => {
    const saved: PinnedPopover = {
      displayId: 1,
      x: 300,
      y: 75,
      width: 520,
      height: 600,
    };

    it('forgets the spot, restores the anchored width and re-anchors now', () => {
      const h = harness({ saved });
      menubarShow(h);
      h.controller.reset();
      expect(h.controller.isPinned()).toBe(false);
      expect(h.saves).toEqual([null]);
      expect(h.notified).toEqual([false]);
      expect(h.fake.win.getBounds().width).toBe(410);
      expect(h.calls).toEqual(['reanchor']);
    });

    it('cancels a write still waiting for the drag to settle', () => {
      const h = harness();
      menubarShow(h);
      h.advance(1_000);
      h.fake.userDrag({ x: 500 }, false);
      h.controller.reset();
      h.advance(1_000);
      expect(h.saves).toEqual([null]);
    });

    it('does not take its own width reset for a user resize', () => {
      const h = harness({ saved });
      menubarShow(h);
      h.advance(1_000);
      h.controller.reset();
      h.advance(1_000);
      expect(h.controller.isPinned()).toBe(false);
    });

    it('only re-anchors a popover that is on screen', () => {
      const h = harness({ saved });
      h.fake.hide();
      h.controller.reset();
      expect(h.calls).toEqual([]);
    });
  });

  describe('createMenubarPinnedPopover', () => {
    function wired(platform: NodeJS.Platform, nativeWayland = false) {
      let clock = 10_000;
      const fake = fakeWindow(anchored);
      const sent: unknown[][] = [];
      const calls: string[] = [];
      const saves: (PinnedPopover | null)[] = [];
      const bar = {
        window: {
          ...fake.win,
          webContents: {
            send: (...args: unknown[]) => sent.push(args),
          },
        },
        hideWindow: () => calls.push('hide'),
        showWindow: () => {
          calls.push('show');
          return Promise.resolve();
        },
      };
      const controller = createMenubarPinnedPopover({
        menubar: () => bar,
        host: {
          displays: () => [builtIn],
          displayMatching: () => builtIn,
          nativeWayland,
        },
        store: {
          getTrayPopover: () => ({
            displayId: 1,
            x: 300,
            y: 75,
            width: 460,
            height: 600,
          }),
          saveTrayPopover: (value) => saves.push(value),
        },
        platform,
        now: () => clock,
      });
      controller.attach(fake.win);
      return {
        controller,
        fake,
        sent,
        calls,
        saves,
        later: () => {
          clock += 1_000;
        },
      };
    }

    it('tells the popover renderer and re-anchors through menubar on a reset', () => {
      const w = wired('darwin');
      w.controller.reset();
      expect(w.sent).toEqual([['tray:pinned', false]]);
      expect(w.saves).toEqual([null]);
      expect(w.calls).toEqual(['hide', 'show']);
    });

    it('trusts only announced moves on macOS and Windows', () => {
      for (const platform of ['darwin', 'win32'] as const) {
        const w = wired(platform);
        w.controller.reset();
        w.later();
        w.fake.userDrag({ x: 500 }, false);
        expect(w.controller.isPinned(), platform).toBe(false);
      }
    });

    it('takes any settled move as the user’s on Linux', () => {
      const w = wired('linux');
      w.controller.reset();
      w.later();
      w.fake.userDrag({ x: 500 }, false);
      expect(w.controller.isPinned()).toBe(true);
    });

    it('restores only the size on native Wayland', () => {
      const w = wired('linux', true);
      w.controller.beforeShow();
      expect(w.controller.position()).toBeNull();
      expect(w.fake.win.getBounds()).toMatchObject({ width: 460 });
    });
  });

  describe('patchPinnedPositioning', () => {
    it('hands menubar the pinned spot, and its own calculation otherwise', () => {
      let pinned: { x: number; y: number } | null = { x: 40, y: 60 };
      const positioner = {
        calculate: (_position: string, _tray?: Rect) => ({ x: 1, y: 2 }),
      };
      patchPinnedPositioning(positioner, () => pinned);
      expect(positioner.calculate('trayCenter')).toEqual({ x: 40, y: 60 });
      pinned = null;
      expect(positioner.calculate('trayCenter')).toEqual({ x: 1, y: 2 });
    });
  });
});
