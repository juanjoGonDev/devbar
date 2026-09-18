import { describe, expect, it } from 'vitest';
import type { BrowserWindow, NativeImage } from 'electron';
import {
  createLogWindows,
  type LogWindowsDeps,
} from '../src/main/log-windows.js';
import {
  createWindowRegistry,
  MAIN_LOGS_KEY,
  type WindowLike,
} from '../src/main/renderer-bus.js';
import {
  fakeWindow,
  WORK_AREA,
  type FakeWindow,
} from './helpers/main-fakes.js';

function harness(overrides: Partial<LogWindowsDeps> = {}) {
  const registry = createWindowRegistry(() => null);
  const windows: FakeWindow[] = [];
  const created: Record<string, unknown>[] = [];
  const consoles: string[] = [];
  let changes = 0;
  const deps: LogWindowsDeps = {
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
    background: () => '#1e1e1e',
    workArea: () => WORK_AREA,
    attachConsole: (_win, label) => consoles.push(label),
    onWindowsChanged: () => {
      changes += 1;
    },
    isMac: true,
    resolveTargetName: (processId) =>
      processId === 'cmd:g1:web' ? 'web' : processId,
    ...overrides,
  };
  return {
    logWindows: createLogWindows(deps),
    registry,
    windows,
    created,
    consoles,
    changed: () => changes,
  };
}

