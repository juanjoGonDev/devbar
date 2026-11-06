// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { iconText } from './helpers/icon-text.js';
import { auditEntry, click, el, visible } from './helpers/mcp.js';
import {
  auditPage,
  cell,
  checkbox,
  checks,
  funnel,
  lastQuery,
  menu,
  menuButton,
  openActivity,
  openMenu,
  summaryDetails,
  toggle,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  McpAuditFacets,
  McpAuditPage,
} from '../src/ipc-contract/mcp-api.js';

/**
 * The column menus of «Actividad» (renderer/config/mcp-activity-head.ts,
 * -menu.ts and -checklist.ts): opening and closing the popover, the
 * checklists with their counts, groups and «(Seleccionar todo)», the result
 * switch, the time chips and range, and «Quitar filtro».
 */

const NOW = new Date(2026, 10, 6, 9, 0).getTime();
const HOUR = 60 * 60 * 1000;

const LIST = [
  auditEntry('a1'),
  auditEntry('a2'),
  auditEntry('a3', { clientId: 'client-Cursor', clientName: 'Cursor' }),
];
const FACETS: McpAuditFacets = {
  clients: [
    { id: 'client-Claude Code', name: 'Claude Code', count: 2 },
    { id: 'client-Cursor', name: 'Cursor', count: 1 },
  ],
  tools: [
    { tool: 'get_status', family: 'read', count: 4 },
    { tool: 'read_logs', family: 'read', count: 2 },
    { tool: 'restart', family: 'control', count: 3 },
    { tool: 'logs', family: null, count: 1 },
  ],
  results: [
    { result: 'ok', count: 9 },
    { result: 'warning', count: 0 },
    { result: 'error', count: 1 },
    { result: 'rejected', count: 0 },
    { result: 'pending', count: 0 },
  ],
};
const PAGE: McpAuditPage = auditPage(LIST, { facets: FACETS });

async function answer(win: RendererWindow): Promise<void> {
  await win.settle('queryMcpAudit', PAGE);
}
const key = (name: string): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });

