// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { iconText } from './helpers/icon-text.js';
import { auditEntry, click, el } from './helpers/mcp.js';
import { tipOf } from './helpers/tip.js';
import {
  activeLine,
  auditPage,
  cell,
  funnel,
  lastQuery,
  menu,
  menuButton,
  openActivity,
  pills,
  shiftClick,
  sortButton,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { McpAuditSort } from '../src/ipc-contract/mcp-api.js';

/**
 * Sorting «Actividad» (renderer/config/mcp-activity-head.ts and
 * renderer/config/mcp-activity-model.ts): a header click sorts by that column
 * alone, Shift+click adds it as one more key, the column menu offers the same
 * and the «Orden» pills over the table take keys out again.
 */

const LIST = [auditEntry('a1'), auditEntry('a2'), auditEntry('a3')];

const sorts = (win: RendererWindow): McpAuditSort[] | undefined =>
  lastQuery(win).sort;
const ariaSorts = (): (string | null)[] =>
  ['Hora', 'Cliente', 'Acción', 'Resultado'].map((label) =>
    cell(label).getAttribute('aria-sort'),
  );

async function answer(win: RendererWindow): Promise<void> {
  await win.settle('queryMcpAudit', auditPage(LIST));
}

describe('renderer/config/mcp-activity-head.ts (sorting)', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  it('starts newest first, said on the «Hora» header', async () => {
    win = await openActivity(LIST);
    expect(ariaSorts()).toEqual(['descending', 'none', 'none', 'none']);
    expect(iconText(sortButton('Hora'))).toBe('Hora[arrow-down]');
    expect(iconText(sortButton('Cliente'))).toBe('Cliente');
    expect(tipOf(sortButton('Cliente'))).toBe(
      'Ordenar por cliente · Mayús+clic para añadir a la ordenación',
    );
    expect(cell('Hora').getAttribute('role')).toBe('columnheader');
    expect(activeLine()).toBe('3 llamadas en los últimos 30 días');
  });

  it('sorts by one column with a click, and turns it round with another', async () => {
    win = await openActivity(LIST);
    click(sortButton('Cliente'));
    expect(sorts(win)).toEqual([{ key: 'client', dir: 'asc' }]);
    expect(ariaSorts()).toEqual(['none', 'ascending', 'none', 'none']);
    await answer(win);
    click(sortButton('Cliente'));
    expect(sorts(win)).toEqual([{ key: 'client', dir: 'desc' }]);
    expect(iconText(sortButton('Cliente'))).toBe('Cliente[arrow-down]');
  });

  it('puts errors first on the first click of «Resultado»', async () => {
    win = await openActivity(LIST);
    click(sortButton('Resultado'));
    expect(sorts(win)).toEqual([{ key: 'result', dir: 'desc' }]);
  });

  it('adds keys with Shift and numbers them', async () => {
    win = await openActivity(LIST);
    click(sortButton('Cliente'));
    await answer(win);
    shiftClick(sortButton('Resultado'));
    expect(sorts(win)).toEqual([
      { key: 'client', dir: 'asc' },
      { key: 'result', dir: 'desc' },
    ]);
    expect(iconText(sortButton('Cliente'))).toBe('Cliente[arrow-up]1');
    expect(iconText(sortButton('Resultado'))).toBe('Resultado[arrow-down]2');
    expect(ariaSorts()).toEqual(['none', 'ascending', 'none', 'descending']);
    await answer(win);
    shiftClick(sortButton('Resultado'));
    expect(sorts(win)?.[1]).toEqual({ key: 'result', dir: 'asc' });
    await answer(win);
    shiftClick(sortButton('Resultado'));
    expect(sorts(win)).toEqual([{ key: 'client', dir: 'asc' }]);
  });

  it('goes back to the first page on a new sort', async () => {
    win = await openActivity(auditPage(LIST, { total: 300, retained: 300 }));
    click(el('mcp-activity-pages').querySelector('[aria-label="Página 2"]'));
    expect(lastQuery(win).offset).toBe(50);
    await answer(win);
    click(sortButton('Acción'));
    expect(lastQuery(win).offset).toBe(0);
  });

  describe('from the column menu', () => {
    it('offers both directions and ticks the one in use', async () => {
      win = await openActivity(LIST);
      click(funnel('Hora'));
      const items = [...menu().querySelectorAll('.xf-sec')][0];
      expect(iconText(items)).toBe(
        '[arrow-up-narrow-wide]Más antiguo primero[arrow-down-wide-narrow]Más reciente primero[check]',
      );
      click(menuButton('Más antiguo primero'));
      expect(sorts(win)).toEqual([{ key: 'time', dir: 'asc' }]);
    });

    it('names the directions of each column', async () => {
      win = await openActivity(LIST);
      click(funnel('Resultado'));
      expect(menuButton('Errores primero')).toBeTruthy();
      click(menuButton('Correcto primero'));
      expect(sorts(win)).toEqual([{ key: 'result', dir: 'asc' }]);
      await answer(win);
      click(funnel('Cliente'));
      click(menuButton('Z → A'));
      expect(sorts(win)).toEqual([{ key: 'client', dir: 'desc' }]);
    });

    it('adds a column to the sort, and takes it out again', async () => {
      win = await openActivity(LIST);
      click(funnel('Acción'));
      click(menuButton('Añadir a la ordenación'));
      expect(sorts(win)).toEqual([
        { key: 'time', dir: 'desc' },
        { key: 'action', dir: 'asc' },
      ]);
      await answer(win);
      click(menuButton('Quitar de la ordenación (2º)'));
      expect(sorts(win)).toEqual([{ key: 'time', dir: 'desc' }]);
    });
  });

  describe('the «Orden» pills', () => {
    it('show only a sort that is not the usual one', async () => {
      win = await openActivity(LIST);
      expect(pills()).toEqual([]);
      click(sortButton('Cliente'));
      await answer(win);
      shiftClick(sortButton('Hora'));
      await answer(win);
      expect(activeLine()).toBe(
        'Orden1Cliente2Hora3 llamadas en los últimos 30 días',
      );
      expect(
        [...el('mcp-activity-active').querySelectorAll('.act-pill')].map((p) =>
          iconText(p),
        ),
      ).toEqual(['1Cliente[arrow-up][x]', '2Hora[arrow-down][x]']);
    });

    it('take a key out with their ✕, back to newest first at the end', async () => {
      win = await openActivity(LIST);
      click(sortButton('Cliente'));
      await answer(win);
      click(
        el('mcp-activity-active').querySelector(
          '[aria-label="Quitar orden Cliente"]',
        ),
      );
      expect(sorts(win)).toEqual([{ key: 'time', dir: 'desc' }]);
      await answer(win);
      expect(pills()).toEqual([]);
    });
  });
});
