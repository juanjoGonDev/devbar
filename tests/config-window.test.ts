// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type { UpdateStatus } from '../src/ipc-contract.js';
import type { Group } from '../src/domain-types.js';

function group(name: string): Group {
  return {
    id: `group-${name}`,
    name,
    icon: '📦',
    path: `/tmp/${name}`,
    mode: 'single',
    order: 0,
    silenceWarnings: false,
    silenceErrors: false,
    env: [],
    commands: [],
    actions: [],
    preScripts: [],
    waitForPipeline: true,
  };
}

function updateStatus(version: string | null): UpdateStatus {
  return {
    available: version
      ? {
          version,
          url: `https://example.invalid/${version}`,
          dmgUrl: null,
          zipUrl: null,
          setupUrl: null,
          appImageUrl: null,
          debUrl: null,
        }
      : null,
    staged: null,
    lastCheckAt: null,
    currentVersion: '0.0.0',
  };
}

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
    config = await loadRendererWindow({
      html: 'config.html',
      load: () => import('../renderer/config.js'),
      values: { platform: 'macos' },
    });
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
});
