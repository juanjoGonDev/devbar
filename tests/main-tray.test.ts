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
  type RebuildableTray,
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

  describe('linux tray item rebuild', () => {
    class FakeElectronTray {
      static instances: FakeElectronTray[] = [];
      images: NativeImage[] = [];
      tooltips: string[] = [];
      menus: unknown[] = [];
      destroyed = false;
      listeners = new Map<string, (() => void)[]>();
      constructor(image: NativeImage) {
        this.images.push(image);
        FakeElectronTray.instances.push(this);
      }
      setImage(image: NativeImage): void {
        this.images.push(image);
      }
      setTitle(): void {}
      setToolTip(tooltip: string): void {
        this.tooltips.push(tooltip);
      }
      destroy(): void {
        this.destroyed = true;
      }
      on(event: string, listener: () => void): void {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
      }
      popUpContextMenu(menu: unknown): void {
        this.menus.push(menu);
      }
      emit(event: string): void {
        for (const listener of this.listeners.get(event) ?? []) listener();
      }
      static reset(): void {
        FakeElectronTray.instances = [];
      }
    }

    interface RebuildHarness {
      controller: ReturnType<typeof createTrayController>;
      initialTray: {
        setImage: ReturnType<typeof vi.fn>;
        setTitle: ReturnType<typeof vi.fn>;
        setToolTip: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      bar: {
        tray: {
          setImage: unknown;
          setTitle: unknown;
          setToolTip: unknown;
          destroy: unknown;
        };
        clicked: () => void;
        _tray?: unknown;
      };
      clickedCalls: number[];
      elapse: (ms: number) => void;
      flush: () => void;
      instances: () => FakeElectronTray[];
    }

    function rebuildHarness(
      overrides: Partial<Parameters<typeof createTrayController>[0]> = {},
    ): RebuildHarness {
      FakeElectronTray.reset();
      let clock = 0;
      const clickedCalls: number[] = [];
      const deferred: { fn: () => void; at: number }[] = [];
      let nth = 0;
      const controller = createTrayController({
        loadIcon: () => ({ n: nth++ }) as unknown as NativeImage,
        isMac: false,
        hasUpdate: () => false,
        platform: 'linux',
        now: () => clock,
        schedule: (fn, ms) => {
          deferred.push({ fn, at: clock + ms });
        },
        rebuildPieces: {
          Tray: FakeElectronTray as unknown as new (
            image: NativeImage,
          ) => RebuildableTray,
          buildContextMenu: () => ({ menu: true }),
        },
        ...overrides,
      });
      const initialTray = {
        setImage: vi.fn(),
        setTitle: vi.fn(),
        setToolTip: vi.fn(),
        destroy: vi.fn(),
      };
      const bar = {
        tray: initialTray,
        clicked: () => {
          clickedCalls.push(1);
        },
        _tray: undefined as unknown,
      };
      controller.attach(bar);
      return {
        controller,
        initialTray,
        bar,
        clickedCalls,
        elapse: (ms) => {
          clock += ms;
        },
        flush: () => {
          for (const d of deferred.splice(0)) if (d.at <= clock) d.fn();
        },
        instances: () => FakeElectronTray.instances,
      };
    }

    it("first paint is a plain setImage on menubar's own tray, no rebuild", () => {
      const h = rebuildHarness();
      h.controller.updateTitle([]);
      expect(h.initialTray.setImage).toHaveBeenCalledTimes(1);
      expect(h.instances()).toHaveLength(0);
    });

    it('a later visual change rebuilds the item: old destroyed, fresh one wired', () => {
      const h = rebuildHarness();
      h.controller.updateTitle([]);
      h.elapse(TRAY_PUSH_MIN_INTERVAL_MS);
      h.controller.updateTitle([]);
      h.flush();
      expect(h.initialTray.setImage).toHaveBeenCalledTimes(1);
      const [fresh] = h.instances();
      expect(
        h.initialTray.destroy,
        "menubar's tray destroyed",
      ).toHaveBeenCalledTimes(1);
      expect(h.bar._tray).toBe(fresh);
      expect(fresh?.images[0]).toBeDefined();
      expect(fresh?.tooltips).toHaveLength(1);
      // menubar's click handlers and the app context menu ride along.
      fresh?.emit('click');
      fresh?.emit('double-click');
      expect(h.clickedCalls).toHaveLength(2);
      fresh?.emit('right-click');
      expect(fresh?.menus).toEqual([{ menu: true }]);
    });

    it('never rebuilds for an image that did not change', () => {
      let image = { v: 1 } as unknown as NativeImage;
      const h = rebuildHarness({
        loadIcon: () => image,
      });
      h.controller.updateTitle([]);
      h.controller.updateTitle([]);
      h.elapse(TRAY_PUSH_MIN_INTERVAL_MS);
      h.controller.updateTitle([]);
      expect(h.initialTray.setImage).toHaveBeenCalledTimes(1);
      expect(h.instances()).toHaveLength(0);
      image = { v: 2 } as unknown as NativeImage;
      h.controller.updateTitle([]);
      expect(h.instances()).toHaveLength(1);
    });

    it('collapses a burst into a single rebuild carrying the last state', () => {
      const h = rebuildHarness();
      h.controller.updateTitle([]);
      h.elapse(10);
      for (let i = 0; i < 4; i++) h.controller.updateTitle([]);
      expect(h.instances()).toHaveLength(0); // inside the window: nothing yet
      h.elapse(TRAY_PUSH_MIN_INTERVAL_MS);
      h.flush();
      expect(h.instances()).toHaveLength(1);
      expect(h.initialTray.destroy).toHaveBeenCalledTimes(1);
    });

    it('survives a rebuild that throws and keeps the old tray', () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const h = rebuildHarness();
      h.controller.updateTitle([]);
      h.elapse(TRAY_PUSH_MIN_INTERVAL_MS);
      // The constructor fails once…
      const original = FakeElectronTray;
      FakeElectronTray.instances = [];
      class Broken {
        constructor() {
          throw new Error('no dbus');
        }
      }
      h.bar._tray = undefined;
      // …by swapping the pieces through a second controller configured badly.
      const failing = createTrayController({
        loadIcon: () => ({ x: 1 }) as unknown as NativeImage,
        isMac: false,
        hasUpdate: () => false,
        platform: 'linux',
        now: () => 10_000,
        schedule: (fn) => fn(),
        rebuildPieces: {
          Tray: Broken as unknown as new (
            image: NativeImage,
          ) => RebuildableTray,
          buildContextMenu: () => ({}),
        },
      });
      const tray = {
        setImage: vi.fn(),
        setTitle: vi.fn(),
        setToolTip: vi.fn(),
      };
      failing.attach({
        tray,
        clicked: () => undefined,
      } as unknown as Parameters<
        ReturnType<typeof createTrayController>['attach']
      >[0]);
      failing.updateTitle([]);
      failing.updateTitle([]);
      expect(error).toHaveBeenCalledWith(
        'tray rebuild failed:',
        expect.any(Error),
      );
      expect(tray.setImage).toHaveBeenCalled(); // first paint still landed
      FakeElectronTray.instances = original.instances;
      error.mockRestore();
    });

    it('macOS and Windows never rebuild, they just setImage', () => {
      let nth = 0;
      const tray = {
        setImage: vi.fn(),
        setTitle: vi.fn(),
        setToolTip: vi.fn(),
      };
      const controller = createTrayController({
        loadIcon: () => ({ n: nth++ }) as unknown as NativeImage,
        isMac: false,
        hasUpdate: () => false,
        platform: 'darwin',
        rebuildPieces: {
          Tray: FakeElectronTray as unknown as new (
            image: NativeImage,
          ) => RebuildableTray,
          buildContextMenu: () => ({}),
        },
      });
      controller.attach({ tray });
      controller.updateTitle([]);
      controller.updateTitle([]);
      expect(tray.setImage).toHaveBeenCalledTimes(2);
      expect(FakeElectronTray.instances).toHaveLength(0);
    });

    it('releasing a simulated count repaints immediately', () => {
      const images: { count: number }[] = [];
      const controller = createTrayController({
        loadIcon: (_state, _update, count) => {
          images.push({ count });
          return { c: count, k: images.length } as unknown as NativeImage;
        },
        isMac: false,
        hasUpdate: () => false,
      });
      controller.attach({
        tray: { setImage: vi.fn(), setTitle: vi.fn(), setToolTip: vi.fn() },
      });
      controller.setSimulatedCount(5);
      const forced = images.at(-1)?.count;
      controller.setSimulatedCount(null);
      expect(images.at(-1)?.count).toBe(0);
      expect(forced).toBe(5);
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
