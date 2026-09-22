// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  answerBystanderSettingsReads,
  openConfigWindow,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { GlobalSettings } from '../src/domain-types.js';

function settings(extra: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    autostart: true,
    theme: 'dark',
    silenceWarnings: true,
    silenceErrors: false,
    maxLogLines: 1234,
    notifySuccess: false,
    ...extra,
  } as GlobalSettings;
}

function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no #${id}`);
  return el;
}

function click(id: string): void {
  document
    .getElementById(id)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function themeButton(value: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `.theme-opt[data-theme-value="${value}"]`,
  );
  if (!el) throw new Error(`no theme option ${value}`);
  return el;
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

function hintText(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

describe('renderer/config/settings-pane.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  // These two run FIRST on purpose: a `focus` event reaches every window this
  // file has already loaded, and only a window whose settings never loaded
  // re-reads them. Keeping them at the top means no earlier instance is still
  // waiting on a read, so the call counts below are exact.
  describe('focus retry', () => {
    it('does not re-read once the settings are loaded', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings());
      const before = win.callCount('getSettings');
      window.dispatchEvent(new Event('focus'));
      expect(win.callCount('getSettings')).toBe(before);
    });

    it('blocks the controls and re-reads on the next focus when the read fails', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.fail('getSettings', new Error('store locked'));
      expect(toastText()).toContain('store locked');
      // Blocked: a change must not persist the controls' stale HTML defaults.
      input('set-autostart').dispatchEvent(new Event('change'));
      expect(win.callCount('saveSettings')).toBe(0);
      const before = win.callCount('getSettings');
      window.dispatchEvent(new Event('focus'));
      expect(win.callCount('getSettings')).toBe(before + 1);
      await win.settle('getSettings', settings());
      expect(input('set-autostart').checked).toBe(true);
    });
  });

  describe('loading', () => {
    it('applies every stored value to its control', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings());
      expect(input('set-autostart').checked).toBe(true);
      expect(input('set-silence-warnings').checked).toBe(true);
      expect(input('set-silence-errors').checked).toBe(false);
      expect(input('set-max-log-lines').value).toBe('1234');
      expect(input('set-notify-success').checked).toBe(false);
      expect(themeButton('dark').getAttribute('aria-pressed')).toBe('true');
      expect(themeButton('auto').getAttribute('aria-pressed')).toBe('false');
    });

    it('falls back to the built-in log limit and to the auto theme', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', {
        maxLogLines: null,
        theme: null,
        notifySuccess: true,
      });
      expect(input('set-max-log-lines').value).not.toBe('');
      expect(themeButton('auto').getAttribute('aria-pressed')).toBe('true');
      expect(input('set-notify-success').checked).toBe(true);
    });
  });

  describe('instant-save controls', () => {
    it('persists every control together and says so', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings());
      input('set-autostart').checked = false;
      input('set-autostart').dispatchEvent(new Event('change'));
      expect(win.callCount('saveSettings')).toBe(1);
      await win.settle('saveSettings', settings());
      expect(toastText()).toBe('Ajustes guardados');
    });

    it('persists the log limit on change and on blur', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings());
      const field = input('set-max-log-lines');
      field.value = '';
      field.dispatchEvent(new Event('change'));
      field.dispatchEvent(new Event('blur'));
      expect(win.callCount('saveSettings')).toBe(2);
    });

    it('persists the silence and notification toggles', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings());
      input('set-notify-success').dispatchEvent(new Event('change'));
      input('set-silence-warnings').dispatchEvent(new Event('change'));
      input('set-silence-errors').dispatchEvent(new Event('change'));
      expect(win.callCount('saveSettings')).toBe(3);
    });
  });

  describe('theme picker', () => {
    it('marks the clicked theme and persists only that patch', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings({ theme: 'auto' }));
      themeButton('light').click();
      expect(themeButton('light').getAttribute('aria-pressed')).toBe('true');
      expect(win.callCount('saveSettings')).toBe(1);
      await win.settle('saveSettings', settings());
      expect(themeButton('light').classList.contains('is-on')).toBe(true);
    });

    it('ignores a click before the settings are loaded', async () => {
      win = await openConfigWindow();
      themeButton('light').click();
      expect(win.callCount('saveSettings')).toBe(0);
    });

    it('rolls back to the previous theme when the save is rejected', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings({ theme: 'auto' }));
      themeButton('dark').click();
      await win.fail('saveSettings', new Error('disk full'));
      expect(themeButton('auto').getAttribute('aria-pressed')).toBe('true');
      expect(toastText()).toContain('se ha restaurado el anterior');
    });

    it('lets a newer click keep the control when an older save fails', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', settings({ theme: 'auto' }));
      themeButton('dark').click();
      themeButton('light').click();
      await win.settleNewest('saveSettings', settings({ theme: 'light' }));
      await win.fail('saveSettings', new Error('disk full'));
      expect(
        themeButton('light').getAttribute('aria-pressed'),
        'the older failure must not revert the newer selection',
      ).toBe('true');
    });
  });

  describe('notification helpers', () => {
    it('confirms the test banner', async () => {
      win = await openConfigWindow();
      click('test-notification');
      await win.settle('testNotification', { ok: true });
      expect(toastText()).toBe('Banner de prueba mostrado');
    });

    it('gives the macOS route when the system panel will not open', async () => {
      win = await openConfigWindow('darwin');
      click('open-notification-settings');
      await win.settle('openNotificationSettings', { ok: false });
      expect(toastText()).toContain('en macOS');
    });

    it('gives the Windows route when the system panel will not open', async () => {
      win = await openConfigWindow('win32');
      click('open-notification-settings');
      await win.settle('openNotificationSettings', { ok: false });
      expect(toastText()).toContain('en Windows');
    });

    it('gives the desktop-environment route on Linux', async () => {
      win = await openConfigWindow('linux');
      click('open-notification-settings');
      await win.settle('openNotificationSettings', { ok: false });
      expect(toastText()).toContain('en GNOME');
    });

    it('stays quiet when the system panel opens', async () => {
      win = await openConfigWindow();
      click('open-notification-settings');
      await win.settle('openNotificationSettings', { ok: true });
      expect(toastText()).toBe('');
    });
  });

  describe('per-OS copy', () => {
    it('names the macOS login items and notification panel', async () => {
      win = await openConfigWindow('darwin');
      expect(hintText('autostart-hint')).toContain('Login Items');
      expect(hintText('notif-hint')).toContain('macOS pide permiso');
      expect(
        document.getElementById('open-notification-settings')?.textContent,
      ).toBe('Ajustes del sistema → Notificaciones');
    });

    it('names the Windows Run key and Settings app', async () => {
      win = await openConfigWindow('win32');
      expect(hintText('autostart-hint')).toContain('clave Run');
      expect(
        document.getElementById('open-notification-settings')?.textContent,
      ).toBe('Configuración → Sistema → Notificaciones');
    });

    it('names the XDG autostart and leaves the desktop panel generic', async () => {
      win = await openConfigWindow('linux');
      expect(hintText('autostart-hint')).toContain('XDG');
      expect(hintText('notif-hint')).toContain('GNOME');
      expect(
        document.getElementById('open-notification-settings')?.textContent,
      ).toBe('los ajustes del sistema');
    });
  });
});
