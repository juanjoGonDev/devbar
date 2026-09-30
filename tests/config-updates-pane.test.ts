// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { openConfigWindow, updateStatus } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { UpdatePhase, UpdateStatus } from '../src/ipc-contract.js';

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

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found;
}

function progressBar(): HTMLProgressElement {
  const found = document.getElementById('update-progress');
  if (!(found instanceof HTMLProgressElement))
    throw new Error('no #update-progress');
  return found;
}

const MB = 1024 * 1024;
const DEB = '/home/pi/Downloads/DevBar-9.9.9-linux-arm64.deb';

/** Boots the pane with release 9.9.9 known, then pushes `phase`. */
async function withPhase(
  win: RendererWindow,
  phase: UpdatePhase,
): Promise<void> {
  await win.settle('getUpdateStatus', updateStatus('9.9.9'));
  await win.push('onUpdatePhase', phase);
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

  describe('pushed phase', () => {
    it('keeps a phase pushed before the boot read over the one it carries', async () => {
      win = await openConfigWindow();
      await win.push('onUpdatePhase', {
        state: 'downloading',
        version: '9.9.9',
        received: 1,
        total: 4,
      });
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      expect(statusText()).toContain('Descargando v9.9.9 — 25 %');
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

    it('leaves a download to the pane instead of claiming it with a toast', async () => {
      // The toast used to say "Descargando…" only AFTER the whole download
      // had finished; the phase pushes now tell the story as it happens.
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      const apply = button('apply-update');
      apply.click();
      await win.settle('applyUpdate', { ok: true, path: DEB });
      expect(toastText()).toBe('');
      expect(apply.disabled).toBe(false);
    });

    it('stays quiet when another download is already running', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      button('apply-update').click();
      await win.settle('applyUpdate', { ok: false, busy: true });
      expect(toastText()).toBe('');
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

  describe('update phases', () => {
    it('says the check failed instead of "al día"', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', {
        ...updateStatus(null),
        phase: { state: 'check-failed', reason: 'GitHub respondió HTTP 403' },
      });
      expect(statusText()).toBe(
        'No se pudo comprobar: GitHub respondió HTTP 403',
      );
      expect(statusText()).not.toContain('Al día');
    });

    it('says it is checking while a manual check runs', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus(null));
      await win.push('onUpdatePhase', { state: 'checking' });
      expect(statusText()).toBe('Buscando actualizaciones…');
    });

    it('shows the percentage, the megabytes and a progress bar', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'downloading',
        version: '9.9.9',
        received: Math.round(18.3 * MB),
        total: Math.round(43.5 * MB),
      });
      expect(statusText()).toBe('Descargando v9.9.9 — 42 % (18,3 / 43,5 MB)');
      expect(progressBar().hidden).toBe(false);
      expect(progressBar().value).toBe(42);
      expect(button('apply-update').disabled).toBe(true);
    });

    it('shows the megabytes alone when the size is unknown', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'downloading',
        version: '9.9.9',
        received: 2 * MB,
        total: null,
      });
      expect(statusText()).toBe('Descargando v9.9.9 — 2,0 MB');
      expect(progressBar().hasAttribute('value')).toBe(false);
    });

    it('hides the progress bar once the download is over', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'downloading',
        version: '9.9.9',
        received: 1,
        total: 2,
      });
      await win.push('onUpdatePhase', { state: 'verifying', version: '9.9.9' });
      expect(statusText()).toBe('Verificando la integridad de v9.9.9…');
      expect(progressBar().hidden).toBe(true);
    });

    it('explains a failed download and offers a retry', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'download-failed',
        version: '9.9.9',
        reason: 'ECONNRESET',
      });
      expect(statusText()).toBe('No se pudo descargar v9.9.9: ECONNRESET');
      expect(button('apply-update').textContent).toBe('Reintentar');
      expect(button('apply-update').disabled).toBe(false);
    });

    it('explains a failed verification and offers a retry', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'verify-failed',
        version: '9.9.9',
        reason: 'el hash no coincide',
      });
      expect(statusText()).toBe(
        'La descarga de v9.9.9 no superó la verificación: el hash no coincide',
      );
      expect(button('apply-update').textContent).toBe('Reintentar');
    });

    it('offers "Instalar ahora" for a downloaded package, with the manual route beside it', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'ready-to-install',
        version: '9.9.9',
        path: DEB,
        install: 'package',
        command: `sudo apt install ${DEB}`,
      });
      expect(statusText()).toBe('v9.9.9 descargada y verificada.');
      expect(button('apply-update').textContent).toBe('Instalar ahora');
      expect(el('update-help').hidden).toBe(false);
      expect(el('update-command').textContent).toBe(`sudo apt install ${DEB}`);
      expect(button('update-copy-command').hidden).toBe(false);
      expect(button('update-open-folder').hidden).toBe(false);
    });

    it('gives exact instructions when the package cannot be installed for the user', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'ready-to-install',
        version: '9.9.9',
        path: DEB,
        install: 'manual',
        command: `sudo apt install ${DEB}`,
      });
      expect(statusText()).toBe('v9.9.9 descargada en /home/pi/Downloads.');
      expect(button('apply-update').style.display).toBe('none');
      expect(el('update-help-text').textContent).toContain('terminal');
      expect(el('update-command').textContent).toBe(`sudo apt install ${DEB}`);
    });

    it('tells an AppImage user where the new image is, with a folder button', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'ready-to-install',
        version: '9.9.9',
        path: '/home/pi/Downloads/DevBar-9.9.9-linux-arm64.AppImage',
        install: 'manual',
        command: null,
      });
      expect(el('update-help-text').textContent).toContain('AppImage');
      expect(el('update-command').hidden).toBe(true);
      expect(button('update-copy-command').hidden).toBe(true);
      expect(button('update-open-folder').hidden).toBe(false);
    });

    it('keeps the restart wording for a staged in-place update', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'ready-to-install',
        version: '9.9.9',
        path: '/staged/DevBar.AppImage',
        install: 'restart',
        command: null,
      });
      expect(statusText()).toContain('descargada, lista para instalar');
      expect(button('apply-update').textContent).toBe(
        'Reiniciar e instalar v9.9.9',
      );
      expect(el('update-help').hidden).toBe(true);
    });

    it('waits for the system password prompt while installing', async () => {
      win = await openConfigWindow();
      await withPhase(win, { state: 'installing', version: '9.9.9' });
      expect(statusText()).toContain('Instalando v9.9.9…');
      expect(button('apply-update').disabled).toBe(true);
    });

    it('keeps the file, the command and a retry after a failed install', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'install-failed',
        version: '9.9.9',
        reason: 'autenticación cancelada',
        path: DEB,
        command: `sudo apt install ${DEB}`,
      });
      expect(statusText()).toBe(
        'No se pudo instalar v9.9.9: autenticación cancelada',
      );
      expect(button('apply-update').textContent).toBe('Reintentar');
      expect(el('update-command').textContent).toBe(`sudo apt install ${DEB}`);
      expect(button('update-copy-command').hidden).toBe(false);
      expect(button('update-open-folder').hidden).toBe(false);
    });

    it('points at the file when a failed install has no command', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'install-failed',
        version: '9.9.9',
        reason: 'no se pudo abrir',
        path: '/Users/me/Downloads/DevBar.dmg',
        command: null,
      });
      expect(el('update-help-text').textContent).toContain(
        '/Users/me/Downloads',
      );
    });

    it('says it is restarting', async () => {
      win = await openConfigWindow();
      await withPhase(win, { state: 'restarting', version: '9.9.9' });
      expect(statusText()).toBe('Reiniciando para instalar v9.9.9…');
    });

    it('ignores a phase about an older release', async () => {
      win = await openConfigWindow();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      await win.push('onUpdatePhase', {
        state: 'download-failed',
        version: '9.9.8',
        reason: 'x',
      });
      expect(statusText()).toContain('Actualización v9.9.9 disponible');
    });

    it('copies the command and confirms it', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'install-failed',
        version: '9.9.9',
        reason: 'x',
        path: DEB,
        command: `sudo apt install ${DEB}`,
      });
      button('update-copy-command').click();
      await win.settle('copyUpdateCommand', { ok: true });
      expect(toastText()).toBe('Comando copiado');
    });

    it('reports a copy that failed', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'install-failed',
        version: '9.9.9',
        reason: 'x',
        path: DEB,
        command: `sudo apt install ${DEB}`,
      });
      button('update-copy-command').click();
      await win.settle('copyUpdateCommand', { ok: false, error: 'no_command' });
      expect(toastText()).toBe('No se pudo copiar el comando');
    });

    it('opens the download folder, and says so when it cannot', async () => {
      win = await openConfigWindow();
      await withPhase(win, {
        state: 'install-failed',
        version: '9.9.9',
        reason: 'x',
        path: DEB,
        command: null,
      });
      button('update-open-folder').click();
      await win.settle('showUpdateDownload', { ok: false, error: 'no_file' });
      expect(toastText()).toBe('No se pudo abrir la carpeta');
    });
  });
});
