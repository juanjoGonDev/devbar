import { describe, expect, it } from 'vitest';
import {
  registerWindowIpc,
  type WindowIpcDeps,
} from '../src/main/ipc/window-ipc.js';
import { makeCommand, makeGroup, recordingIpc } from './helpers/main-fakes.js';
import type { Group } from '../src/domain-types.js';

function harness(groups: Group[] = [], overrides: Partial<WindowIpcDeps> = {}) {
  const calls: string[] = [];
  const popoverSize: [number, number][] = [];
  let popoverBounds = { x: 0, y: 0, width: 410, height: 500 };
  let hasPopover = true;
  let popoverDestroyed = false;
  let silencedFound = true;
  let messageResponse = 2;
  const ipc = recordingIpc();
  registerWindowIpc(ipc, {
    configStore: { getGroup: (id) => groups.find((g) => g.id === id) ?? null },
    appWindows: {
      ensureConfigWindow: (options) =>
        calls.push(`config:${options?.goto ?? ''}`),
      confirmCloseConfig: () => calls.push('confirmCloseConfig'),
      ensureSilencedWindow: (g, c) => {
        calls.push(`silenced:${g}:${c}`);
        return silencedFound ? {} : null;
      },
    },
    logWindows: {
      ensureLogsWindow: (processId, options) => {
        calls.push(`logs:${processId}:${JSON.stringify(options ?? {})}`);
        return {};
      },
      ensureLogsScopeWindow: (scope, groupId, level) => {
        calls.push(`scope:${scope}:${groupId}:${level}`);
        return {};
      },
    },
    notifications: {
      showBannerNotification: (title, body) =>
        calls.push(`banner:${title}:${body}`),
      closeNotificationWindow: () => calls.push('closeBanner'),
      runNotificationAction: (action) => calls.push(`action:${action}`),
    },
    trayHost: {
      hideIfVisible: () => calls.push('hideIfVisible'),
      hide: () => calls.push('hide'),
      popover: () =>
        hasPopover
          ? {
              isDestroyed: () => popoverDestroyed,
              getBounds: () => {
                if (popoverDestroyed)
                  throw new Error('Object has been destroyed');
                return popoverBounds;
              },
              setSize: (width, height) => popoverSize.push([width, height]),
            }
          : null,
      workAreaHeight: () => 900,
    },
    showMessageBoxForSender: () =>
      Promise.resolve({ response: messageResponse }),
    ...overrides,
  });
  return {
    ipc,
    calls,
    popoverSize,
    setBounds: (height: number) => {
      popoverBounds = { ...popoverBounds, height };
    },
    dropPopover: () => {
      hasPopover = false;
    },
    destroyPopover: () => {
      popoverDestroyed = true;
    },
    dropSilenced: () => {
      silencedFound = false;
    },
    setResponse: (value: number) => {
      messageResponse = value;
    },
  };
}

