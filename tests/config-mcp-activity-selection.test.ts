// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  McpAuditEntry,
  McpAuditSelectionInfo,
} from '../src/ipc-contract/mcp-api.js';
import { auditEntry, click, el, visible } from './helpers/mcp.js';
import {
  activityDialog,
  auditPage,
  confirmDialog,
  lastQuery,
  openActivity,
  row,
  shiftClick,
  sortButton,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

/**
 * Selecting entries of «Actividad»: the box of each row and of the page,
 * Shift ranges, a selection that outlives pages, sorts and searches, the
 * header turned into the selection bar, the «select all that match» banner
 * and Escape — driven through the real config window.
 */

const ENTRIES: McpAuditEntry[] = ['a1', 'a2', 'a3', 'a4'].map((id, i) =>
  auditEntry(id, {
    at: new Date(2026, 10, 3, 12, 40 - i).getTime(),
    ...(id === 'a2' ? { undoToken: 'u2', diff: [] } : {}),
  }),
);

function info(
  total: number,
  extra: Partial<McpAuditSelectionInfo> = {},
): McpAuditSelectionInfo {
  return {
    total,
    undoable: 0,
    oldest: null,
    view: { outside: 0, pages: 1, onPage: [], everyMatch: false },
    ...extra,
  };
}

const box = (id: string): HTMLInputElement => {
  const found = row(id).querySelector<HTMLInputElement>('.sel-box input');
  if (!found) throw new Error(`no box on ${id}`);
  return found;
};
const lead = (): HTMLInputElement =>
  el('mcp-activity-head').querySelector<HTMLInputElement>(
    '.xh-sel input',
  ) as HTMLInputElement;
const bar = (): HTMLElement =>
  el('mcp-activity-head').querySelector<HTMLElement>('.sel-bar') as HTMLElement;
const banner = (): HTMLElement | null =>
  el('mcp-activity-rows').querySelector<HTMLElement>('.sel-banner');
/** The banner's sentence and its link. */
const bannerText = (): string[] => [
  banner()?.firstChild?.textContent ?? '',
  visible(banner()?.querySelector('button') ?? null),
];
/** Settings › MCP is the section on screen. */
const showMcp = (): void =>
  click(document.querySelector('[data-target="mcp"]'));
const barButton = (label: string): HTMLButtonElement | undefined =>
  [...bar().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => visible(b) === label || b.getAttribute('aria-label') === label,
  );
const escape = (): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
};

