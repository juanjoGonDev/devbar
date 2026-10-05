import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Menu, NativeImage } from 'electron';
import type { Menubar } from 'menubar';
import {
  setupMenubar,
  wireProcessEvents,
  type MenubarSetupDeps,
  type ProcessEventDeps,
} from '../src/main/lifecycle.js';
import type { LogEntry } from '../src/domain-types.js';

type Listener = (payload?: unknown) => void;

function emitterHarness(overrides: Partial<ProcessEventDeps> = {}) {
  const listeners = new Map<string, Listener>();
  const repoListeners = new Map<string, (path: string) => void>();
  const calls: string[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const notices: string[] = [];
  let scheduled = false;
  const deps: ProcessEventDeps = {
    processManager: {
      on: (event: string, listener: Listener) => listeners.set(event, listener),
    } as ProcessEventDeps['processManager'],
    repoWatcher: {
      on: (event, listener) => repoListeners.set(event, listener),
    },
    broadcast: () => calls.push('broadcast'),
    toast: (kind, message) => toasts.push({ kind, message }),
    broadcastLog: () => calls.push('broadcastLog'),
    branchesChanged: (path) => calls.push(`branches:${path}`),
    claimScheduledAction: () => scheduled,
    showCompletionNotification: (_title, body) => notices.push(body),
    trackResume: () => calls.push('trackResume'),
    ...overrides,
  };
  wireProcessEvents(deps);
  return {
    listeners,
    repoListeners,
    calls,
    toasts,
    notices,
    markScheduled: () => {
      scheduled = true;
    },
  };
}

const entry: LogEntry = { ts: 1, stream: 'stdout', level: null, line: 'x' };

describe('src/main/lifecycle.ts', () => {
  describe('wireProcessEvents', () => {
    it('broadcasts and re-arms the resume snapshot on every change', () => {
      const h = emitterHarness();
      h.listeners.get('change')?.();
      expect(h.calls).toEqual(['broadcast', 'trackResume']);
    });

    it('forwards log lines', () => {
      const h = emitterHarness();
      h.listeners.get('log')?.({ id: 'cmd:g1:web', entry });
      expect(h.calls).toEqual(['broadcastLog']);
    });

    it('forwards a repository change', () => {
      const h = emitterHarness();
      h.repoListeners.get('change')?.('/repo');
      expect(h.calls).toEqual(['branches:/repo']);
    });

    it('toasts a finished action with its exit code', () => {
      const h = emitterHarness();
      h.listeners.get('action:done')?.({
        processId: 'act:g1:seed',
        code: 0,
        group: { name: 'API' },
        target: { name: 'seed' },
      });
      expect(h.toasts).toEqual([
        { kind: 'ok', message: 'API · seed exited 0' },
      ]);
    });

    it('marks a non-zero exit as an error', () => {
      const h = emitterHarness();
      h.listeners.get('action:done')?.({
        processId: 'act:g1:seed',
        code: 2,
        group: null,
        target: null,
      });
      expect(h.toasts).toEqual([{ kind: 'error', message: '? · ? exited 2' }]);
    });

    it('leaves a pre-script exit to the pipeline runner', () => {
      const h = emitterHarness();
      h.listeners.get('action:done')?.({
        processId: 'pre:g1:vpn',
        code: 1,
        group: { name: 'API' },
        target: { name: 'vpn' },
      });
      expect(h.toasts).toEqual([]);
      expect(h.calls).toEqual(['broadcast']);
    });

    it('announces a scheduled action, once, with its outcome', () => {
      const h = emitterHarness();
      h.markScheduled();
      h.listeners.get('action:done')?.({
        processId: 'act:g1:seed',
        code: 0,
        group: { name: 'API' },
        target: { name: 'seed' },
      });
      expect(h.notices).toEqual(['API · seed: completada']);
    });

    it('names the failing exit code in the scheduled notice', () => {
      const h = emitterHarness();
      h.markScheduled();
      h.listeners.get('action:done')?.({
        processId: 'act:g1:seed',
        code: 3,
        group: { name: 'API' },
        target: { name: 'seed' },
      });
      expect(h.notices).toEqual(['API · seed: falló (código 3)']);
    });
  });

  describe('setupMenubar', () => {
    function harness(overrides: Partial<MenubarSetupDeps> = {}) {
      const events = new Map<string, () => void>();
      const trayEvents = new Map<string, () => void>();
      const calls: string[] = [];
      const window = { getSize: () => [410, 500] } as unknown as BrowserWindow;
      const bar = {
        tray: {
          setImage: () => calls.push('setImage'),
          setTitle: (title: string) => calls.push(`setTitle:${title}`),
          on: (event: string, listener: () => void) =>
            trayEvents.set(event, listener),
          popUpContextMenu: () => calls.push('popUpContextMenu'),
        },
        window,
        positioner: { calculate: () => ({ x: 0, y: 0 }) },
        on: (event: string, listener: () => void) =>
          events.set(event, listener),
      } as unknown as Menubar;
      let pinnedSpot: { x: number; y: number } | null = null;
      let options: Record<string, unknown> = {};
      const deps: MenubarSetupDeps = {
        createMenubar: (given) => {
          options = given;
          return bar;
        },
        trayIndexUrl: 'file:///app/renderer/tray.html',
        preloadPath: '/app/preload.cjs',
        defaultIcon: () => ({}) as NativeImage,
        windowIcon: () => ({}) as NativeImage,
        background: () => '#1e1e1e',
        isMac: true,
        isLinux: false,
        sessionType: 'x11',
        displayLine: () => null,
        attachTray: () => calls.push('attachTray'),
        attachConsole: (_win, label) => calls.push(`console:${label}`),
        displayMatching: () => ({
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
        }),
        buildContextMenu: () => ({}) as Menu,
        broadcast: () => calls.push('broadcast'),
        refreshTrayIcon: () => calls.push('refreshTrayIcon'),
        invalidateTrayIconCache: () => calls.push('invalidateTrayIconCache'),
        repaintWindows: () => calls.push('repaintWindows'),
        onThemeUpdated: (listener) => events.set('theme', listener),
        scheduleBootWork: () => calls.push('scheduleBootWork'),
        pinnedPopover: {
          attach: () => calls.push('pin:attach'),
          beforeShow: () => calls.push('pin:beforeShow'),
          afterShow: () => calls.push('pin:afterShow'),
          position: () => pinnedSpot,
        },
        ...overrides,
      };
      return {
        pinAt: (spot: { x: number; y: number } | null) => {
          pinnedSpot = spot;
        },
        bar: setupMenubar(deps),
        events,
        trayEvents,
        calls,
        options: () => options,
      };
    }

    it('creates the popover as a utility surface and attaches the tray', () => {
      const h = harness();
      expect(h.options()).toMatchObject({
        index: 'file:///app/renderer/tray.html',
        preloadWindow: true,
      });
      expect(h.options().browserWindow).toMatchObject({
        skipTaskbar: true,
        backgroundColor: '#1e1e1e',
      });
      expect(h.calls).toEqual(['attachTray']);
    });

    it('lets the user resize the popover, but not collapse it', () => {
      const h = harness();
      expect(h.options().browserWindow).toMatchObject({
        resizable: true,
        minWidth: 320,
        minHeight: 160,
        maximizable: false,
        fullscreenable: false,
      });
    });

    it('watches the popover for user moves once its window exists', () => {
      const h = harness();
      h.events.get('after-create-window')?.();
      expect(h.calls).toContain('pin:attach');
    });

    it('brackets menubar’s own show positioning for the pinned mode', () => {
      const h = harness();
      h.events.get('show')?.();
      h.events.get('after-show')?.();
      expect(h.calls).toEqual([
        'attachTray',
        'pin:beforeShow',
        'pin:afterShow',
      ]);
    });

    it('positions a pinned popover at its spot, on every OS', () => {
      for (const isLinux of [false, true]) {
        const h = harness({ isLinux });
        h.events.get('ready')?.();
        h.pinAt({ x: 40, y: 60 });
        const positioner = h.bar.positioner as unknown as {
          calculate: (position: string) => { x: number; y: number };
        };
        expect(positioner.calculate('trayCenter')).toEqual({
          x: 40,
          y: 60,
        });
      }
    });

    it('clears the macOS title and broadcasts once ready', () => {
      const h = harness();
      h.events.get('ready')?.();
      expect(h.calls).toContain('setTitle:');
      expect(h.calls).toContain('broadcast');
      expect(h.calls).toContain('scheduleBootWork');
    });

    // Boot work includes «Control remoto», which opens a LAN server: none of
    // it may run before the popover is up and painted.
    it('holds the boot work until the tray and its popover are ready, then runs it after the first paint', () => {
      const h = harness();
      h.events.get('after-create-window')?.();
      expect(h.calls).not.toContain('scheduleBootWork');

      h.events.get('ready')?.();

      expect(h.calls.slice(-4)).toEqual([
        'setImage',
        'setTitle:',
        'broadcast',
        'scheduleBootWork',
      ]);
    });

    it('leaves the tray title alone off macOS', () => {
      const h = harness({ isMac: false });
      h.events.get('ready')?.();
      expect(h.calls.some((call) => call.startsWith('setTitle'))).toBe(false);
    });

    it('pops the context menu on a right click', () => {
      const h = harness();
      h.events.get('ready')?.();
      h.trayEvents.get('right-click')?.();
      expect(h.calls).toContain('popUpContextMenu');
    });

    it('repaints everything on a light/dark flip', () => {
      const h = harness();
      h.events.get('ready')?.();
      h.events.get('theme')?.();
      expect(h.calls).toContain('invalidateTrayIconCache');
      expect(h.calls).toContain('refreshTrayIcon');
      expect(h.calls).toContain('repaintWindows');
    });

    it('patches the positioner only on Linux', () => {
      const plain = harness();
      plain.events.get('ready')?.();
      const linux = harness({ isLinux: true });
      linux.events.get('ready')?.();
      expect(linux.calls).toContain('broadcast');
    });

    it('logs the Linux display backend once the tray is up', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        // Read at ready, not at setup: the work-area half needs the screen.
        const displayLine = vi.fn(
          () => 'x11 (forced from wayland), workArea unreported → capped',
        );
        const h = harness({ isLinux: true, displayLine });
        expect(displayLine).not.toHaveBeenCalled();
        h.events.get('ready')?.();
        expect(displayLine).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(
          '[display] linux backend: x11 (forced from wayland), workArea unreported → capped',
        );
      } finally {
        log.mockRestore();
      }
    });

    it('captures the popover console once its window exists', () => {
      const h = harness();
      h.events.get('after-create-window')?.();
      expect(h.calls).toContain('console:tray');
      expect(h.calls).toContain('broadcast');
    });
  });
});
