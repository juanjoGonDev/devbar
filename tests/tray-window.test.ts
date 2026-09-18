// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type { GroupState, UpdateStatus } from '../src/ipc-contract.js';

function groupState(name: string): GroupState {
  return {
    groupId: `group-${name}`,
    group: {
      id: `group-${name}`,
      name,
      icon: '📦',
      path: '',
      mode: 'single',
      order: 0,
      silenceWarnings: false,
      silenceErrors: false,
      env: [],
      commands: [],
      actions: [],
      preScripts: [],
      waitForPipeline: true,
    },
    currentBranch: null,
    color: 'stopped',
    commands: [],
    actions: [],
    lastError: null,
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

function renderedGroups(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#groups .group-name'),
    (el) => el.textContent ?? '',
  );
}

describe('renderer/tray.ts', () => {
  let tray: RendererWindow | null = null;

  afterEach(() => {
    tray?.close();
    tray = null;
  });

  async function openTray(): Promise<RendererWindow> {
    tray = await loadRendererWindow({
      html: 'tray.html',
      load: () => import('../renderer/tray.js'),
      values: { platform: 'macos' },
    });
    return tray;
  }

  describe('initial group states', () => {
    it('renders the read when nothing newer has landed', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [groupState('api')]);
      expect(renderedGroups()).toEqual(['api']);
    });

    it('keeps a pushed update that landed before the read resolved', async () => {
      // The ordering the window actually hits on a slow boot: main pushes
      // `groups:update` while the initial read is still in flight. Applying
      // the older snapshot afterwards leaves the tray showing groups the main
      // process no longer has, until some unrelated event pushes again.
      const win = await openTray();
      await win.push('onUpdate', [groupState('api'), groupState('web')]);
      await win.settle('getGroupStates', [groupState('viejo')]);
      expect(renderedGroups()).toEqual(['api', 'web']);
    });
  });

  describe('initial update status', () => {
    it('marks the version chip from the read when nothing newer has landed', async () => {
      const win = await openTray();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      const chip = document.getElementById('app-version');
      expect(chip?.classList.contains('has-update')).toBe(true);
    });

    it('keeps a pushed status that landed before the read resolved', async () => {
      // The check that found the update runs at boot too, so its push races
      // the read the window issues on the same tick. Losing that race drops
      // the dot from the chip until the next check, hours later.
      const win = await openTray();
      await win.push('onUpdateStatus', updateStatus('9.9.9'));
      await win.settle('getUpdateStatus', updateStatus(null));
      const chip = document.getElementById('app-version');
      expect(chip?.classList.contains('has-update')).toBe(true);
    });
  });
});