describe('src/main/ipc/window-ipc.ts', () => {
  describe('registration', () => {
    it('claims every window channel', () => {
      expect(harness().ipc.channels()).toEqual([
        'window:openConfig',
        'window:openConfigChangelog',
        'window:hideTray',
        'tray:setHeight',
        'window:openLogs',
        'window:openSilenced',
        'silenced:getForCommand',
        'notifications:test',
        'notification:dismiss',
        'notification:action',
        'config:confirmDirty',
        'window:confirmCloseConfig',
      ]);
    });
  });

  describe('opening windows', () => {
    it('opens config and hides the popover behind it', () => {
      const h = harness();
      expect(h.ipc.invoke('window:openConfig')).toEqual({ ok: true });
      expect(h.calls).toEqual(['config:', 'hideIfVisible']);
    });

    it('deep-links the version chip straight to the changelog', () => {
      const h = harness();
      h.ipc.invoke('window:openConfigChangelog');
      expect(h.calls[0]).toBe('config:about-changelog');
    });

    it('hides the popover unconditionally when asked to', () => {
      const h = harness();
      expect(h.ipc.invoke('window:hideTray')).toEqual({ ok: true });
      expect(h.calls).toEqual(['hide']);
    });
  });

  describe('tray:setHeight', () => {
    it('resizes the popover to fit the measured content', () => {
      const h = harness();
      expect(h.ipc.invoke('tray:setHeight', 600)).toEqual({
        ok: true,
        applied: 604,
      });
      expect(h.popoverSize).toEqual([[410, 604]]);
    });

    it('does not resize when the height already matches', () => {
      const h = harness();
      h.setBounds(604);
      expect(h.ipc.invoke('tray:setHeight', 600)).toEqual({
        ok: true,
        applied: 604,
      });
      expect(h.popoverSize).toEqual([]);
    });

    it('reports failure with no popover on screen', () => {
      const h = harness();
      h.dropPopover();
      expect(h.ipc.invoke('tray:setHeight', 600)).toEqual({ ok: false });
    });

    it('treats a destroyed popover as gone rather than measuring it', () => {
      // menubar keeps handing back its `window` after Electron destroyed it;
      // calling getBounds() on that throws inside the IPC handler.
      const h = harness();
      h.destroyPopover();
      expect(h.ipc.invoke('tray:setHeight', 600)).toEqual({ ok: false });
    });

    it('rejects a non-numeric height', () => {
      const h = harness();
      expect(() => h.ipc.invoke('tray:setHeight', 'tall')).toThrow(TypeError);
    });
  });

  describe('window:openLogs', () => {
    it('accepts a bare process id', () => {
      const h = harness();
      expect(h.ipc.invoke('window:openLogs', 'cmd:g1:c1')).toEqual({
        ok: true,
      });
      expect(h.calls[0]).toBe('logs:cmd:g1:c1:{}');
    });

    it('carries the filter, level and detached flag', () => {
      const h = harness();
      h.ipc.invoke('window:openLogs', {
        processId: 'cmd:g1:c1',
        filter: 'EADDR',
        level: 'error',
        detached: true,
      });
      expect(h.calls[0]).toBe(
        'logs:cmd:g1:c1:{"filter":"EADDR","detached":true,"level":"error"}',
      );
    });

    it('drops a level the contract does not define', () => {
      const h = harness();
      h.ipc.invoke('window:openLogs', {
        processId: 'cmd:g1:c1',
        level: 'debug',
      });
      expect(h.calls[0]).toBe('logs:cmd:g1:c1:{}');
    });

    it('opens the telemetry scope with no group', () => {
      const h = harness();
      h.ipc.invoke('window:openLogs', { scope: 'all' });
      expect(h.calls[0]).toBe('scope:all:null:null');
    });

    it('opens a group scope filtered by level', () => {
      const h = harness();
      h.ipc.invoke('window:openLogs', {
        scope: 'group',
        groupId: 'g1',
        level: 'warn',
      });
      expect(h.calls[0]).toBe('scope:group:g1:warn');
    });

    it('treats an unknown scope as the whole telemetry view', () => {
      const h = harness();
      h.ipc.invoke('window:openLogs', { scope: 'nonsense' });
      expect(h.calls[0]).toBe('scope:all:null:null');
    });
  });

  describe('silenced patterns', () => {
    it('opens the editor for a live command', () => {
      const h = harness();
      expect(
        h.ipc.invoke('window:openSilenced', { groupId: 'g1', commandId: 'c1' }),
      ).toEqual({ ok: true });
    });

    it('reports a command that is gone', () => {
      const h = harness();
      h.dropSilenced();
      expect(
        h.ipc.invoke('window:openSilenced', { groupId: 'g1', commandId: 'c1' }),
      ).toEqual({ ok: false, error: 'command not found' });
    });

    it('serves the editor its group and command', () => {
      const h = harness([
        makeGroup({
          commands: [
            makeCommand({
              id: 'c1',
              name: 'web',
              silencedPatterns: { warn: ['EADDR'], error: [] },
            }),
          ],
        }),
      ]);
      expect(
        h.ipc.invoke('silenced:getForCommand', {
          groupId: 'g1',
          commandId: 'c1',
        }),
      ).toEqual({
        ok: true,
        group: { id: 'g1', name: 'API' },
        command: {
          id: 'c1',
          name: 'web',
          silencedPatterns: { warn: ['EADDR'], error: [] },
        },
      });
    });

    it('reports a missing group or command', () => {
      const h = harness([makeGroup()]);
      expect(
        h.ipc.invoke('silenced:getForCommand', {
          groupId: 'g1',
          commandId: 'c1',
        }),
      ).toEqual({ ok: false, error: 'command not found' });
      expect(
        h.ipc.invoke('silenced:getForCommand', {
          groupId: 'ghost',
          commandId: 'c1',
        }),
      ).toEqual({ ok: false, error: 'command not found' });
    });
  });

  describe('notifications', () => {
    it('shows the test banner ungated', () => {
      const h = harness();
      expect(h.ipc.invoke('notifications:test')).toEqual({ ok: true });
      expect(h.calls[0]).toMatch(/^banner:DevBar:/);
    });

    it('dismisses the current banner', () => {
      const h = harness();
      expect(h.ipc.invoke('notification:dismiss')).toEqual({ ok: true });
      expect(h.calls).toEqual(['closeBanner']);
    });

    it('runs a CTA and then dismisses', () => {
      const h = harness();
      expect(h.ipc.invoke('notification:action', 'open-about')).toEqual({
        ok: true,
      });
      expect(h.calls).toEqual(['action:open-about', 'closeBanner']);
    });
  });

  describe('config:confirmDirty', () => {
    it('maps each button to its choice', async () => {
      const h = harness();
      h.setResponse(2);
      await expect(
        h.ipc.invoke('config:confirmDirty', { context: 'window-close' }),
      ).resolves.toEqual({ choice: 'save' });
      h.setResponse(1);
      await expect(
        h.ipc.invoke('config:confirmDirty', { context: 'group-switch' }),
      ).resolves.toEqual({ choice: 'discard' });
      h.setResponse(0);
      await expect(
        h.ipc.invoke('config:confirmDirty', { context: 'window-close' }),
      ).resolves.toEqual({ choice: 'cancel' });
    });

    it('cancels when the dialog cannot be shown', async () => {
      const h = harness([], {
        showMessageBoxForSender: () => Promise.reject(new Error('no window')),
      });
      await expect(
        h.ipc.invoke('config:confirmDirty', { context: 'window-close' }),
      ).resolves.toEqual({ choice: 'cancel' });
    });
  });

  describe('window:confirmCloseConfig', () => {
    it('really closes the config window', () => {
      const h = harness();
      expect(h.ipc.invoke('window:confirmCloseConfig')).toEqual({ ok: true });
      expect(h.calls).toEqual(['confirmCloseConfig']);
    });
  });
});
