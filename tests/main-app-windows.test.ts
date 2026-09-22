import { describe, expect, it } from 'vitest';
import type { BrowserWindow, NativeImage } from 'electron';
import {
  createAppWindows,
  type AppWindowsDeps,
} from '../src/main/app-windows.js';
import { createWindowRegistry } from '../src/main/renderer-bus.js';
import {
  fakeWindow,
  WORK_AREA,
  type FakeWindow,
} from './helpers/main-fakes.js';

function harness(overrides: Partial<AppWindowsDeps> = {}) {
  const registry = createWindowRegistry(() => null);
  const windows: FakeWindow[] = [];
  const created: Record<string, unknown>[] = [];
  const consoles: string[] = [];
  const confirmClosed: string[] = [];
  let changes = 0;
  const deps: AppWindowsDeps = {
    registry,
    createWindow: (options) => {
      created.push(options as Record<string, unknown>);
      const win = fakeWindow(String(options.title ?? ''));
      windows.push(win);
      return win as unknown as BrowserWindow;
    },
    rendererFile: (name) => `/app/renderer/${name}`,
    preloadPath: '/app/preload.cjs',
    windowIcon: () => ({}) as NativeImage,
    background: () => '#f5f5f7',
    workArea: () => WORK_AREA,
    attachConsole: (_win, label) => consoles.push(label),
    onWindowsChanged: () => {
      changes += 1;
    },
    isMac: true,
    platformLabel: () => 'macos',
    commandName: (groupId, commandId) =>
      groupId === 'g1' && commandId === 'c1' ? 'web' : null,
    onConfirmWindowClosed: (token) => confirmClosed.push(token),
    ...overrides,
  };
  return {
    appWindows: createAppWindows(deps),
    registry,
    windows,
    created,
    consoles,
    confirmClosed,
    changed: () => changes,
  };
}

describe('src/main/app-windows.ts', () => {
  describe('ensureConfigWindow', () => {
    it('opens a vibrancy window on macOS and registers it', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      expect(h.created[0]).toMatchObject({
        title: 'DevBar — Configuración',
        vibrancy: 'sidebar',
        backgroundColor: '#00000000',
      });
      expect(h.registry.config).toBeDefined();
      expect(h.consoles).toEqual(['config']);
      expect(h.changed()).toBe(1);
    });

    it('uses an opaque titled window elsewhere', () => {
      const h = harness({ isMac: false });
      h.appWindows.ensureConfigWindow();
      expect(h.created[0]?.vibrancy).toBeUndefined();
      expect(h.created[0]?.backgroundColor).toBe('#f5f5f7');
    });

    it('focuses the window that is already open and deep-links into it', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      h.appWindows.ensureConfigWindow({ goto: 'about' });
      expect(h.windows).toHaveLength(1);
      expect(h.windows[0]?.focused).toBe(true);
      expect(h.windows[0]?.sent).toEqual([
        { channel: 'config:goto', payload: 'about' },
      ]);
    });

    it('waits for the first load before deep-linking a cold window', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow({ goto: 'about-changelog' });
      expect(h.windows[0]?.sent).toEqual([]);
      h.windows[0]?.webContents.emit('did-finish-load');
      expect(h.windows[0]?.sent).toEqual([
        { channel: 'config:goto', payload: 'about-changelog' },
      ]);
    });

    it('does not deep-link into a window destroyed before it loaded', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow({ goto: 'about' });
      h.windows[0]?.destroy();
      h.windows[0]?.webContents.emit('did-finish-load');
      expect(h.windows[0]?.sent).toEqual([]);
    });

    it('vetoes its own close and asks the renderer about unsaved changes', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      let prevented = false;
      h.windows[0]?.emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
      expect(h.windows[0]?.sent).toEqual([
        { channel: 'config:closeRequested', payload: undefined },
      ]);
    });

    it('lets the close through once the guard is released', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      h.appWindows.releaseConfigCloseGuard();
      let prevented = false;
      h.windows[0]?.emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(false);
    });

    it('clears the registry entry when the window goes', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      h.windows[0]?.emit('closed');
      expect(h.registry.config).toBeNull();
    });

    it('reopens after the window was destroyed', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      h.windows[0]?.destroy();
      h.appWindows.ensureConfigWindow();
      expect(h.windows).toHaveLength(2);
    });
  });

  describe('confirmCloseConfig', () => {
    it('really closes the window the renderer asked about', () => {
      const h = harness();
      h.appWindows.ensureConfigWindow();
      h.appWindows.confirmCloseConfig();
      expect(h.windows[0]?.destroyed).toBe(true);
    });

    it('is a no-op with no config window', () => {
      const h = harness();
      expect(() => h.appWindows.confirmCloseConfig()).not.toThrow();
    });
  });

  describe('ensureSilencedWindow', () => {
    it('opens the editor titled after the command', () => {
      const h = harness();
      expect(h.appWindows.ensureSilencedWindow('g1', 'c1')).not.toBeNull();
      expect(h.created[0]?.title).toBe('Silenciados — web');
      expect(h.windows[0]?.loaded[0]).toEqual({
        file: '/app/renderer/silenced.html',
        options: {
          query: { groupId: 'g1', commandId: 'c1', platform: 'macos' },
        },
      });
      expect(h.registry.silenced.get('g1:c1')).toBeDefined();
    });

    it('refuses a command that no longer exists', () => {
      const h = harness();
      expect(h.appWindows.ensureSilencedWindow('g1', 'gone')).toBeNull();
      expect(h.windows).toHaveLength(0);
    });

    it('focuses the editor already open for that command', () => {
      const h = harness();
      h.appWindows.ensureSilencedWindow('g1', 'c1');
      h.appWindows.ensureSilencedWindow('g1', 'c1');
      expect(h.windows).toHaveLength(1);
      expect(h.windows[0]?.focused).toBe(true);
    });

    it('forgets the editor when it closes', () => {
      const h = harness();
      h.appWindows.ensureSilencedWindow('g1', 'c1');
      h.windows[0]?.close();
      expect(h.registry.silenced.size).toBe(0);
    });

    it('uses plain chrome off macOS', () => {
      const h = harness({ isMac: false });
      h.appWindows.ensureSilencedWindow('g1', 'c1');
      expect(h.created[0]?.titleBarStyle).toBeUndefined();
    });
  });

  describe('ensurePrescriptConfirmWindow', () => {
    it('opens a frameless modal carrying its token', () => {
      const h = harness();
      h.appWindows.ensurePrescriptConfirmWindow('t1');
      expect(h.created[0]).toMatchObject({ frame: false, alwaysOnTop: true });
      expect(h.windows[0]?.loaded[0]?.options).toEqual({
        query: { token: 't1' },
      });
      expect(h.registry.prescriptConfirm.get('t1')).toBeDefined();
    });

    it('shows itself only once it can paint', () => {
      const h = harness();
      h.appWindows.ensurePrescriptConfirmWindow('t1');
      expect(h.windows[0]?.visible).toBe(false);
      h.windows[0]?.emit('ready-to-show');
      expect(h.windows[0]?.visible).toBe(true);
    });

    it('treats an OS-level close as an implicit cancel', () => {
      const h = harness();
      h.appWindows.ensurePrescriptConfirmWindow('t1');
      h.windows[0]?.emit('closed');
      expect(h.confirmClosed).toEqual(['t1']);
      expect(h.registry.prescriptConfirm.size).toBe(0);
    });
  });
});
