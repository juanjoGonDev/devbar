// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { group, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

function detail(): HTMLElement {
  const el = document.getElementById('group-detail');
  if (!el) throw new Error('no #group-detail');
  return el;
}

function nameInput(): HTMLInputElement {
  const el = detail().querySelector<HTMLInputElement>('.detail-name-input');
  if (!el) throw new Error('the detail pane drew no name field');
  return el;
}

function pathInput(): HTMLInputElement {
  const el = detail().querySelector<HTMLInputElement>('.detail-field input');
  if (!el) throw new Error('the detail pane drew no path field');
  return el;
}

function toggle(cssClass: string): HTMLInputElement {
  const el = detail().querySelector<HTMLInputElement>(`.${cssClass}`);
  if (!el) throw new Error(`the detail pane drew no .${cssClass}`);
  return el;
}

function button(id: string): HTMLButtonElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`no #${id}`);
  return el;
}

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function check(el: HTMLInputElement, value: boolean): void {
  el.checked = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

function saveDisabled(): boolean {
  return button('detail-save').disabled;
}

describe('renderer/config/group-detail.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
  });

  async function openWithGroup(
    extra: Parameters<typeof group>[1] = {},
  ): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api', extra)]);
    return win;
  }

  describe('empty pane', () => {
    it('asks the user to pick a group', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', []);
      expect(detail().querySelector('.detail-empty')).not.toBeNull();
      expect(document.getElementById('group-save-bar')?.innerHTML).toBe('');
    });
  });

  describe('editing fields', () => {
    it('starts clean, with both save-bar buttons disabled', async () => {
      await openWithGroup();
      expect(saveDisabled()).toBe(true);
      expect(button('detail-discard').disabled).toBe(true);
    });

    it('marks the pane dirty on a rename', async () => {
      await openWithGroup();
      nameInput().value = 'api-2';
      nameInput().dispatchEvent(new Event('input'));
      expect(saveDisabled()).toBe(false);
    });

    it('trims the path as it is typed', async () => {
      const w = await openWithGroup();
      pathInput().value = '  /srv/api  ';
      pathInput().dispatchEvent(new Event('input'));
      expect(saveDisabled()).toBe(false);
      button('detail-save').click();
      await w.settle('saveGroup', group('api'));
      expect(w.callCount('saveGroup')).toBe(1);
    });

    it('records the mode radio', async () => {
      await openWithGroup();
      const multi = detail().querySelector<HTMLInputElement>(
        '.mode-toggle-row input[value="multi"]',
      );
      check(multi!, true);
      expect(saveDisabled()).toBe(false);
    });

    it('records both silence toggles', async () => {
      await openWithGroup();
      check(toggle('detail-silence-warn'), true);
      expect(saveDisabled()).toBe(false);
      check(toggle('detail-silence-err'), true);
      expect(toggle('detail-silence-err').checked).toBe(true);
    });

    it('records the pipeline-wait toggle', async () => {
      await openWithGroup();
      check(toggle('detail-wait-pipeline'), false);
      expect(saveDisabled()).toBe(false);
    });

    it('records an env entry typed into the group editor', async () => {
      await openWithGroup({ env: [{ key: 'A', value: '1', enabled: true }] });
      const key = detail().querySelector<HTMLInputElement>('.env-key');
      key!.value = 'B';
      key!.dispatchEvent(new Event('input', { bubbles: true }));
      expect(saveDisabled()).toBe(false);
    });

    it('records an env toggle flipped in the group editor', async () => {
      await openWithGroup({ env: [{ key: 'A', value: '1', enabled: true }] });
      const row = detail().querySelector<HTMLElement>('.env-entry');
      check(
        row!.querySelector<HTMLInputElement>('input[type=checkbox]')!,
        false,
      );
      expect(saveDisabled()).toBe(false);
    });
  });

  describe('icon picker', () => {
    it('adopts the emoji the user picks', async () => {
      const w = await openWithGroup();
      await w.settle('getIconBattery', [
        { emoji: '🚀', label: 'rocket', group: 'Objects', keywords: [] },
      ]);
      click(detail().querySelector('.icon-btn'));
      click(document.querySelector('#icon-picker .icon-cell'));
      expect(detail().querySelector('.icon-btn')?.textContent).toBe('🚀');
      expect(saveDisabled()).toBe(false);
    });
  });

  describe('folder picker', () => {
    it('writes the chosen folder into the path field', async () => {
      const w = await openWithGroup();
      click(document.getElementById('grp-path-pick'));
      await w.settle('pickFolder', { ok: true, path: '/srv/api' });
      expect(pathInput().value).toBe('/srv/api');
      expect(saveDisabled()).toBe(false);
    });

    it('leaves the field alone when the user cancels', async () => {
      const w = await openWithGroup();
      click(document.getElementById('grp-path-pick'));
      await w.settle('pickFolder', { canceled: true });
      expect(pathInput().value).toBe('/tmp/api');
    });

    it('surfaces a refused folder dialog', async () => {
      const w = await openWithGroup();
      click(document.getElementById('grp-path-pick'));
      await w.settle('pickFolder', { ok: false, error: 'no access' });
      expect(toastText()).toBe('Error: no access');
    });

    it('falls back to a generic reason, and ignores an empty answer', async () => {
      const w = await openWithGroup();
      click(document.getElementById('grp-path-pick'));
      await w.settle('pickFolder', { ok: false });
      expect(toastText()).toBe('Error: desconocido');
      click(document.getElementById('grp-path-pick'));
      await w.settle('pickFolder', { ok: true });
      expect(pathInput().value).toBe('/tmp/api');
    });
  });

  describe('save bar', () => {
    it('saves and confirms', async () => {
      const w = await openWithGroup();
      nameInput().value = 'api-2';
      nameInput().dispatchEvent(new Event('input'));
      button('detail-save').click();
      await w.settle('saveGroup', { ...group('api'), name: 'api-2' });
      expect(toastText()).toBe('Grupo guardado');
      expect(saveDisabled()).toBe(true);
    });

    it('says so when main turned auto-start off for a single-mode group', async () => {
      const w = await openWithGroup();
      nameInput().value = 'api-2';
      nameInput().dispatchEvent(new Event('input'));
      button('detail-save').click();
      await w.settle('saveGroup', {
        ...group('api'),
        name: 'api-2',
        _autoStartEnforced: true,
      });
      expect(toastText()).toContain('Auto-arranque desactivado');
    });

    it('surfaces a save that blew up', async () => {
      const w = await openWithGroup();
      nameInput().value = 'api-2';
      nameInput().dispatchEvent(new Event('input'));
      button('detail-save').click();
      await w.fail('saveGroup', new Error('disk full'));
      expect(toastText()).toBe('Error: disk full');
    });

    it('ignores a click while the pane is clean', async () => {
      const w = await openWithGroup();
      button('detail-save').click();
      button('detail-discard').click();
      expect(w.callCount('saveGroup')).toBe(0);
    });

    it('puts the stored values back on discard', async () => {
      await openWithGroup();
      nameInput().value = 'api-2';
      nameInput().dispatchEvent(new Event('input'));
      button('detail-discard').click();
      expect(nameInput().value).toBe('api');
      expect(saveDisabled()).toBe(true);
    });
  });

  describe('deleting the group', () => {
    it('does nothing when the user backs out', async () => {
      const w = await openWithGroup();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      click(detail().querySelector('.detail-btn-row .danger'));
      expect(w.callCount('deleteGroup')).toBe(0);
    });

    it('keeps the group visible when main refuses', async () => {
      const w = await openWithGroup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(detail().querySelector('.detail-btn-row .danger'));
      await w.settle('deleteGroup', { ok: false, error: 'still running' });
      expect(toastText()).toBe('still running');
      expect(nameInput().value).toBe('api');
    });

    it('falls back to a generic reason when main gives none', async () => {
      const w = await openWithGroup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(detail().querySelector('.detail-btn-row .danger'));
      await w.settle('deleteGroup', { ok: false });
      expect(toastText()).toBe('No se pudo borrar el grupo');
    });

    it('empties the pane and refreshes the pipeline once it is gone', async () => {
      const w = await openWithGroup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(detail().querySelector('.detail-btn-row .danger'));
      await w.settle('deleteGroup', { ok: true });
      await w.settle('listGroups', []);
      await w.settle('getPreSteps', []);
      expect(detail().querySelector('.detail-empty')).not.toBeNull();
      expect(w.callCount('getPreSteps')).toBeGreaterThan(0);
    });
  });
});