describe('renderer/config/mcp-activity-menu.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  describe('the popover', () => {
    it('opens under its funnel as a dialog and takes the focus', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      expect(menu().getAttribute('role')).toBe('dialog');
      expect(menu().getAttribute('aria-label')).toBe('Columna Cliente');
      expect(cell('Cliente').contains(menu())).toBe(true);
      expect(funnel('Cliente').getAttribute('aria-expanded')).toBe('true');
      expect(visible(document.activeElement)).toBe('A → Z');
      expect(menu().classList.contains('is-right')).toBe(false);
      click(funnel('Resultado'));
      expect(menu().classList.contains('is-right')).toBe(true);
      expect(funnel('Cliente').getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on Escape and gives the focus back to its funnel', async () => {
      win = await openActivity(PAGE);
      click(funnel('Acción'));
      menu().dispatchEvent(key('Escape'));
      expect(openMenu()).toBeNull();
      expect(document.activeElement).toBe(funnel('Acción'));
    });

    it('closes on «Listo», on its funnel and on a click elsewhere', async () => {
      win = await openActivity(PAGE);
      click(funnel('Hora'));
      click(menuButton('Listo'));
      expect(openMenu()).toBeNull();
      expect(document.activeElement).toBe(funnel('Hora'));
      click(funnel('Hora'));
      click(funnel('Hora'));
      expect(openMenu()).toBeNull();
      click(funnel('Hora'));
      click(el('mcp-activity-rows'));
      expect(openMenu()).toBeNull();
    });

    it('stays open while used, even as its counts are rebuilt', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      checkbox('Cursor').focus();
      toggle(checkbox('Cursor'));
      expect(openMenu()).not.toBeNull();
      expect(
        (document.activeElement as HTMLInputElement | null)?.dataset.focusKey,
      ).toBe('item:client-Cursor');
      await answer(win);
      expect(openMenu()).not.toBeNull();
      expect(checks()[2]).toEqual(['Cursor', '1', 'off']);
    });
  });

  describe('a checklist', () => {
    it('lists each value with its count, all ticked at first', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      expect(checks()).toEqual([
        ['(Seleccionar todo)', '', 'on'],
        ['Claude Code', '2', 'on'],
        ['Cursor', '1', 'on'],
      ]);
      expect(menuButton('Quitar filtro').disabled).toBe(true);
    });

    it('asks for what stays ticked, and says so on the header and in the summary', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      toggle(checkbox('Cursor'));
      expect(lastQuery(win).clientIds).toEqual(['client-Claude Code']);
      expect(checks()[0]).toEqual(['(Seleccionar todo)', '', 'mixed']);
      await answer(win);
      expect(cell('Cliente').classList.contains('is-filtered')).toBe(true);
      expect(iconText(funnel('Cliente'))).toBe('[filter]');
      expect(iconText(funnel('Hora'))).toBe('[list-filter]');
      expect(summaryDetails()).toEqual(['Cliente: Claude Code']);
      toggle(checkbox('Cursor'));
      expect(lastQuery(win).clientIds).toBeUndefined();
    });

    it('unticks everything, which shows nothing', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      toggle(checkbox('(Seleccionar todo)'));
      expect(lastQuery(win).clientIds).toEqual([]);
      await answer(win);
      expect(summaryDetails()).toEqual(['Cliente: ninguno']);
      toggle(checkbox('(Seleccionar todo)'));
      expect(lastQuery(win).clientIds).toBeUndefined();
    });

    it('narrows the list to what its «Buscar» field matches', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      const find = menu().querySelector<HTMLInputElement>('.xf-find input');
      if (!find) throw new Error('no find field');
      find.focus();
      find.value = 'cur';
      find.dispatchEvent(new Event('input'));
      expect(checks().map(([label]) => label)).toEqual([
        '(Seleccionar todo)',
        'Cursor',
      ]);
      expect(document.activeElement).toBe(find);
      toggle(checkbox('Cursor'));
      await answer(win);
      expect(
        menu().querySelector<HTMLInputElement>('.xf-find input')?.value,
      ).toBe('cur');
    });

    it('clears its column with «Quitar filtro»', async () => {
      win = await openActivity(PAGE);
      click(funnel('Cliente'));
      toggle(checkbox('Cursor'));
      await answer(win);
      click(menuButton('Quitar filtro'));
      expect(lastQuery(win).clientIds).toBeUndefined();
      expect(checks()[0]?.[2]).toBe('on');
    });
  });

  describe('«Acción»', () => {
    it('gathers the tools by family, with the family totals', async () => {
      win = await openActivity(PAGE);
      click(funnel('Acción'));
      expect(checks()).toEqual([
        ['(Seleccionar todo)', '', 'on'],
        ['Lectura', '6', 'on'],
        ['get_status', '4', 'on'],
        ['read_logs', '2', 'on'],
        ['Control', '3', 'on'],
        ['restart', '3', 'on'],
        ['Otras', '1', 'on'],
        ['logs', '1', 'on'],
      ]);
    });

    it('ticks and unticks a whole family at once', async () => {
      win = await openActivity(PAGE);
      click(funnel('Acción'));
      toggle(checkbox('Lectura'));
      expect(lastQuery(win).tools).toEqual(['restart', 'logs']);
      await answer(win);
      toggle(checkbox('get_status'));
      expect(checks()[1]).toEqual(['Lectura', '6', 'mixed']);
      await answer(win);
      expect(summaryDetails()).toEqual(['Acción: 3 herramientas']);
      toggle(checkbox('Lectura'));
      expect(lastQuery(win).tools).toBeUndefined();
    });

    it('names the one tool it keeps', async () => {
      win = await openActivity(PAGE);
      click(funnel('Acción'));
      toggle(checkbox('(Seleccionar todo)'));
      await answer(win);
      toggle(checkbox('restart'));
      await answer(win);
      expect(summaryDetails()).toEqual(['Acción: restart']);
    });
  });

  describe('«Resultado»', () => {
    it('lists every result with its colour', async () => {
      win = await openActivity(PAGE);
      click(funnel('Resultado'));
      expect(checks().map(([label, count]) => `${label} ${count}`)).toEqual([
        '(Seleccionar todo) ',
        'Correcto 9',
        'Con avisos 0',
        'Error 1',
        'Rechazado 0',
        'Pendiente 0',
      ]);
      expect(
        [...menu().querySelectorAll<HTMLElement>('.dot')].map(
          (d) => d.dataset.result,
        ),
      ).toEqual(['ok', 'warning', 'error', 'rejected', 'pending']);
    });

    it('keeps only what can be undone with its switch', async () => {
      win = await openActivity(PAGE);
      click(funnel('Resultado'));
      const toggleSwitch =
        menu().querySelector<HTMLInputElement>('[role="switch"]');
      if (!toggleSwitch) throw new Error('no switch');
      toggleSwitch.click();
      expect(lastQuery(win).undoable).toBe(true);
      await answer(win);
      toggle(checkbox('Error'));
      await answer(win);
      expect(summaryDetails()).toEqual([
        'Resultado: Correcto, Con avisos, Rechazado, Pendiente · se puede deshacer',
      ]);
    });
  });

  describe('«Hora»', () => {
    const chips = (): [string, string | null][] =>
      [...menu().querySelectorAll<HTMLElement>('.xf-chip')].map((chip) => [
        chip.textContent ?? '',
        chip.getAttribute('aria-pressed'),
      ]);
    const range = (id: string): HTMLInputElement =>
      el<HTMLInputElement>(`mcp-activity-${id}`);

    it('offers the periods, «Siempre» first', async () => {
      win = await openActivity(PAGE);
      click(funnel('Hora'));
      expect(chips()).toEqual([
        ['Siempre', 'true'],
        ['Última hora', 'false'],
        ['Hoy', 'false'],
        ['7 días', 'false'],
        ['Rango…', 'false'],
      ]);
    });

    it.each<[string, number]>([
      ['Última hora', NOW - HOUR],
      ['Hoy', new Date(2026, 10, 6).getTime()],
      ['7 días', NOW - 7 * 24 * HOUR],
    ])('reads «%s» from now', async (label, from) => {
      vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
      win = await openActivity(PAGE);
      click(funnel('Hora'));
      click(menuButton(label));
      expect(lastQuery(win).from).toBe(from);
      expect(lastQuery(win).to).toBeUndefined();
      await answer(win);
      expect(summaryDetails()).toEqual([`Hora: ${label}`]);
    });

    it('starts a range on the last day, then reads what is typed', async () => {
      vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
      win = await openActivity(PAGE);
      click(funnel('Hora'));
      click(menuButton('Rango…'));
      expect(range('from').value).toBe('2026-11-05T09:00');
      expect(range('to').value).toBe('2026-11-06T09:00');
      expect(lastQuery(win).from).toBe(NOW - 24 * HOUR);
      expect(lastQuery(win).to).toBe(NOW + 60_000 - 1);
      await answer(win);
      expect(summaryDetails()).toEqual(['Hora: 5 nov 09:00 → 6 nov 09:00']);
      range('to').value = '';
      range('to').dispatchEvent(new Event('change'));
      expect(lastQuery(win).to).toBeUndefined();
      await answer(win);
      expect(summaryDetails()).toEqual(['Hora: 5 nov 09:00 → ahora']);
      range('from').value = '2026-11-04T10:30';
      range('from').dispatchEvent(new Event('change'));
      expect(lastQuery(win).from).toBe(new Date(2026, 10, 4, 10, 30).getTime());
    });

    it('takes the period off with «Quitar filtro»', async () => {
      win = await openActivity(PAGE);
      click(funnel('Hora'));
      click(menuButton('7 días'));
      await answer(win);
      click(menuButton('Quitar filtro'));
      expect(lastQuery(win).from).toBeUndefined();
      expect(chips()[0]).toEqual(['Siempre', 'true']);
    });
  });
});
