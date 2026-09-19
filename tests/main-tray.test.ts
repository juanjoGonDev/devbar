import { afterEach, describe, expect, it, vi } from 'vitest';

// tray.ts reaches tray-icon.ts for the badge and colour aggregation, which
// imports electron for nativeImage/nativeTheme.
vi.mock('electron', () => ({
  nativeImage: {
    createFromBitmap: () => ({
      addRepresentation: () => undefined,
      setTemplateImage: () => undefined,
    }),
  },
  nativeTheme: { shouldUseDarkColors: false },
}));

import type { NativeImage } from 'electron';
import {
  createTrayController,
  patchLinuxTrayPositioning,
  TRAY_PUSH_MIN_INTERVAL_MS,
} from '../src/main/tray.js';
import type { GroupState, TrayColor } from '../src/ipc-contract.js';
import { makeGroup } from './helpers/main-fakes.js';

interface Painted {
  state: TrayColor;
  hasUpdate: boolean;
  count: number;
}

function harness(hasUpdate = false) {
  const painted: Painted[] = [];
  const titles: string[] = [];
  const tooltips: string[] = [];
  let failNext = false;
  const controller = createTrayController({
    loadIcon: (state, update, count) => {
      if (failNext) throw new Error('setImage failed');
      painted.push({ state, hasUpdate: update, count });
      return {} as NativeImage;
    },
    isMac: true,
    hasUpdate: () => hasUpdate,
  });
  const menuBar = {
    tray: {
      setImage: () => undefined,
      setTitle: (title: string) => titles.push(title),
      setToolTip: (tooltip: string) => tooltips.push(tooltip),
    },
  };
  return {
    controller,
    menuBar,
    painted,
    titles,
    tooltips,
    fail: () => {
      failNext = true;
    },
  };
}

function groupState(
  color: TrayColor,
  commands: { warnCount?: number; errorCount?: number }[] = [],
): GroupState {
  return {
    groupId: 'g1',
    group: makeGroup(),
    currentBranch: null,
    color,
    commands: commands.map((command, index) => ({
      commandId: `c${index}`,
      processId: `cmd:g1:c${index}`,
      status: 'running',
      warnCount: command.warnCount ?? 0,
      errorCount: command.errorCount ?? 0,
      lastError: null,
      startedAt: null,
      color,
      muteWarn: false,
      muteErr: false,
    })),
    actions: [],
    lastError: null,
  };
}