describe('src/main/log-windows.ts', () => {
  describe('ensureLogsWindow', () => {
    it('opens the shared window with the service in its query string', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      expect(h.registry.logs.get(MAIN_LOGS_KEY)).toBeDefined();
      expect(h.windows[0]?.loaded[0]).toEqual({
        file: '/app/renderer/logs.html',
        options: { query: { id: 'cmd:g1:web' } },
      });
      expect(h.created[0]?.title).toBe('Logs — web');
      expect(h.consoles).toEqual(['logs:cmd:g1:web']);
      expect(h.changed()).toBe(1);
    });

    it('carries a filter, a level and the detached flag through', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web', {
        filter: 'error',
        level: 'warn',
        detached: true,
      });
      expect(h.windows[0]?.loaded[0]?.options).toEqual({
        query: {
          id: 'cmd:g1:web',
          filter: 'error',
          level: 'warn',
          detached: '1',
        },
      });
      expect(h.registry.logs.has('cmd:g1:web')).toBe(true);
    });

    it('falls back to the raw id when the target is gone', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g9:ghost');
      expect(h.created[0]?.title).toBe('Logs — cmd:g9:ghost');
    });

    it('reuses the shared window and does not re-select the log already shown', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      expect(h.windows).toHaveLength(1);
      expect(h.windows[0]?.sent).toEqual([]);
      expect(h.windows[0]?.visible).toBe(true);
    });

    it('tells the live window to switch when the service changes', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      h.logWindows.ensureLogsWindow('cmd:g1:api');
      expect(h.windows[0]?.sent[0]).toEqual({
        channel: 'logs:select',
        payload: {
          processId: 'cmd:g1:api',
          filter: undefined,
          level: undefined,
        },
      });
    });

    it('re-selects a detached window even for the same service', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web', { detached: true });
      h.logWindows.ensureLogsWindow('cmd:g1:web', { detached: true });
      expect(h.windows[0]?.sent).toHaveLength(1);
    });

    it('opens a fresh window after the old one was destroyed', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      h.windows[0]?.close();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      expect(h.windows).toHaveLength(2);
    });

    it('drops its registry entry when closed', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web', { detached: true });
      h.windows[0]?.close();
      expect(h.registry.logs.size).toBe(0);
    });

    it('uses plain chrome off macOS', () => {
      const h = harness({ isMac: false });
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      expect(h.created[0]?.titleBarStyle).toBeUndefined();
      expect(h.created[0]?.backgroundColor).toBe('#1e1e1e');
    });
  });

  describe('ensureLogsScopeWindow', () => {
    it('opens the telemetry view with its scope in the query string', () => {
      const h = harness();
      h.logWindows.ensureLogsScopeWindow('all', null, null);
      expect(h.created[0]?.title).toBe('DevBar — Telemetría');
      expect(h.windows[0]?.loaded[0]?.options).toEqual({
        query: { scope: 'all' },
      });
    });

    it('carries a group and a level for a scoped view', () => {
      const h = harness();
      h.logWindows.ensureLogsScopeWindow('group', 'g1', 'error');
      expect(h.created[0]?.title).toBe('DevBar — Logs');
      expect(h.windows[0]?.loaded[0]?.options).toEqual({
        query: { scope: 'group', groupId: 'g1', level: 'error' },
      });
    });

    it('tells a live window to switch scope instead of opening another', () => {
      const h = harness();
      h.logWindows.ensureLogsScopeWindow('all', null, null);
      h.logWindows.ensureLogsScopeWindow('group', 'g1', null);
      expect(h.windows).toHaveLength(1);
      expect(h.windows[0]?.sent[0]).toEqual({
        channel: 'logs:select',
        payload: { scope: 'group', groupId: 'g1', level: null },
      });
    });

    it('clears the watched scope when the window closes', () => {
      const h = harness();
      h.logWindows.ensureLogsScopeWindow('all', null, null);
      h.windows[0]?.close();
      expect(h.registry.logs.size).toBe(0);
    });
  });

  describe('broadcastLog', () => {
    const entry = { ts: 1, stream: 'stdout' as const, level: null, line: 'x' };

    it('always feeds a detached window its own lines', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web', { detached: true });
      h.logWindows.broadcastLog({ id: 'cmd:g1:web', entry });
      expect(h.windows[0]?.sent.at(-1)).toEqual({
        channel: 'logs:line',
        payload: { id: 'cmd:g1:web', entry },
      });
    });

    it('feeds the shared window only the service it is watching', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      h.logWindows.broadcastLog({ id: 'cmd:g1:api', entry });
      expect(h.windows[0]?.sent).toEqual([]);
      h.logWindows.broadcastLog({ id: 'cmd:g1:web', entry });
      expect(h.windows[0]?.sent).toHaveLength(1);
    });

    it('feeds a merged scope every member, including one that appeared later', () => {
      const h = harness();
      h.logWindows.ensureLogsScopeWindow('group', 'g1', null);
      h.logWindows.watchScope('g1');
      h.logWindows.broadcastLog({ id: 'pre:g1:vpn', entry });
      h.logWindows.broadcastLog({ id: 'cmd:g2:other', entry });
      expect(h.windows[0]?.sent).toHaveLength(1);
    });

    it('sends nothing once the shared window is destroyed', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      const win = h.windows[0];
      win?.destroy();
      h.logWindows.broadcastLog({ id: 'cmd:g1:web', entry });
      expect(win?.sent).toEqual([]);
    });
  });

  describe('watch bookkeeping', () => {
    it('knows the shared window by its webContents', () => {
      const h = harness();
      h.logWindows.ensureLogsWindow('cmd:g1:web');
      const shared = h.registry.logs.get(MAIN_LOGS_KEY) as WindowLike;
      expect(h.logWindows.isSharedWindowSender(shared.webContents)).toBe(true);
      expect(h.logWindows.isSharedWindowSender({})).toBe(false);
    });

    it('answers false when there is no shared window at all', () => {
      const h = harness();
      expect(h.logWindows.isSharedWindowSender({})).toBe(false);
    });

    it('leaves a merged view when a single log is selected', () => {
      const h = harness();
      h.logWindows.ensureLogsScopeWindow('all', null, null);
      h.logWindows.watchScope(null);
      h.logWindows.watchSingle('cmd:g1:web');
      h.logWindows.broadcastLog({
        id: 'cmd:g2:other',
        entry: { ts: 1, stream: 'stdout', level: null, line: 'x' },
      });
      expect(h.windows[0]?.sent).toEqual([]);
    });
  });
});