describe('renderer/config/mcp-activity-picking.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('the boxes', () => {
    it('gives every row a labelled box and the header one for the page', async () => {
      win = await openActivity(ENTRIES);
      expect(box('a1').getAttribute('aria-label')).toBe(
        'Seleccionar restart de las 12:40:00',
      );
      expect(lead().getAttribute('aria-label')).toBe('Seleccionar esta página');
      expect(bar().hidden).toBe(true);
      expect(win.callCount('getMcpAuditSelectionInfo')).toBe(0);
    });

    it('ticks a row: it tints, the header turns into the bar and main is asked', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));

      expect(row('a1').classList.contains('is-selected')).toBe(true);
      expect(el('mcp-activity-head').classList.contains('is-selecting')).toBe(
        true,
      );
      expect(bar().hidden).toBe(false);
      expect(visible(bar().querySelector('.sel-count'))).toBe('1 seleccionada');
      expect(win.argsFor('getMcpAuditSelectionInfo')).toEqual([
        [
          { kind: 'ids', ids: ['a1'] },
          { offset: 0, limit: 50, sort: [{ key: 'time', dir: 'desc' }] },
        ],
      ]);
    });

    it('shows the page box ticked, mixed or clear', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      expect(lead().indeterminate).toBe(true);

      click(lead());
      expect(['a1', 'a2', 'a3', 'a4'].every((id) => box(id).checked)).toBe(
        true,
      );
      expect(lead().checked).toBe(true);

      click(lead());
      expect(['a1', 'a2', 'a3', 'a4'].some((id) => box(id).checked)).toBe(
        false,
      );
      expect(bar().hidden).toBe(true);
    });

    it('ticks every row between the last one and a Shift+click', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      shiftClick(box('a3'));

      expect(['a1', 'a2', 'a3'].every((id) => box(id).checked)).toBe(true);
      expect(box('a4').checked).toBe(false);
      expect(visible(bar().querySelector('.sel-count'))).toBe(
        '3 seleccionadas',
      );
    });

    it('keeps focus on the box it ticked', async () => {
      win = await openActivity(ENTRIES);
      box('a2').focus();
      click(box('a2'));
      await win.settle('getMcpAuditSelectionInfo', info(1));
      expect(document.activeElement).toBe(box('a2'));
    });
  });

  describe('a selection that outlives the view', () => {
    it('keeps its rows across pages and says on how many', async () => {
      win = await openActivity(auditPage(ENTRIES, { total: 120 }));
      click(box('a1'));
      await win.settle('getMcpAuditSelectionInfo', info(1));
      click(el('mcp-activity-pages').querySelector('[aria-label="Página 2"]'));
      const second = auditEntry('b1');
      await win.settle('queryMcpAudit', auditPage([second], { total: 120 }));
      expect(lastQuery(win).offset).toBe(50);
      await win.settle(
        'getMcpAuditSelectionInfo',
        info(1, {
          view: { outside: 0, pages: 1, onPage: [], everyMatch: false },
        }),
      );
      expect(row('b1').querySelector('input')?.checked).toBe(false);
      click(row('b1').querySelector('.sel-box input'));
      await win.settle(
        'getMcpAuditSelectionInfo',
        info(2, {
          view: { outside: 0, pages: 2, onPage: ['b1'], everyMatch: false },
        }),
      );
      expect(visible(bar().querySelector('.sel-count'))).toBe(
        '2 seleccionadas',
      );
      expect(visible(bar().querySelector('.sel-where'))).toBe('· en 2 páginas');
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)?.[0]).toEqual({
        kind: 'ids',
        ids: ['a1', 'b1'],
      });
    });

    it('survives a new sort and says how many the filters hide', async () => {
      win = await openActivity(ENTRIES);
      click(box('a4'));
      await win.settle('getMcpAuditSelectionInfo', info(1));
      click(sortButton('Cliente'));
      await win.settle('queryMcpAudit', auditPage(ENTRIES.slice(0, 2)));
      await win.settle(
        'getMcpAuditSelectionInfo',
        info(1, {
          view: { outside: 1, pages: 0, onPage: [], everyMatch: false },
        }),
      );
      expect(bar().hidden).toBe(false);
      expect(visible(bar().querySelector('.sel-where'))).toBe(
        '· 1 fuera de los filtros',
      );
    });
  });

  describe('a selection under a new search', () => {
    it('keeps its ids and asks main about the searched view', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      await win.settle('getMcpAuditSelectionInfo', info(1));
      const search = el<HTMLInputElement>('mcp-activity-search');
      search.value = 'cursor';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(win?.callCount('queryMcpAudit')).toBe(2));
      await win.settle('queryMcpAudit', auditPage([]));
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'ids', ids: ['a1'] },
        expect.objectContaining({ search: 'cursor' }),
      ]);
      await win.settle(
        'getMcpAuditSelectionInfo',
        info(1, {
          view: { outside: 1, pages: 0, onPage: [], everyMatch: false },
        }),
      );
      expect(visible(bar().querySelector('.sel-count'))).toBe('1 seleccionada');
      expect(lead().disabled).toBe(true);
    });
  });

  describe('the selection bar', () => {
    it('offers «Deshacer seleccionados» only while some can be undone', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      await win.settle('getMcpAuditSelectionInfo', info(1));
      expect(barButton('Deshacer seleccionados (1)')).toBeUndefined();
      expect(barButton('Eliminar')).toBeDefined();

      click(box('a2'));
      await win.settle('getMcpAuditSelectionInfo', info(2, { undoable: 1 }));
      expect(barButton('Deshacer seleccionados (1)')).toBeDefined();
      const x = bar().querySelector('.sel-x');
      expect(x?.getAttribute('title') ?? x?.getAttribute('data-tip')).toBe(
        'Quitar la selección (Esc)',
      );
    });

    it('clears with its ✕ and gives focus back to the page box', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      const x = barButton('Quitar la selección');
      x?.focus();
      click(x ?? null);
      expect(bar().hidden).toBe(true);
      expect(box('a1').checked).toBe(false);
      expect(document.activeElement).toBe(lead());
    });

    it('clears with its own box', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      const own = bar().querySelector<HTMLInputElement>('.sel-box input');
      expect(own?.indeterminate).toBe(true);
      click(own ?? null);
      expect(bar().hidden).toBe(true);
    });

    it('deletes the selection once confirmed, then clears it and reads again', async () => {
      win = await openActivity(ENTRIES);
      click(box('a1'));
      click(barButton('Eliminar') ?? null);
      await win.settle('getMcpAuditSelectionInfo', info(1));
      await win.settle('getMcpAuditSelectionInfo', {
        total: 1,
        undoable: 0,
        oldest: 1,
      });
      expect(activityDialog().open).toBe(true);
      await confirmDialog();
      expect(win.argsFor('deleteMcpAudit')).toEqual([
        [{ kind: 'ids', ids: ['a1'] }],
      ]);
      await win.settle('deleteMcpAudit', { deleted: 1 });
      expect(el('toast').textContent).toBe('1 entrada eliminada');
      expect(bar().hidden).toBe(true);
      expect(win.callCount('queryMcpAudit')).toBe(2);
    });
  });

  describe('the banner', () => {
    it('offers every match once the whole page is ticked, then to clear', async () => {
      win = await openActivity(auditPage(ENTRIES, { total: 1284 }));
      expect(banner()).toBeNull();
      click(lead());
      expect(bannerText()).toEqual([
        'Están seleccionadas las 4 de esta página.',
        'Seleccionar las 1284 que coinciden',
      ]);

      click(banner()?.querySelector('button') ?? null);
      expect(bannerText()).toEqual([
        'Están seleccionadas las 1284 que coinciden.',
        'Quitar la selección',
      ]);
      expect(visible(bar().querySelector('.sel-count'))).toBe(
        '1284 seleccionadas',
      );
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)?.[0]).toEqual({
        kind: 'query',
        query: {},
      });

      click(banner()?.querySelector('button') ?? null);
      expect(banner()).toBeNull();
      expect(bar().hidden).toBe(true);
    });

    it('turns a row unticked from every match into an exception', async () => {
      win = await openActivity(auditPage(ENTRIES, { total: 300 }));
      click(lead());
      click(banner()?.querySelector('button') ?? null);
      click(box('a3'));
      expect(box('a3').checked).toBe(false);
      expect(visible(bar().querySelector('.sel-count'))).toBe(
        '299 seleccionadas',
      );
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)?.[0]).toEqual({
        kind: 'query',
        query: {},
        except: ['a3'],
      });
    });

    it('stays away while every match already fits on the page', async () => {
      win = await openActivity(ENTRIES);
      click(lead());
      expect(banner()).toBeNull();
    });
  });

  describe('Escape', () => {
    it('clears the selection', async () => {
      win = await openActivity(ENTRIES);
      showMcp();
      click(box('a1'));
      escape();
      expect(bar().hidden).toBe(true);
      expect(box('a1').checked).toBe(false);
    });

    it('leaves it alone while a dialog is open', async () => {
      win = await openActivity(ENTRIES);
      showMcp();
      click(box('a1'));
      activityDialog().showModal();
      escape();
      expect(bar().hidden).toBe(false);
    });

    it('closes an open «Limpiar» first and keeps the selection', async () => {
      win = await openActivity(ENTRIES);
      showMcp();
      click(box('a1'));
      click(el('mcp-activity-clean'));
      escape();
      expect(el('mcp-activity-clean-pop').hidden).toBe(true);
      expect(bar().hidden).toBe(false);
    });

    it('leaves it alone while «Servidor» is on show', async () => {
      win = await openActivity(ENTRIES);
      showMcp();
      click(box('a1'));
      click(el('mcp-tab-setup'));
      escape();
      click(el('mcp-tab-activity'));
      expect(bar().hidden).toBe(false);
    });
  });
});
