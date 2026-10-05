// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  byId,
  LINKED,
  settle,
  startLinked,
  state,
  tabButton,
  tap,
  tapId,
  text,
  visibleView,
  type PageHarness,
} from './helpers/remote-page.js';
import type { RemoteUpdateView } from '../src/ipc-contract/remote-wire.js';

/**
 * «Ajustes»: the update, the four switches a phone may change, and this
 * device — its name, when it was linked, and unlinking it.
 */

const SETTINGS = {
  autostart: true,
  notifySuccess: true,
  silenceWarnings: false,
  silenceErrors: false,
};

async function openSettings(update?: RemoteUpdateView): Promise<PageHarness> {
  const h = await startLinked(update ? state({ update }) : state());
  h.answer('settings.get', { status: 200, body: SETTINGS });
  tap(tabButton('settings'));
  await settle();
  return h;
}

const toggle = (key: string) => byId<HTMLInputElement>(`set-${key}`);

describe('renderer/remote/settings-tab.ts', () => {
  describe('switches', () => {
    it('shows the four switches as DevBar has them', async () => {
      await openSettings();

      expect(toggle('autostart').checked).toBe(true);
      expect(toggle('notifySuccess').checked).toBe(true);
      expect(toggle('silenceWarnings').checked).toBe(false);
      expect(toggle('silenceErrors').checked).toBe(false);
    });

    it('saves a switch the moment it changes', async () => {
      const h = await openSettings();
      h.answer('settings.set', {
        status: 200,
        body: { ...SETTINGS, silenceWarnings: true },
      });

      toggle('silenceWarnings').checked = true;
      toggle('silenceWarnings').dispatchEvent(new Event('change'));
      await settle();

      expect(h.callsTo('settings.set').at(-1)?.body).toEqual({
        silenceWarnings: true,
      });
      expect(toggle('silenceWarnings').checked).toBe(true);
    });

    it('puts a switch back when the save fails', async () => {
      const h = await openSettings();
      h.answer('settings.set', new Error('offline'));

      toggle('autostart').checked = false;
      toggle('autostart').dispatchEvent(new Event('change'));
      await settle();

      expect(toggle('autostart').checked).toBe(true);
      expect(text('toast')).toBe('No se pudo guardar el ajuste.');
    });
  });

  describe('the update card', () => {
    it('says it is up to date', async () => {
      await openSettings();

      expect(text('update-title')).toBe('Estás al día');
      expect(text('update-text')).toBe('DevBar 0.11.0');
      expect(byId('update-apply').hidden).toBe(true);
    });

    it('installs a staged update from here, after asking', async () => {
      const h = await openSettings({
        currentVersion: '0.11.0',
        state: 'ready',
        version: '0.12.0',
      });
      h.answer('update.apply', {
        status: 202,
        body: { ok: true, restarting: true },
      });

      expect(text('update-title')).toBe('DevBar 0.12.0 disponible');
      expect(text('update-text')).toBe(
        'Tienes la 0.11.0. DevBar se reiniciará en el ordenador; esta sesión se reconecta sola.',
      );
      tapId('update-apply');
      await settle();

      expect(h.confirms).toHaveLength(1);
      expect(h.callsTo('update.apply')).toHaveLength(1);
      expect(text('update-title')).toBe('Reiniciando DevBar…');
      expect(byId('update-progress').hidden).toBe(false);
    });

    it('does nothing when the user changes their mind', async () => {
      const h = await openSettings({
        currentVersion: '0.11.0',
        state: 'ready',
        version: '0.12.0',
      });
      h.refuseConfirm();

      tapId('update-apply');
      await settle();

      expect(h.callsTo('update.apply')).toEqual([]);
    });

    it('says when the update is no longer ready', async () => {
      const h = await openSettings({
        currentVersion: '0.11.0',
        state: 'ready',
        version: '0.12.0',
      });
      h.answer('update.apply', {
        status: 409,
        body: { error: 'not-ready' },
      });

      tapId('update-apply');
      await settle();

      expect(text('toast')).toBe('La actualización ya no está lista.');
    });

    it('sends an update that is not staged to the computer', async () => {
      await openSettings({
        currentVersion: '0.11.0',
        state: 'manual',
        version: '0.12.0',
      });

      expect(text('update-title')).toBe('DevBar 0.12.0 disponible');
      expect(text('update-text')).toBe(
        'Esta actualización se instala desde el ordenador: DevBar › Configuración › Acerca de.',
      );
      expect(byId('update-apply').hidden).toBe(true);
    });

    it('follows a download and a restart as they happen', async () => {
      const h = await openSettings({
        currentVersion: '0.11.0',
        state: 'busy',
        version: '0.12.0',
      });
      expect(text('update-title')).toBe('Preparando DevBar 0.12.0…');
      expect(byId('update-progress').hidden).toBe(false);

      h.source().emit('update', {
        currentVersion: '0.11.0',
        state: 'restarting',
        version: '0.12.0',
      });

      expect(text('update-title')).toBe('Reiniciando DevBar…');
      expect(text('update-text')).toBe('Reconectando esta sesión…');
    });
  });

  describe('this device', () => {
    it('shows its name, when it was linked and where it is connected', async () => {
      await openSettings();

      expect(text('device-name-value')).toBe('iPhone de Ana');
      expect(text('device-linked')).toMatch(/^12 sept?\.? 2026$/);
      expect(text('connected-footer')).toBe(
        'Conectado a Mac-de-Ana · 192.168.1.20',
      );
    });

    it('renames it', async () => {
      const h = await openSettings();
      h.answer('device.rename', { status: 200, body: { ok: true } });

      tapId('rename');
      expect(byId('rename-form').hidden).toBe(false);
      byId<HTMLInputElement>('rename-input').value = '  Móvil  ';
      byId('rename-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();

      expect(h.callsTo('device.rename')[0]?.body).toEqual({
        name: 'Móvil',
      });
      expect(text('device-name-value')).toBe('Móvil');
      expect(byId('rename-form').hidden).toBe(true);
    });

    it('explains a name DevBar refuses', async () => {
      const h = await openSettings();
      h.answer('device.rename', {
        status: 400,
        body: { error: 'invalid-name' },
      });

      tapId('rename');
      byId('rename-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();

      expect(text('rename-error')).toBe(
        'Ponle un nombre de 1 a 40 caracteres.',
      );
      tapId('rename-cancel');
      expect(byId('rename-form').hidden).toBe(true);
    });

    it('asks first, then unlinks and forgets its keys', async () => {
      const h = await openSettings();
      h.answer('unlink', { status: 200, body: { ok: true } });

      tapId('unlink');
      await settle();

      expect(h.confirms).toHaveLength(1);
      expect(h.callsTo('unlink')[0]?.body).toEqual({});
      expect(visibleView()).toBe('unlinked');
      expect(h.source().closed).toBe(true);
      expect(h.keys()).toBeNull();
    });

    it('does nothing when the user changes their mind', async () => {
      const h = await openSettings();
      h.refuseConfirm();

      tapId('unlink');
      await settle();

      expect(h.callsTo('unlink')).toEqual([]);
      expect(visibleView()).toBe('linked');
    });

    it('lands on the unlinked view if the computer already removed it', async () => {
      const h = await openSettings();
      h.answer('unlink', {
        status: 401,
        body: { error: 'unlinked' },
      });

      tapId('unlink');
      await settle();

      expect(visibleView()).toBe('unlinked');
    });

    it('says so when the unlink cannot reach DevBar', async () => {
      const h = await openSettings();
      h.answer('unlink', new Error('offline'));

      tapId('unlink');
      await settle();

      expect(visibleView()).toBe('linked');
      expect(text('toast')).toBe('No se pudo conectar con DevBar.');
    });

    it('reads the current name again each time the tab opens', async () => {
      const h = await openSettings();
      h.answer('me', {
        status: 200,
        body: {
          ...LINKED.body,
          device: { ...LINKED.body.device, name: 'Renombrado' },
        },
      });

      tap(tabButton('groups'));
      tap(tabButton('settings'));
      await settle();

      expect(text('device-name-value')).toBe('Renombrado');
    });
  });
});
