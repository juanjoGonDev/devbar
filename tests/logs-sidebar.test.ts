// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountLogsDom } from './helpers/logs-dom.js';
import { PIPELINE_LOG_GROUP_ID } from '../src/pipeline-labels.js';
import type { LogListGroup, LogListItem } from '../src/ipc-contract.js';

/**
 * `renderer/logs/sidebar.ts` decides when the tree is REBUILT and when it is
 * merely repainted. A full rebuild loses the scroll position, the focus and
 * any click already in progress on a counter button, so it may only happen
 * when the shape actually changed — and the read that feeds it races the
 * pushed refreshes, so the newest answer has to win.
 */
type SidebarModule = typeof import('../renderer/logs/sidebar.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

const SIDEBAR_KEY = 'devbar.logs.sidebar';

function item(overrides: Partial<LogListItem> = {}): LogListItem {
  return {
    id: 'api',
    type: 'command',
    name: 'api',
    icon: null,
    lineCount: 0,
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    startedAt: null,
    lastFinishedAt: null,
    logLimit: 5000,
    ...overrides,
  };
}

function group(overrides: Partial<LogListGroup> = {}): LogListGroup {
  return {
    groupId: 'g1',
    groupName: 'Back',
    groupIcon: '📁',
    items: [item()],
    ...overrides,
  };
}

describe('renderer/logs/sidebar.ts', () => {
  let sidebar: SidebarModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let answers: LogListGroup[][];

  async function open(
    options: { search?: string; collapsed?: boolean } = {},
  ): Promise<void> {
    answers = [];
    mountLogsDom({
      search: options.search,
      api: { listLogs: () => Promise.resolve(answers.shift() ?? []) },
    });
    if (options.collapsed) localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    sidebar = await import('../renderer/logs/sidebar.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await open();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Queue what the next `listLogs` reads will answer, oldest first. */
  function willList(...batches: LogListGroup[][]): void {
    answers = batches;
  }

  function groupNames(): string[] {
    return Array.from(
      elements.sideTreeEl.getElementsByClassName('g-name'),
      (el) => el.textContent ?? '',
    );
  }

  function itemIds(): string[] {
    return Array.from(
      elements.sideTreeEl.getElementsByClassName('side-item'),
      (el) => (el as HTMLElement).dataset.id ?? '',
    );
  }

  describe('refreshSidebar', () => {
    it('draws the tree from what main answered', async () => {
      willList([group({ items: [item({ id: 'a' }), item({ id: 'b' })] })]);
      await sidebar.refreshSidebar();
      expect(groupNames()).toEqual(['Back']);
      expect(itemIds()).toEqual(['a', 'b']);
      expect(view.view.sideData).toHaveLength(1);
    });

    it('says so when nothing is configured', async () => {
      // The empty string is a REAL signature, so a tree that started out
      // believing it was already drawn never drew this row at all.
      await sidebar.refreshSidebar();
      expect(elements.sideTreeEl.textContent).toBe(
        'No hay grupos configurados.',
      );
    });

    it('pins the pipeline bucket above every real group', async () => {
      willList([
        group({ groupId: 'g1', groupName: 'Back' }),
        group({
          groupId: PIPELINE_LOG_GROUP_ID,
          groupName: 'Pipeline',
          items: [],
        }),
      ]);
      await sidebar.refreshSidebar();
      expect(groupNames()).toEqual(['Pipeline', 'Back']);
      expect(
        elements.sideTreeEl.getElementsByClassName('side-all'),
      ).toHaveLength(1);
    });

    it('repaints in place when only the numbers changed', async () => {
      willList(
        [group({ items: [item({ id: 'a', warnCount: 0 })] })],
        [group({ items: [item({ id: 'a', warnCount: 3 })] })],
      );
      await sidebar.refreshSidebar();
      const row = elements.sideTreeEl.getElementsByClassName('side-item')[0];
      await sidebar.refreshSidebar();
      expect(elements.sideTreeEl.getElementsByClassName('side-item')[0]).toBe(
        row,
      );
      expect(row?.getElementsByClassName('s-badges')[0]?.textContent).toBe(
        '⚠ 3',
      );
    });

    it('refreshes the root row on the fast path, which nothing rebuilds', async () => {
      // Its totals track live counts too, and no signature change ever
      // rebuilds it — so the repaint has to touch it explicitly.
      willList(
        [group({ items: [item({ id: 'a', warnCount: 1 })] })],
        [group({ items: [item({ id: 'a', warnCount: 4 })] })],
      );
      await sidebar.refreshSidebar();
      await sidebar.refreshSidebar();
      expect(
        elements.sideTreeEl.getElementsByClassName('a-badges')[0]?.textContent,
      ).toBe('⚠ 4');
    });

    it('rebuilds when a service appeared', async () => {
      willList(
        [group({ items: [item({ id: 'a' })] })],
        [group({ items: [item({ id: 'a' }), item({ id: 'b' })] })],
      );
      await sidebar.refreshSidebar();
      const row = elements.sideTreeEl.getElementsByClassName('side-item')[0];
      await sidebar.refreshSidebar();
      expect(itemIds()).toEqual(['a', 'b']);
      expect(
        elements.sideTreeEl.getElementsByClassName('side-item')[0],
      ).not.toBe(row);
    });

    it('rebuilds when the tree lost a row the repaint needed', async () => {
      willList(
        [group({ items: [item({ id: 'a' })] })],
        [group({ items: [item({ id: 'a' })] })],
      );
      await sidebar.refreshSidebar();
      elements.sideTreeEl.getElementsByClassName('side-item')[0]?.remove();
      await sidebar.refreshSidebar();
      expect(itemIds()).toEqual(['a']);
    });

    it('keeps the answer of the newest read when an older one lands after it', async () => {
      // The debounce in `onUpdate` only collapses refreshes still WAITING to
      // start: it never sees one already in flight.
      const pending: ((value: LogListGroup[]) => void)[] = [];
      mountLogsDom({
        api: {
          listLogs: () =>
            new Promise<LogListGroup[]>((resolve) => pending.push(resolve)),
        },
      });
      sidebar = await import('../renderer/logs/sidebar.js');
      elements = await import('../renderer/logs/elements.js');
      const first = sidebar.refreshSidebar();
      const second = sidebar.refreshSidebar();
      pending[1]?.([group({ groupName: 'nuevo' })]);
      pending[0]?.([group({ groupName: 'viejo' })]);
      await Promise.all([first, second]);
      expect(groupNames()).toEqual(['nuevo']);
    });

    it('survives main answering with nothing at all', async () => {
      mountLogsDom({ api: { listLogs: () => Promise.resolve(null) } });
      sidebar = await import('../renderer/logs/sidebar.js');
      view = await import('../renderer/logs/view.js');
      await sidebar.refreshSidebar();
      expect(view.view.sideData).toEqual([]);
    });

    it('draws no tree in a detached window, which has no sidebar', async () => {
      await open({ search: '?detached=1' });
      willList([group()]);
      await sidebar.refreshSidebar();
      expect(elements.sideTreeEl.textContent).toBe('');
      expect(view.view.sideData).toHaveLength(1);
    });
  });

  describe('the search box', () => {
    beforeEach(async () => {
      willList([
        group({
          items: [
            item({ id: 'a', name: 'api' }),
            item({ id: 'b', name: 'web' }),
          ],
        }),
      ]);
      await sidebar.refreshSidebar();
    });

    function hiddenItems(): string[] {
      return Array.from(
        elements.sideTreeEl.getElementsByClassName('side-item'),
      ).flatMap((row) =>
        row.classList.contains('hidden')
          ? [(row as HTMLElement).dataset.id ?? '']
          : [],
      );
    }

    it('hides the services that do not match', () => {
      elements.sideFilterEl.value = 'ap';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      expect(hiddenItems()).toEqual(['b']);
    });

    it('counts what survived, next to the group name', () => {
      elements.sideFilterEl.value = 'ap';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      expect(
        elements.sideTreeEl.getElementsByClassName('g-count')[0]?.textContent,
      ).toBe('1');
    });

    it('folds away a group with nothing left in it', () => {
      elements.sideFilterEl.value = 'nada';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      const details = elements.sideTreeEl.getElementsByClassName(
        'side-group',
      )[0] as HTMLElement;
      expect(details.classList.contains('hidden')).toBe(true);
    });

    it('opens a folded group that does have a match', () => {
      const details = elements.sideTreeEl.getElementsByClassName(
        'side-group',
      )[0] as HTMLDetailsElement;
      details.open = false;
      elements.sideFilterEl.value = 'web';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      expect(details.open).toBe(true);
    });

    it('brings everything back when the box is emptied', () => {
      elements.sideFilterEl.value = 'ap';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      elements.sideFilterEl.value = '';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      expect(hiddenItems()).toEqual([]);
    });

    it('leaves the pipeline bucket alone — it has nothing to search', async () => {
      willList([
        group({
          groupId: PIPELINE_LOG_GROUP_ID,
          groupName: 'Pipeline',
          items: [],
        }),
      ]);
      await sidebar.refreshSidebar();
      elements.sideFilterEl.value = 'nada';
      elements.sideFilterEl.dispatchEvent(new Event('input'));
      const details = elements.sideTreeEl.getElementsByClassName(
        'side-group',
      )[0] as HTMLElement;
      expect(details.classList.contains('hidden')).toBe(false);
    });
  });

  describe('hiding the sidebar', () => {
    it('starts open, and says what pressing the control would do', () => {
      expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
      expect(elements.toggleSidebarBtn.title).toBe('Ocultar el panel lateral');
      expect(elements.toggleSidebarBtn.getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    it('comes back collapsed when that is how it was left', async () => {
      await open({ collapsed: true });
      expect(document.body.classList.contains('sidebar-collapsed')).toBe(true);
      expect(elements.toggleSidebarBtn.title).toBe('Mostrar el panel lateral');
      expect(elements.toggleSidebarBtn.getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    it('ignores that memory in a detached window, which has no sidebar', async () => {
      await open({ search: '?detached=1', collapsed: true });
      expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
    });

    it('remembers what the control was last used for', () => {
      elements.toggleSidebarBtn.click();
      expect(localStorage.getItem(SIDEBAR_KEY)).toBe('collapsed');
      expect(document.body.classList.contains('sidebar-collapsed')).toBe(true);
      elements.toggleSidebarBtn.click();
      expect(localStorage.getItem(SIDEBAR_KEY)).toBe('open');
      expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
    });
  });

  describe('the one-second ticker', () => {
    it('keeps the live durations on screen moving', async () => {
      vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0));
      const started = Date.now() - 1000;
      willList([
        group({ items: [item({ status: 'running', startedAt: started })] }),
      ]);
      await sidebar.refreshSidebar();
      const clock = (): string =>
        elements.sideTreeEl.getElementsByClassName('b time')[0]?.textContent ??
        '';
      expect(clock()).toBe('⏱ 1s');
      vi.advanceTimersByTime(4000);
      expect(clock()).toBe('⏱ 5s');
    });

    it('does not touch the tree of a detached window', async () => {
      await open({ search: '?detached=1' });
      willList([group()]);
      await sidebar.refreshSidebar();
      vi.advanceTimersByTime(1000);
      expect(elements.sideTreeEl.textContent).toBe('');
    });
  });
});