describe('src/main/tray.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createTrayController', () => {
    it('paints nothing before a menubar is attached', () => {
      const h = harness();
      h.controller.refreshIcon();
      h.controller.updateTitle([groupState('running')]);
      expect(h.painted).toEqual([]);
    });

    it('paints the aggregated colour and no count on macOS', () => {
      const h = harness();
      h.controller.attach(h.menuBar);
      h.controller.updateTitle([
        groupState('running'),
        groupState('error', [{ errorCount: 2 }]),
      ]);
      expect(h.painted.at(-1)).toEqual({
        state: 'error',
        hasUpdate: false,
        count: 0,
      });
      expect(h.titles).toEqual([' 2']);
      expect(h.tooltips).toEqual(['DevBar — 2 errores']);
    });

    it('draws the count into the icon where tray titles are not rendered', () => {
      const painted: Painted[] = [];
      const controller = createTrayController({
        loadIcon: (state, hasUpdate, count) => {
          painted.push({ state, hasUpdate, count });
          return {} as NativeImage;
        },
        isMac: false,
        hasUpdate: () => false,
      });
      const titles: string[] = [];
      controller.attach({
        tray: {
          setImage: () => undefined,
          setTitle: (title) => titles.push(title),
          setToolTip: () => undefined,
        },
      });
      controller.updateTitle([groupState('warn', [{ warnCount: 3 }])]);
      expect(painted.at(-1)?.count).toBe(3);
      expect(titles).toEqual([]);
    });

    it('carries the pending-update badge', () => {
      const h = harness(true);
      h.controller.attach(h.menuBar);
      h.controller.refreshIcon();
      expect(h.painted.at(-1)?.hasUpdate).toBe(true);
    });

    it('survives a platform that refuses the image', () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const h = harness();
      h.controller.attach(h.menuBar);
      h.fail();
      expect(() => h.controller.refreshIcon()).not.toThrow();
      expect(error).toHaveBeenCalledWith('setImage failed:', expect.any(Error));
    });

    it('lets a simulated colour win over the real state', () => {
      const h = harness();
      h.controller.attach(h.menuBar);
      h.controller.updateTitle([groupState('error', [{ errorCount: 1 }])]);
      h.controller.setSimulatedColor('running');
      expect(h.painted.at(-1)?.state).toBe('running');
      h.controller.setSimulatedColor(null);
      expect(h.painted.at(-1)?.state).toBe('error');
    });

    it('lets a simulated count win, without forgetting the real one', () => {
      const h = harness();
      h.controller.attach(h.menuBar);
      h.controller.setSimulatedCount(42);
      h.controller.updateTitle([groupState('warn', [{ warnCount: 3 }])]);
      expect(h.titles).toEqual([' 42']);
      expect(h.controller.simulatedCount()).toBe(42);
      h.controller.setSimulatedCount(null);
      h.controller.updateTitle([groupState('warn', [{ warnCount: 3 }])]);
      expect(h.titles.at(-1)).toBe(' 3');
    });

    it('labels a forced count as an error, which is what the panel simulates', () => {
      const h = harness();
      h.controller.attach(h.menuBar);
      h.controller.setSimulatedCount(1);
      h.controller.updateTitle([groupState('warn', [{ warnCount: 5 }])]);
      expect(h.tooltips.at(-1)).toBe('DevBar — 1 error');
    });
  });

  describe('linux tray push coalescing', () => {
    interface Pushes {
      images: unknown[];
      at: number[];
    }

    /** Distinct images per call: identical instances must dedupe. */
    function linuxHarness(): {
      controller: ReturnType<typeof createTrayController>;
      pushes: Pushes;
      elapse: (ms: number) => void;
      flush: () => void;
    } {
      let clock = 0;
      const pushes: Pushes = { images: [], at: [] };
      const deferred: { fn: () => void; at: number }[] = [];
      const unique = Symbol();
      let nth = 0;
      const controller = createTrayController({
        loadIcon: () =>
          ({
            tag: Symbol(`${String(unique)}-${nth++}`),
          }) as unknown as NativeImage,
        isMac: false,
        hasUpdate: () => false,
        platform: 'linux',
        now: () => clock,
        schedule: (fn, ms) => {
          deferred.push({ fn, at: clock + ms });
        },
      });
      controller.attach({
        tray: {
          setImage: (image) => {
            pushes.images.push(image);
            pushes.at.push(clock);
          },
          setTitle: () => undefined,
          setToolTip: () => undefined,
        },
      });
      return {
        controller,
        pushes,
        elapse: (ms) => {
          clock += ms;
        },
        flush: () => {
          // Runs the deferred flushes that have come due, newest first.
          for (const d of deferred.splice(0)) if (d.at <= clock) d.fn();
        },
      };
    }

    it('collapses a burst of state changes into ONE push with the last state', () => {
      const h = linuxHarness();
      // A start/stop churn: several updates within the window.
      for (let i = 0; i < 5; i++) h.controller.updateTitle([]);
      expect(h.pushes.images).toHaveLength(1);
      h.elapse(TRAY_PUSH_MIN_INTERVAL_MS);
      h.flush();
      expect(h.pushes.images).toHaveLength(2);
    });

    it('pushes immediately again once the window has elapsed', () => {
      const h = linuxHarness();
      h.controller.updateTitle([]);
      expect(h.pushes.images).toHaveLength(1);
      h.elapse(TRAY_PUSH_MIN_INTERVAL_MS + 1);
      h.controller.updateTitle([]);
      expect(h.pushes.images).toHaveLength(2);
      expect(h.pushes.at[1]).toBe(TRAY_PUSH_MIN_INTERVAL_MS + 1);
    });

    it('skips pushes whose image is identical (the cached key did not change)', () => {
      const clock = 0;
      const pushes: unknown[] = [];
      const image = { same: true } as unknown as NativeImage;
      const controller = createTrayController({
        loadIcon: () => image,
        isMac: false,
        hasUpdate: () => false,
        platform: 'linux',
        now: () => clock,
        schedule: () => undefined,
      });
      controller.attach({
        tray: {
          setImage: (i) => pushes.push(i),
          setTitle: () => undefined,
          setToolTip: () => undefined,
        },
      });
      controller.updateTitle([]);
      controller.updateTitle([]);
      controller.updateTitle([]);
      expect(pushes).toHaveLength(1);
    });

    it('leaves macOS and Windows unthrottled', () => {
      const clock = 0;
      const pushes: unknown[] = [];
      let nth = 0;
      const controller = createTrayController({
        loadIcon: () => ({ n: nth++ }) as unknown as NativeImage,
        isMac: false,
        hasUpdate: () => false,
        platform: 'darwin',
        now: () => clock,
        schedule: () => undefined,
      });
      controller.attach({
        tray: {
          setImage: (i) => pushes.push(i),
          setTitle: () => undefined,
          setToolTip: () => undefined,
        },
      });
      controller.updateTitle([]);
      controller.updateTitle([]);
      expect(pushes).toHaveLength(2);
    });
  });

  describe('patchLinuxTrayPositioning', () => {
    const display = {
      workArea: { x: 0, y: 30, width: 1440, height: 870 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    };

    function positioner() {
      const calls: { position: string }[] = [];
      return {
        calls,
        calculate: (
          position: string,
          _trayBounds?: { x: number; y: number; width: number; height: number },
        ) => {
          calls.push({ position });
          return { x: -50, y: 40 };
        },
      };
    }

    it('anchors the panel to the icon and clamps it into the work area', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const p = positioner();
      patchLinuxTrayPositioning({
        positioner: p,
        windowWidth: () => 410,
        displayMatching: () => display,
        sessionType: 'x11',
      });
      expect(
        p.calculate('trayCenter', { x: 700, y: 0, width: 22, height: 22 }),
      ).toEqual({ x: 0, y: 40 });
      expect(p.calls.at(-1)?.position).toBe('trayCenter');
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('logs the icon placement only once', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const p = positioner();
      patchLinuxTrayPositioning({
        positioner: p,
        windowWidth: () => 410,
        displayMatching: () => display,
        sessionType: 'x11',
      });
      const bounds = { x: 700, y: 0, width: 22, height: 22 };
      p.calculate('trayCenter', bounds);
      p.calculate('trayCenter', bounds);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('keeps menubar behaviour when Wayland reports no bounds', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const p = positioner();
      patchLinuxTrayPositioning({
        positioner: p,
        windowWidth: () => 410,
        displayMatching: () => display,
        sessionType: 'wayland',
      });
      expect(
        p.calculate('topRight', { x: 0, y: 0, width: 0, height: 0 }),
      ).toEqual({
        x: -50,
        y: 40,
      });
      expect(p.calls.at(-1)?.position).toBe('topRight');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('sin bounds del icono'),
      );
    });

    it('defers to menubar before the popover window exists', () => {
      const p = positioner();
      patchLinuxTrayPositioning({
        positioner: p,
        windowWidth: () => null,
        displayMatching: () => display,
        sessionType: 'x11',
      });
      p.calculate('topRight', { x: 700, y: 0, width: 22, height: 22 });
      expect(p.calls.at(-1)?.position).toBe('topRight');
    });
  });
});
