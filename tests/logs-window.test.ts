// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { installJsdomGaps, scrolledIntoView } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';
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

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: text, ...extra };
}

function snapshot(lines: LogEntry[] = []): unknown {
  return {
    target: { kind: 'unknown', group: null, target: { name: '?' } },
    lines,
    logLimit: 5000,
    seq: 0,
    commandState: { status: 'stopped', startedAt: null },
  };
}

function mergedSnapshot(lines: LogEntry[] = []): unknown {
  return { groupName: 'Back', sources: [], lines, seqs: {} };
}

function sidebarGroups(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#side-tree .g-name'),
    (el) => el.textContent ?? '',
  );
}

function drawn(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#lines .line'),
    (el) => el.dataset.line ?? '',
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

  async function openLogs(search = '/'): Promise<RendererWindow> {
    installJsdomGaps();
    window.history.replaceState({}, '', search);
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

    it('collapses a burst of pushes into one refresh', async () => {
      const win = await openLogs();
      await win.settle('listLogs', [logGroup('api')]);
      await win.push('onUpdate');
      await win.push('onUpdate');
      await win.push('onUpdate');
      await wait(REFRESH_DEBOUNCE_MS);
      expect(win.callCount('listLogs')).toBe(2);
    });
  });

  describe('what the window was opened for', () => {
    it('shows the retention cap main answered with', async () => {
      installJsdomGaps();
      window.history.replaceState({}, '', '/');
      const win = await loadRendererWindow({
        html: 'logs.html',
        load: () => import('../renderer/logs.js'),
        values: { platform: 'macos' },
      });
      logs = win;
      await win.settle('getSettings', { theme: 'auto' });
      await win.settle('getSettings', { theme: 'auto', maxLogLines: 42 });
      await win.settle('listLogs', []);
      const view = await import('../renderer/logs/view.js');
      expect(view.view.globalRetention).toBe(42);
      expect(view.view.memoryCap).toBe(42);
    });

    it('says so when it was opened on nothing in particular', async () => {
      const win = await openLogs();
      await win.settle('listLogs', []);
      expect(document.getElementById('title')?.textContent).toBe(
        'Logs (sin proceso)',
      );
    });

    it('hides the sidebar of a detached window', async () => {
      const win = await openLogs('?detached=1&id=api');
      await win.settle('listLogs', []);
      expect(document.body.classList.contains('detached')).toBe(true);
    });

    it('opens straight onto the service it was given', async () => {
      const win = await openLogs('?id=g1:api');
      await win.settle('listLogs', []);
      expect(win.callCount('getLogs')).toBe(1);
      await win.settle('getLogs', snapshot([line('hola')]));
      expect(drawn()).toEqual(['hola']);
    });

    it('opens straight onto a merged scope, pinned to the level it carried', async () => {
      const win = await openLogs('?scope=group&groupId=g1&level=error');
      await win.settle('listLogs', []);
      expect(win.callCount('getMergedLogs')).toBe(1);
      await win.settle('getMergedLogs', mergedSnapshot());
      const view = await import('../renderer/logs/view.js');
      expect([...view.view.levelFilter]).toEqual(['error']);
    });

    it('carries a pre-filled search into the box', async () => {
      // A merged scope never goes through `selectLog`, so the bootstrap is the
      // only thing that can put the filter in the box before it is applied.
      const win = await openLogs('?scope=all&filter=fallo');
      await win.settle('listLogs', []);
      await win.settle(
        'getMergedLogs',
        mergedSnapshot([line('fallo 1'), line('ok')]),
      );
      expect(
        (document.getElementById('filter') as HTMLInputElement).value,
      ).toBe('fallo');
      expect(drawn()).toEqual(['fallo 1']);
    });

    it('carries it into a single view too', async () => {
      const win = await openLogs('?id=g1:api&filter=fallo');
      await win.settle('listLogs', []);
      await win.settle('getLogs', snapshot([line('fallo 1'), line('ok')]));
      expect(drawn()).toEqual(['fallo 1']);
    });
  });

  describe('what main pushes at it', () => {
    it('draws a line for the service on screen', async () => {
      const win = await openLogs('?id=api');
      await win.settle('listLogs', []);
      await win.settle('getLogs', snapshot());
      await win.push('onLog', { id: 'api', entry: line('en vivo') });
      expect(drawn()).toEqual(['en vivo']);
    });

    it('ignores an empty push instead of throwing behind the scenes', async () => {
      const win = await openLogs('?id=api');
      await win.settle('listLogs', []);
      await win.settle('getLogs', snapshot());
      await win.push('onLog', null);
      expect(drawn()).toEqual([]);
    });

    it('switches the shared window to another service', async () => {
      const win = await openLogs();
      await win.settle('listLogs', []);
      await win.push('onLogsSelect', { processId: 'g1:web', level: 'warn' });
      expect(win.callCount('getLogs')).toBe(1);
      await win.settle('getLogs', snapshot());
      const view = await import('../renderer/logs/view.js');
      expect(view.view.processId).toBe('g1:web');
      expect([...view.view.levelFilter]).toEqual(['warn']);
    });

    it('switches it to a merged scope', async () => {
      const win = await openLogs();
      await win.settle('listLogs', []);
      await win.push('onLogsSelect', { scope: 'group', groupId: 'g1' });
      expect(win.callCount('getMergedLogs')).toBe(1);
      await win.settle('getMergedLogs', mergedSnapshot());
      expect(document.getElementById('title')?.textContent).toBe(
        'Logs — Back · todos',
      );
    });

    it('falls back to everything when the group scope carries no group', async () => {
      const win = await openLogs();
      await win.settle('listLogs', []);
      await win.push('onLogsSelect', { scope: 'group' });
      await win.settle('getMergedLogs', mergedSnapshot());
      expect(document.getElementById('title')?.textContent).toBe('Telemetría');
    });

    it('ignores a selection that names nothing at all', async () => {
      const win = await openLogs();
      await win.settle('listLogs', []);
      await win.push('onLogsSelect', {});
      expect(win.callCount('getLogs')).toBe(0);
      expect(win.callCount('getMergedLogs')).toBe(0);
    });

    it('a detached window re-filters in place instead of switching', async () => {
      const win = await openLogs('?detached=1&id=api');
      await win.settle('listLogs', []);
      await win.settle('getLogs', snapshot([line('fallo'), line('ok')]));
      await win.push('onLogsSelect', { processId: 'api', filter: 'fallo' });
      expect(win.callCount('getLogs'), 'it must not re-read the log').toBe(1);
      expect(drawn()).toEqual(['fallo']);
    });

    it('a detached window ignores a selection for someone else', async () => {
      const win = await openLogs('?detached=1&id=api');
      await win.settle('listLogs', []);
      await win.settle('getLogs', snapshot([line('fallo'), line('ok')]));
      await win.push('onLogsSelect', { processId: 'otro', filter: 'fallo' });
      expect(drawn()).toEqual(['fallo', 'ok']);
    });

    it('a state change re-decides which held lines the rules swallow', async () => {
      const win = await openLogs('?id=api');
      await win.settle('listLogs', []);
      await win.settle(
        'getLogs',
        snapshot([line('ruido', { originalLevel: 'warn', level: 'warn' })]),
      );
      const view = await import('../renderer/logs/view.js');
      view.view.currentTarget = {
        kind: 'command',
        group: { id: 'g1', name: 'Back' },
        target: {
          id: 'c1',
          name: 'api',
          silencedPatterns: { warn: ['ruido'], error: [] },
        },
      } as unknown as typeof view.view.currentTarget;
      await win.push('onUpdate');
      const buffer = await import('../renderer/logs/buffer.js');
      expect(buffer.buffer.entries[0]?.silenced).toBe(true);
    });
  });

  describe('the panes it wires together', () => {
    it('hands the scope switcher to the rows that sit below it', async () => {
      // A row that opens another scope cannot import the switcher back without
      // closing a cycle, so the entry point installs it once at boot.
      const win = await openLogs('?scope=all');
      await win.settle('listLogs', []);
      await win.settle(
        'getMergedLogs',
        mergedSnapshot([
          { ...line('de api', { ts: 7 }), srcId: 'api' } as LogEntry,
        ]),
      );
      const view = await import('../renderer/logs/view.js');
      view.view.groupSources = new Map([
        ['api', { id: 'api', name: 'Api', groupId: 'g1', groupName: 'Back' }],
      ]);
      const pane = await import('../renderer/logs/pane.js');
      pane.applyFilter(); // redraw now that the sources are known
      const tags = document.querySelectorAll<HTMLElement>('#lines .src');
      expect(Array.from(tags, (tag) => tag.textContent)).toEqual([
        '[Back]',
        '[Api]',
      ]);
      tags[tags.length - 1]?.click();
      expect(win.callCount('getLogs'), 'the service tag must jump to it').toBe(
        1,
      );
      await win.settle('getLogs', snapshot([line('de api', { ts: 7 })]));
      expect(
        (scrolledIntoView[0] as HTMLElement | undefined)?.dataset.line,
      ).toBe('de api');
    });

    it('installs the styled tooltips over the native ones', async () => {
      const win = await openLogs();
      await win.settle('listLogs', []);
      const copy = document.getElementById('copy') as HTMLElement;
      copy.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await wait(300);
      expect(copy.title, 'the native title is moved out of the way').toBe('');
      expect(copy.dataset.tip).toBe('Copiar');
    });
  });
});
