import { describe, expect, it } from 'vitest';
import {
  notificationSettingsPlan,
  openNotificationSettings,
  type NotificationSettingsDeps,
  type SpawnedChild,
} from '../src/main/notification-settings.js';

const MAC_PANE =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

function child(fire: 'spawn' | 'error' | 'never'): SpawnedChild & {
  unrefs: number;
} {
  const listeners = new Map<string, () => void>();
  const value = {
    unrefs: 0,
    once: (event: 'error' | 'spawn', listener: () => void) => {
      listeners.set(event, listener);
      if (event === fire) queueMicrotask(listener);
      return value;
    },
    unref: () => {
      value.unrefs += 1;
    },
  };
  return value;
}

function deps(overrides: Partial<NotificationSettingsDeps> = {}) {
  const opened: string[] = [];
  const spawned: { command: string; args: string[] }[] = [];
  const base: NotificationSettingsDeps = {
    platform: 'darwin',
    desktop: '',
    bundleId: () => null,
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve(undefined);
    },
    spawnDetached: (command, args) => {
      spawned.push({ command, args });
      return child('spawn');
    },
    spawnTimeoutMs: 5,
    ...overrides,
  };
  return { base, opened, spawned };
}

describe('src/main/notification-settings.ts', () => {
  describe('notificationSettingsPlan', () => {
    it('deep-links to this app row on macOS when the bundle id is known', () => {
      expect(notificationSettingsPlan('darwin', '', 'dev.devbar.app')).toEqual({
        kind: 'url',
        url: `${MAC_PANE}?id=dev.devbar.app`,
      });
    });

    it('opens the bare macOS pane without a bundle id', () => {
      expect(notificationSettingsPlan('darwin', '', null)).toEqual({
        kind: 'url',
        url: MAC_PANE,
      });
    });

    it('opens the Windows settings page', () => {
      expect(notificationSettingsPlan('win32', '', null)).toEqual({
        kind: 'url',
        url: 'ms-settings:notifications',
      });
    });

    it('launches the desktop-specific tool on GNOME and KDE', () => {
      expect(notificationSettingsPlan('linux', 'ubuntu:GNOME', null)).toEqual({
        kind: 'spawn',
        command: 'gnome-control-center',
        args: ['notifications'],
      });
      expect(notificationSettingsPlan('linux', 'KDE', null)).toEqual({
        kind: 'spawn',
        command: 'kcmshell6',
        args: ['kcm_notify'],
      });
    });

    it('gives up on an unknown desktop rather than pretending', () => {
      expect(notificationSettingsPlan('linux', 'sway', null)).toEqual({
        kind: 'unsupported',
      });
    });
  });

  describe('openNotificationSettings', () => {
    it('opens the URL plan', async () => {
      const d = deps({ bundleId: () => 'dev.devbar.app' });
      await expect(openNotificationSettings(d.base)).resolves.toEqual({
        ok: true,
      });
      expect(d.opened).toEqual([`${MAC_PANE}?id=dev.devbar.app`]);
    });

    it('reports the unsupported desktop to the renderer', async () => {
      const d = deps({ platform: 'linux', desktop: 'sway' });
      await expect(openNotificationSettings(d.base)).resolves.toEqual({
        ok: false,
        error: 'No se detectó un panel de notificaciones conocido',
      });
    });

    it('spawns the settings tool and releases it', async () => {
      const spawnedChild = child('spawn');
      const d = deps({
        platform: 'linux',
        desktop: 'GNOME',
        spawnDetached: () => spawnedChild,
      });
      await expect(openNotificationSettings(d.base)).resolves.toEqual({
        ok: true,
      });
      expect(spawnedChild.unrefs).toBe(1);
    });

    it('surfaces an absent binary instead of a silent success', async () => {
      const d = deps({
        platform: 'linux',
        desktop: 'KDE',
        spawnDetached: () => child('error'),
      });
      await expect(openNotificationSettings(d.base)).resolves.toEqual({
        ok: false,
        error: 'No se pudo abrir el panel del sistema',
      });
    });

    it('assumes success when the child neither spawns nor errors in time', async () => {
      const d = deps({
        platform: 'linux',
        desktop: 'GNOME',
        spawnDetached: () => child('never'),
      });
      await expect(openNotificationSettings(d.base)).resolves.toEqual({
        ok: true,
      });
    });

    it('turns a thrown failure into a reported one', async () => {
      const d = deps({
        openExternal: () => {
          throw new Error('no handler');
        },
      });
      await expect(openNotificationSettings(d.base)).resolves.toEqual({
        ok: false,
        error: 'no handler',
      });
    });
  });
});
