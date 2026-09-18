// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  answerBystanderSettingsReads,
  group,
  openConfigWindow,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

function click(id: string): void {
  document
    .getElementById(id)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

function toastKind(): string {
  return document.getElementById('toast')?.className ?? '';
}

const PREVIEW = { groups: 2, commands: 3 };

describe('renderer/config/backup-pane.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('export', () => {
    it('names the file it wrote', async () => {
      win = await openConfigWindow();
      click('export-config');
      await win.settle('exportConfig', { ok: true, path: '/tmp/devbar.json' });
      expect(toastText()).toBe('Exportado en /tmp/devbar.json');
    });

    it('stays quiet when the user cancels the dialog', async () => {
      win = await openConfigWindow();
      click('export-config');
      await win.settle('exportConfig', { canceled: true });
      expect(toastText()).toBe('');
    });

    it('surfaces a refused write', async () => {
      win = await openConfigWindow();
      click('export-config');
      await win.settle('exportConfig', { ok: false, error: 'read-only disk' });
      expect(toastText()).toBe('Error al exportar: read-only disk');
    });

    it('surfaces a rejected export call', async () => {
      win = await openConfigWindow();
      click('export-config');
      await win.fail('exportConfig', new Error('ipc gone'));
      expect(toastText()).toBe('Error al exportar: ipc gone');
    });
  });

  describe('import', () => {
    it('stays quiet when the user cancels the file picker', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', { canceled: true });
      expect(toastText()).toBe('');
      expect(win.callCount('confirmImport')).toBe(0);
    });

    it('surfaces an unreadable file', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', { ok: false, error: 'not json' });
      expect(toastText()).toBe('Error: not json');
    });

    it('surfaces a rejected import call', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.fail('importConfig', new Error('ipc gone'));
      expect(toastText()).toBe('Error al importar: ipc gone');
    });

    it('refuses to continue on a half-filled answer', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', { ok: true, preview: PREVIEW });
      expect(toastText()).toBe('Error: respuesta de importación incompleta');
      expect(win.callCount('confirmImport')).toBe(0);
    });

    it('surfaces a rejected confirmation', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', {
        ok: true,
        preview: PREVIEW,
        token: 't1',
      });
      await win.fail('confirmImport', new Error('window closed'));
      expect(toastText()).toBe('Error al confirmar: window closed');
    });

    it('stops when the user declines the preview', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', {
        ok: true,
        preview: PREVIEW,
        token: 't1',
      });
      await win.settle('confirmImport', { confirmed: false });
      expect(win.callCount('applyImportedConfig')).toBe(0);
    });

    it('surfaces a rejected apply call', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', {
        ok: true,
        preview: PREVIEW,
        token: 't1',
      });
      await win.settle('confirmImport', { confirmed: true });
      await win.fail('applyImportedConfig', new Error('locked'));
      expect(toastText()).toBe('Error al aplicar: locked');
    });

    it('surfaces a refused apply', async () => {
      win = await openConfigWindow();
      click('import-config');
      await win.settle('importConfig', {
        ok: true,
        preview: PREVIEW,
        token: 't1',
      });
      await win.settle('confirmImport', { confirmed: true });
      await win.settle('applyImportedConfig', {
        ok: false,
        error: 'schema drift',
      });
      expect(toastText()).toBe('Error al aplicar: schema drift');
    });

    it('reloads the whole window and reports success', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', { theme: 'auto', maxLogLines: 500 });
      await win.settle('listGroups', [group('api')]);
      await win.settle('getPreSteps', []);
      click('import-config');
      await win.settle('importConfig', {
        ok: true,
        preview: PREVIEW,
        token: 't1',
      });
      await win.settle('confirmImport', { confirmed: true });
      await win.settle('applyImportedConfig', { ok: true });
      await win.settle('getSettings', { theme: 'auto', maxLogLines: 900 });
      await win.settle('listGroups', [group('web')]);
      await win.settle('getPreSteps', []);
      expect(toastText()).toBe('Configuración importada');
      expect(toastKind()).toContain('ok');
      expect(
        document.querySelector('#groups-list .nav-name')?.textContent,
      ).toBe('web');
    });

    it('warns when the imported settings could not be re-read', async () => {
      win = await openConfigWindow();
      await answerBystanderSettingsReads(win);
      await win.settle('getSettings', { theme: 'auto', maxLogLines: 500 });
      await win.settle('listGroups', [group('api')]);
      await win.settle('getPreSteps', []);
      click('import-config');
      await win.settle('importConfig', {
        ok: true,
        preview: PREVIEW,
        token: 't1',
      });
      await win.settle('confirmImport', { confirmed: true });
      await win.settle('applyImportedConfig', { ok: true });
      await win.fail('getSettings', new Error('store locked'));
      await win.settle('listGroups', []);
      await win.settle('getPreSteps', []);
      expect(toastText()).toContain('reenfoca la ventana');
      expect(toastKind()).toContain('error');
    });
  });
});
