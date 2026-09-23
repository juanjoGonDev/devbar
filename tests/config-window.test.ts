// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  group,
  openConfigWindow,
  updateStatus,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

function nameInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.detail-name-input');
  if (!el) throw new Error('the detail pane drew no name field');
  return el;
}

function saveButton(): HTMLButtonElement {
  const el = document.getElementById('detail-save');
  if (!(el instanceof HTMLButtonElement))
    throw new Error('the detail pane drew no save button');
  return el;
}

function rename(value: string): void {
  const input = nameInput();
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function navNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#groups-list .nav-name'),
    (el) => el.textContent ?? '',
  );
}

describe('renderer/config.ts', () => {
  let config: RendererWindow | null = null;

  afterEach(() => {
    config?.close();
    config = null;
  });

  async function openConfig(): Promise<RendererWindow> {
    config = await openConfigWindow();
    return config;
  }

  describe('groups list', () => {
    it('renders the read when nothing newer has landed', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      expect(navNames()).toEqual(['api']);
    });

    it('keeps the newer list when an older one resolves after it', async () => {
      // `onUpdate` re-reads the groups with no debounce at all, so a push
      // arriving while the window is still booting puts two reads in flight.
      // The older answer landing last resurrects groups the user just deleted.
      const win = await openConfig();
      await win.push('onUpdate');
      expect(
        win.callCount('listGroups'),
        'the pushed read must overlap the boot one',
      ).toBe(2);
      await win.settleNewest('listGroups', [group('api'), group('web')]);
      await win.settle('listGroups', [group('borrado')]);
      expect(navNames()).toEqual(['api', 'web']);
    });
  });

  describe('group draft save', () => {
    it('adopts the saved group when nothing newer has landed', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      saveButton().click();
      await win.settle('saveGroup', { ...group('api'), name: 'api-2' });
      expect(navNames()).toEqual(['api-2']);
    });

    it('keeps the newest save when an older one answers after it', async () => {
      // The save button only disables itself when the pane is CLEAN, never
      // while a save is in flight, so a second edit-and-save overlaps the
      // first. The older response landing last puts the previous name back in
      // the nav while disk already holds the newer one.
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      saveButton().click();
      rename('api-3');
      saveButton().click();
      expect(
        win.callCount('saveGroup'),
        'both clicks must have issued their own save',
      ).toBe(2);
      await win.settleNewest('saveGroup', { ...group('api'), name: 'api-3' });
      await win.settle('saveGroup', { ...group('api'), name: 'api-2' });
      expect(navNames()).toEqual(['api-3']);
    });
  });

  describe('update status', () => {
    it('renders the read when nothing newer has landed', async () => {
      const win = await openConfig();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      expect(document.getElementById('update-status')?.textContent).toContain(
        'v9.9.9',
      );
    });

    it('keeps a pushed status that landed before the read resolved', async () => {
      // The automatic check pushes on its own schedule; the window reads once
      // at boot. Losing that race tells the user they are up to date while
      // main is already holding the newer release.
      const win = await openConfig();
      await win.push('onUpdateStatus', updateStatus('9.9.9'));
      await win.settle('getUpdateStatus', updateStatus(null));
      expect(document.getElementById('update-status')?.textContent).toContain(
        'v9.9.9',
      );
    });
  });

  describe('add group', () => {
    it('selects the group main just created', async () => {
      const win = await openConfig();
      await win.settle('listGroups', []);
      document.getElementById('add-group')?.click();
      await win.settle('saveGroup', { ...group('nuevo'), id: 'group-nuevo' });
      await win.settle('listGroups', [
        { ...group('nuevo'), id: 'group-nuevo' },
      ]);
      expect(nameInput().value).toBe('nuevo');
    });

    it('surfaces a creation that blew up', async () => {
      const win = await openConfig();
      await win.settle('listGroups', []);
      document.getElementById('add-group')?.click();
      await win.fail('saveGroup', new Error('disk full'));
      expect(document.getElementById('toast')?.textContent).toBe(
        'Error: disk full',
      );
    });
  });

  describe('window close guard', () => {
    it('closes straight away with nothing unsaved', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      await win.push('onConfigCloseRequested');
      expect(win.callCount('confirmDirty')).toBe(0);
      expect(win.callCount('confirmCloseConfig')).toBe(1);
    });

    it('stays open when the user cancels', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.settle('confirmDirty', { choice: 'cancel' });
      expect(win.callCount('confirmCloseConfig')).toBe(0);
    });

    it('treats a failed prompt as a cancel', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.fail('confirmDirty', new Error('no window'));
      expect(win.callCount('confirmCloseConfig')).toBe(0);
    });

    it('throws the edits away and closes on discard', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.settle('confirmDirty', { choice: 'discard' });
      expect(win.callCount('saveGroup')).toBe(0);
      expect(win.callCount('confirmCloseConfig')).toBe(1);
    });

    it('saves first, then closes', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.settle('confirmDirty', { choice: 'save' });
      await win.settle('saveGroup', { ...group('api'), name: 'api-2' });
      expect(win.callCount('confirmCloseConfig')).toBe(1);
    });

    it('stays open when the save is refused', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api', { path: '' })]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.settle('confirmDirty', { choice: 'save' });
      expect(win.callCount('confirmCloseConfig')).toBe(0);
      expect(document.getElementById('toast')?.textContent).toBe(
        'El path no puede estar vacío',
      );
    });

    it('stays open when the save blows up', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.settle('confirmDirty', { choice: 'save' });
      await win.fail('saveGroup', new Error('disk full'));
      expect(win.callCount('confirmCloseConfig')).toBe(0);
      expect(document.getElementById('toast')?.textContent).toBe(
        'Error: disk full',
      );
    });

    it('ignores a second close request while the first is still asking', async () => {
      const win = await openConfig();
      await win.settle('listGroups', [group('api')]);
      rename('api-2');
      await win.push('onConfigCloseRequested');
      await win.push('onConfigCloseRequested');
      expect(
        win.callCount('confirmDirty'),
        'the user must not be asked twice',
      ).toBe(1);
    });
  });

  describe('version label', () => {
    it('shows the running version and opens the changelog on click', async () => {
      const win = await openConfig();
      await win.settle('getAppVersion', '1.2.3');
      const chip = document.getElementById('app-version');
      expect(chip?.textContent).toBe('v1.2.3');
      chip?.click();
      expect(document.querySelector('.modal-changelog')).not.toBeNull();
      await win.settle('getChangelog', { releases: [], repoUrl: null });
    });

    it('leaves the label empty when main reports no version', async () => {
      const win = await openConfig();
      await win.settle('getAppVersion', '');
      expect(document.getElementById('app-version')?.textContent).toBe('');
    });

    it('leaves the label empty when the read fails', async () => {
      const win = await openConfig();
      await win.fail('getAppVersion', new Error('no app'));
      expect(document.getElementById('app-version')?.textContent).toBe('');
    });
  });
});
