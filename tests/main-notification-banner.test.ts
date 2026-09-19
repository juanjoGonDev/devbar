import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Notification } from 'electron';
import {
  createNotifications,
  type NotificationDeps,
} from '../src/main/notification-banner.js';
import {
  fakeWindow,
  WORK_AREA,
  type FakeWindow,
} from './helpers/main-fakes.js';

interface FakeNotification {
  listeners: Map<string, (...args: unknown[]) => void>;
  shown: boolean;
  fire: (event: string, ...args: unknown[]) => void;
}

function harness(overrides: Partial<NotificationDeps> = {}) {
  const windows: FakeWindow[] = [];
  const windowOptions: BrowserWindowConstructorOptions[] = [];
  const notifications: FakeNotification[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const opened: string[] = [];
  const applied: string[] = [];
  const deps: NotificationDeps = {
    createWindow: (options) => {
      const win = fakeWindow('banner');
      windows.push(win);
      windowOptions.push(options);
      return win as unknown as BrowserWindow;
    },
    createNotification: () => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const notification: FakeNotification = {
        listeners,
        shown: false,
        fire: (event, ...args) => listeners.get(event)?.(...args),
      };
      notifications.push(notification);
      return {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
          return notification;
        },
        show: () => {
          notification.shown = true;
        },
      } as unknown as Notification;
    },
    notificationsSupported: () => true,
    rendererFile: (name) => `/app/renderer/${name}`,
    preloadPath: '/app/preload.cjs',
    workArea: () => WORK_AREA,
    notifySuccessEnabled: () => true,
    openConfig: (goto) => opened.push(goto),
    applyUpdate: () => applied.push('update'),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    },
    ...overrides,
  };
  return {
    notifications: createNotifications(deps),
    windows,
    windowOptions,
    natives: notifications,
    timers,
    opened,
    applied,
  };
}

describe('src/main/notification-banner.ts', () => {
  describe('showBannerNotification', () => {
    it('prefers the system notification when it is supported', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      h.notifications.showBannerNotification('DevBar', 'hola');
      expect(h.natives[0]?.shown).toBe(true);
      expect(h.windows).toHaveLength(0);
      h.natives[0]?.fire('show');
      expect(log).toHaveBeenCalledWith('[notify] aceptada por el sistema');
      log.mockRestore();
    });

    it('falls back to the in-app banner where notifications are unsupported', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness({ notificationsSupported: () => false });
      h.notifications.showBannerNotification('DevBar', 'hola');
      expect(h.windows).toHaveLength(1);
      log.mockRestore();
    });

    it('falls back when the system rejects the payload', () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness();
      h.notifications.showBannerNotification('DevBar', 'hola');
      h.natives[0]?.fire('failed', {}, 'denied');
      expect(h.windows).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not double up when a failure follows a delivery', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness();
      h.notifications.showBannerNotification('DevBar', 'hola');
      h.natives[0]?.fire('show');
      h.natives[0]?.fire('failed', {}, 'late');
      expect(h.windows).toHaveLength(0);
      log.mockRestore();
      warn.mockRestore();
    });

    it('routes a CTA click through the action map', () => {
      const h = harness();
      h.notifications.showBannerNotification('DevBar', 'hola', {
        cta: { label: 'Ver', action: 'open-about' },
      });
      h.natives[0]?.fire('click');
      expect(h.opened).toEqual(['about']);
    });
  });

  describe('showCustomBanner', () => {
    it('opens an OPAQUE window on Linux, where a compositor is not guaranteed', () => {
      // Without a compositor (Raspberry Pi OS) a transparent window paints
      // solid black — the banner showed up as a black box.
      const h = harness({ platform: 'linux' });
      h.notifications.showCustomBanner('DevBar', 'hola');
      expect(h.windowOptions[0]).toMatchObject({
        transparent: false,
        backgroundColor: '#1e1e1e',
      });
    });

    it('keeps the floating transparent banner where compositors are the norm', () => {
      const h = harness({ platform: 'darwin' });
      h.notifications.showCustomBanner('DevBar', 'hola');
      expect(h.windowOptions[0]).toMatchObject({
        transparent: true,
        backgroundColor: '#00000000',
      });
    });

    it('places the banner top-right and loads the renderer without focus', () => {
      const h = harness();
      h.notifications.showCustomBanner('DevBar', 'hola');
      const win = h.windows[0];
      expect(win?.loaded[0]?.file).toBe('/app/renderer/notification.html');
      expect(win?.loaded[0]?.options).toEqual({
        query: { title: 'DevBar', body: 'hola', secs: '5' },
      });
      win?.emit('ready-to-show');
      expect(win?.visible).toBe(true);
    });

    it('carries a CTA into the query string', () => {
      const h = harness();
      h.notifications.showCustomBanner('DevBar', 'hola', {
        cta: { label: 'Reiniciar', action: 'install-update' },
      });
      expect(h.windows[0]?.loaded[0]?.options).toMatchObject({
        query: { cta: 'Reiniciar', action: 'install-update' },
      });
    });

    it('replaces the banner already on screen instead of stacking', () => {
      const h = harness();
      h.notifications.showCustomBanner('DevBar', 'uno');
      h.notifications.showCustomBanner('DevBar', 'dos');
      expect(h.windows[0]?.destroyed).toBe(true);
      expect(h.windows[1]?.destroyed).toBe(false);
    });

    it('closes itself on the authoritative main-process timer', () => {
      const h = harness();
      h.notifications.showCustomBanner('DevBar', 'hola');
      expect(h.timers[0]?.ms).toBe(5000);
      h.timers[0]?.fn();
      expect(h.windows[0]?.destroyed).toBe(true);
    });

    it('forgets a window that closed on its own', () => {
      const h = harness();
      h.notifications.showCustomBanner('DevBar', 'hola');
      h.windows[0]?.emit('closed');
      h.notifications.closeNotificationWindow();
      expect(h.timers[0]?.cleared).toBe(true);
    });
  });

  describe('showCompletionNotification', () => {
    it('stays silent while the success toggle is off', () => {
      const h = harness({ notifySuccessEnabled: () => false });
      h.notifications.showCompletionNotification('DevBar', 'listo');
      expect(h.natives).toHaveLength(0);
    });

    it('announces when the toggle is on', () => {
      const h = harness();
      h.notifications.showCompletionNotification('DevBar', 'listo');
      expect(h.natives).toHaveLength(1);
    });
  });

  describe('runNotificationAction', () => {
    it('maps every known CTA and ignores the rest', () => {
      const h = harness();
      h.notifications.runNotificationAction('open-about');
      h.notifications.runNotificationAction('open-changelog');
      h.notifications.runNotificationAction('install-update');
      h.notifications.runNotificationAction('nonsense');
      expect(h.opened).toEqual(['about', 'about-changelog']);
      expect(h.applied).toEqual(['update']);
    });
  });

  describe('defaults', () => {
    it('uses real timers when none are injected', () => {
      const h = harness({ setTimer: undefined, clearTimer: undefined });
      h.notifications.showCustomBanner('DevBar', 'hola');
      expect(() => h.notifications.closeNotificationWindow()).not.toThrow();
    });
  });
});
