// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { openConfigWindow, updateStatus } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { UpdateStatus } from '../src/ipc-contract.js';

function button(id: string): HTMLButtonElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`no #${id}`);
  return el;
}

function statusText(): string {
  return document.getElementById('update-status')?.textContent ?? '';
}

function versionChip(): HTMLElement {
  const el = document.getElementById('app-version');
  if (!el) throw new Error('no #app-version');
  return el;
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

function staged(version: string): UpdateStatus {
  return {
    ...updateStatus(version),
    staged: { version, appPath: `/tmp/${version}/DevBar.app` },
  };
}

describe('renderer/config/updates-pane.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('status line', () => {
    it('says "al día" and hides the install button with no release', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus(null));
      expect(statusText()).toContain('Al día');
      expect(statusText()).toContain('nunca');
      expect(button('apply-update').style.display).toBe('none');
      expect(versionChip().classList.contains('has-update')).toBe(false);
      expect(versionChip().title).toBe('Ver changelog');
    });

    it('offers the download when a release is available', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', {
        ...updateStatus('9.9.9'),
        lastCheckAt: Date.parse('2026-01-02T10:30:00Z'),
      });
      expect(statusText()).toContain('Actualización v9.9.9 disponible');
      expect(statusText()).not.toContain('nunca');
      expect(button('apply-update').textContent).toBe('Actualizar a v9.9.9');
      expect(versionChip().classList.contains('has-update')).toBe(true);
      expect(versionChip().title).toContain('v9.9.9 disponible');
    });

    it('offers the restart once the release is staged', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', staged('9.9.9'));
      expect(statusText()).toContain('descargada, lista para instalar');
      expect(button('apply-update').textContent).toBe(
        'Reiniciar e instalar v9.9.9',
      );
    });

    it('ignores an empty status', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', null);
      expect(statusText()).toBe('');
    });

    it('survives a rejected initial read', async () => {
      win = await openConfigWindow();
      await win.fail('getUpdateStatus', new Error('offline'));
      expect(statusText()).toBe('');
    });
  });

  describe('manual check', () => {
    it('restores its own label after the check answers', async () => {
      win = await openConfigWindow();
      const check = button('check-updates');
      const label = check.textContent;
      check.click();
      expect(check.textContent).toBe('Buscando…');
      expect(check.disabled).toBe(true);
      await win.settle('checkForUpdates', updateStatus('9.9.9'));
      expect(check.textContent).toBe(label);
      expect(check.disabled).toBe(false);
      expect(statusText()).toContain('v9.9.9');
    });

    it('keeps its result when the boot read answers afterwards', async () => {
      // The window reads the status once at boot; a manual check issued while
      // that read is still in flight is the FRESHER answer, so the older read
      // landing last must not announce "al día" over it.
      win = await openConfigWindow();
      button('check-updates').click();
      await win.settle('checkForUpdates', updateStatus('9.9.9'));
      await win.settle('getUpdateStatus', updateStatus(null));
      expect(statusText()).toContain('v9.9.9');
    });
  });

  describe('pushed status', () => {
    it('applies a push that lands before the boot read', async () => {
      win = await openConfigWindow();
      await win.push('onUpdateStatus', updateStatus('9.9.9'));
      await win.settle('getUpdateStatus', updateStatus(null));
      expect(statusText()).toContain('v9.9.9');
    });
  });

  describe('install button', () => {
    it('reports an in-place install and stays disabled while quitting', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', staged('9.9.9'));
      const apply = button('apply-update');
      apply.click();
      await win.settle('applyUpdate', {
        ok: true,
        inPlace: true,
        quitting: true,
      });
      expect(toastText()).toBe('Instalando y reiniciando…');
      expect(apply.disabled).toBe(true);
    });

    it('reports a download and re-enables itself', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      const apply = button('apply-update');
      apply.click();
      await win.settle('applyUpdate', { ok: true, inPlace: false });
      expect(toastText()).toBe('Descargando actualización…');
      expect(apply.disabled).toBe(false);
    });

    it('surfaces a failed install', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      button('apply-update').click();
      await win.settle('applyUpdate', { ok: false, error: 'checksum' });
      expect(toastText()).toBe('No se pudo actualizar: checksum');
    });

    it('falls back to a generic reason when none is given', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      button('apply-update').click();
      await win.settle('applyUpdate', { ok: false });
      expect(toastText()).toBe('No se pudo actualizar: desconocido');
    });

    it('stays quiet when the user cancels the install', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      button('apply-update').click();
      await win.settle('applyUpdate', { ok: false, cancelled: true });
      expect(toastText()).toBe('');
    });
  });
});
