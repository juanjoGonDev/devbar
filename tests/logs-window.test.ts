// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type { LogListGroup } from '../src/ipc-contract.js';

/** The debounce `logs.ts` puts in front of a pushed refresh, plus slack. */
const REFRESH_DEBOUNCE_MS = 300;

function logGroup(name: string): LogListGroup {
  return {
    groupId: `group-${name}`,
    groupName: name,
    groupIcon: '📁',
    items: [],
  };
}

function sidebarGroups(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#side-tree .g-name'),
    (el) => el.textContent ?? '',
  );
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('renderer/logs.ts', () => {
  let logs: RendererWindow | null = null;

  afterEach(() => {
    logs?.close();
    logs = null;
    localStorage.clear();
  });

  async function openLogs(): Promise<RendererWindow> {
    const win = await loadRendererWindow({
      html: 'logs.html',
      load: () => import('../renderer/logs.js'),
      values: { platform: 'macos' },
    });
    logs = win;
    // Two reads of the settings are outstanding here: `theme.ts` takes one to
    // pick the theme, and the bootstrap takes another for the retention cap.
    // Only the second one goes on to call `listLogs`.
    await win.settle('getSettings', { theme: 'auto', maxLogLines: 5000 });
    await win.settle('getSettings', { theme: 'auto', maxLogLines: 5000 });
    return win;
  }

  describe('sidebar refresh', () => {
    it('renders the boot read when no other refresh is in flight', async () => {
      const win = await openLogs();
      await win.settle('listLogs', [logGroup('api')]);
      expect(sidebarGroups()).toEqual(['api']);
    });

    it('keeps the newer refresh when an older one resolves after it', async () => {
      // The debounce in `onUpdate` collapses SCHEDULED refreshes, never one
      // already in flight: the boot read and a pushed one overlap, and the
      // loser of that race is whichever main process answered first.
      const win = await openLogs();
      await win.push('onUpdate');
      await wait(REFRESH_DEBOUNCE_MS);
      expect(
        win.callCount('listLogs'),
        'the pushed refresh must overlap the boot one',
      ).toBe(2);
      await win.settleNewest('listLogs', [logGroup('api'), logGroup('web')]);
      await win.settle('listLogs', [logGroup('viejo')]);
      expect(sidebarGroups()).toEqual(['api', 'web']);
    });
  });
});
