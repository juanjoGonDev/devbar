// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  group,
  keyboardReorder,
  openConfigWindow,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

function navCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#groups-list .nav-card')];
}

function navNames(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('#groups-list .nav-name'),
  ].map((el) => el.textContent ?? '');
}

function cardFor(id: string): HTMLElement {
  const el = navCards().find((card) => card.dataset.id === id);
  if (!el) throw new Error(`no nav card for ${id}`);
  return el;
}

function nameInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.detail-name-input');
  if (!el) throw new Error('the detail pane drew no name field');
  return el;
}

function rename(value: string): void {
  const input = nameInput();
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

describe('renderer/config/groups-list.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('rendering', () => {
    it('invites the user to add one when there is nothing', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', []);
      expect(
        document.querySelector('#groups-list .nav-empty')?.textContent,
      ).toBe('Sin grupos. Pulsa + Añadir.');
      expect(document.querySelector('.detail-empty')).not.toBeNull();
    });

    it('lands on the first group so the pane is never an empty prompt', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      expect(cardFor('group-api').classList.contains('selected')).toBe(true);
      expect(nameInput().value).toBe('api');
    });

    it('falls back for a group with no name and no icon', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('x', { name: '', icon: '' })]);
      expect(navNames()).toEqual(['(sin nombre)']);
      expect(
        document.querySelector<HTMLElement>('#groups-list .nav-icon')
          ?.textContent,
      ).toBe('📦');
    });
  });

  describe('switching group', () => {
    it('opens the clicked group', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      cardFor('group-web').click();
      expect(cardFor('group-web').classList.contains('selected')).toBe(true);
      expect(nameInput().value).toBe('web');
    });

    it('ignores a click on the group already open', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      rename('api-edited');
      cardFor('group-api').click();
      expect(win.callCount('confirmDirty')).toBe(0);
      expect(nameInput().value).toBe('api-edited');
    });

    it('ignores a click that started on the drag handle', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      cardFor('group-web')
        .querySelector<HTMLElement>('.drag-handle')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cardFor('group-api').classList.contains('selected')).toBe(true);
    });
  });

  describe('switching away from unsaved edits', () => {
    it('stays put when the user cancels', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      rename('api-2');
      cardFor('group-web').click();
      await win.settle('confirmDirty', { choice: 'cancel' });
      expect(nameInput().value).toBe('api-2');
      expect(win.callCount('saveGroup')).toBe(0);
    });

    it('throws the edits away and switches on discard', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      rename('api-2');
      cardFor('group-web').click();
      await win.settle('confirmDirty', { choice: 'discard' });
      expect(nameInput().value).toBe('web');
      expect(win.callCount('saveGroup')).toBe(0);
    });

    it('saves first, then switches', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      rename('api-2');
      cardFor('group-web').click();
      await win.settle('confirmDirty', { choice: 'save' });
      await win.settle('saveGroup', { ...group('api'), name: 'api-2' });
      await win.settle('listGroups', [
        { ...group('api'), name: 'api-2' },
        group('web'),
      ]);
      expect(navNames()).toEqual(['api-2', 'web']);
      expect(nameInput().value).toBe('web');
    });

    it('stays put when the save is refused', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [
        group('api', { path: '' }),
        group('web'),
      ]);
      rename('api-2');
      cardFor('group-web').click();
      await win.settle('confirmDirty', { choice: 'save' });
      expect(
        win.callCount('saveGroup'),
        'an empty path never reaches main',
      ).toBe(0);
      expect(toastText()).toBe('El path no puede estar vacío');
      expect(nameInput().value).toBe('api-2');
    });

    it('surfaces a save that blew up and stays put', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      rename('api-2');
      cardFor('group-web').click();
      await win.settle('confirmDirty', { choice: 'save' });
      await win.fail('saveGroup', new Error('disk full'));
      expect(toastText()).toBe('Error: disk full');
      expect(nameInput().value).toBe('api-2');
    });
  });

  describe('reordering', () => {
    it('persists the new order and reads the list back', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api'), group('web')]);
      keyboardReorder(cardFor('group-api'), 'down');
      expect(win.callCount('reorderGroups')).toBe(1);
      await win.settle('reorderGroups', { ok: true });
      await win.settle('listGroups', [group('web'), group('api')]);
      expect(navNames()).toEqual(['web', 'api']);
    });
  });

  describe('live updates', () => {
    it('re-syncs a clean pane from the pushed groups', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api')]);
      await win.push('onUpdate');
      await win.settle('listGroups', [
        { ...group('api'), name: 'api-renamed' },
      ]);
      expect(nameInput().value).toBe('api-renamed');
    });

    it('never overwrites a pane with unsaved edits', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', [group('api')]);
      rename('mine');
      await win.push('onUpdate');
      await win.settle('listGroups', [{ ...group('api'), name: 'theirs' }]);
      expect(nameInput().value).toBe('mine');
      expect(navNames()).toEqual(['theirs']);
    });

    it('does nothing more than repaint the nav with no group open', async () => {
      win = await openConfigWindow();
      await win.settle('listGroups', []);
      await win.push('onUpdate');
      await win.settle('listGroups', [group('api')]);
      expect(navNames()).toEqual(['api']);
    });
  });
});
