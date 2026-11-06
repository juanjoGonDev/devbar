// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { iconText } from './helpers/icon-text.js';
import {
  auditEntry,
  click,
  el,
  mcpState,
  openMcp,
  visible,
} from './helpers/mcp.js';
import {
  auditPage,
  confirmDialog,
  lastQuery,
  openActivity,
  row,
  rowIds,
  sortButton,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import { LIVE_DELAY_MS } from '../renderer/config/mcp-activity.js';

/**
 * «Actividad» in the «MCP» section: the tabs, the rows of the audit log, the
 * diff of a configuration change and «Deshacer», the empty states and the
 * calls that arrive live, driven through the real config window.
 */

const CHANGE = auditEntry('a1', {
  at: new Date(2026, 10, 3, 12, 41, 7).getTime(),
  tool: 'update_command',
  summary: 'comando, entorno',
  diff: [
    { kind: 'del', field: 'comando', text: 'pnpm start:dev' },
    { kind: 'add', field: 'comando', text: 'pnpm start:dev --inspect=9229' },
  ],
  undoToken: 'undo-1',
});
const READ = auditEntry('a2', { tool: 'search_logs', summary: '12 líneas' });
const REJECTED = auditEntry('a3', {
  clientId: 'client-Cursor',
  clientName: 'Cursor',
  tool: 'delete_group',
  target: 'Browser',
  result: 'rejected',
});

const tab = (id: string): HTMLElement => el(`mcp-tab-${id}`);

describe('renderer/config/mcp-activity.ts', () => {
  let win: RendererWindow | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  describe('the tabs', () => {
    it('opens on the server view and reads nothing yet', async () => {
      win = await openMcp(mcpState());
      expect(tab('setup').getAttribute('aria-selected')).toBe('true');
      expect(el('mcp-setup').hidden).toBe(false);
      expect(el('mcp-activity').hidden).toBe(true);
      expect(win.callCount('queryMcpAudit')).toBe(0);
    });

    it('asks main for the first page, newest first, the first time', async () => {
      win = await openActivity([]);
      expect(tab('activity').getAttribute('aria-selected')).toBe('true');
      expect(el('mcp-setup').hidden).toBe(true);
      expect(el('mcp-activity').hidden).toBe(false);
      expect(win.argsFor('queryMcpAudit')).toEqual([
        [{ offset: 0, limit: 50, sort: [{ key: 'time', dir: 'desc' }] }],
      ]);
      click(tab('setup'));
      click(tab('activity'));
      expect(win.callCount('queryMcpAudit')).toBe(1);
    });

    it('says how long the log is kept', async () => {
      win = await openActivity([]);
      expect(visible(el('mcp-activity'))).toContain(
        'Se guardan los últimos 30 días.',
      );
    });

    it('says why it could not read the log', async () => {
      win = await openMcp(mcpState());
      click(tab('activity'));
      await win.fail('queryMcpAudit', new Error('disco lleno'));
      expect(el('toast').textContent).toBe(
        'Error al leer la actividad: disco lleno',
      );
    });
  });

  describe('the rows', () => {
    it('shows time, client, tool, target, summary and result', async () => {
      win = await openActivity([READ]);
      const r = row('a2');
      expect(visible(r.querySelector('.mcp-entry-time'))).toBe('12:40:52');
      expect(visible(r.querySelector('.mcp-entry-client'))).toBe('Claude Code');
      expect(visible(r.querySelector('.mcp-entry-tool'))).toBe('search_logs');
      expect(visible(r.querySelector('.mcp-entry-action'))).toBe(
        'search_logs · Back › Normal · 12 líneas',
      );
      expect(visible(r.querySelector('.mcp-entry-result'))).toBe('Correcto');
      expect(
        r.querySelector('.mcp-entry-result')?.getAttribute('data-result'),
      ).toBe('ok');
    });

    it('names every result', async () => {
      win = await openActivity([
        CHANGE,
        REJECTED,
        auditEntry('w', { result: 'warning' }),
        auditEntry('e', { result: 'error' }),
        auditEntry('p', { result: 'pending' }),
      ]);
      expect(
        rowIds().map((id) =>
          visible(row(id).querySelector('.mcp-entry-result')),
        ),
      ).toEqual(['Aplicado', 'Rechazado', 'Con avisos', 'Error', 'Pendiente']);
    });

    it('unfolds the diff of a change', async () => {
      win = await openActivity([CHANGE, READ]);
      expect(row('a2').querySelector('.mcp-entry-toggle')).toBeNull();
      const toggle =
        row('a1').querySelector<HTMLButtonElement>('.mcp-entry-toggle');
      const diff = row('a1').querySelector<HTMLElement>('.mcp-diff');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(diff?.hidden).toBe(true);
      click(toggle);
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(diff?.hidden).toBe(false);
      expect(row('a1').classList.contains('is-open')).toBe(true);
      expect(
        [...(diff?.querySelectorAll<HTMLElement>('.mcp-diff-line') ?? [])].map(
          (line) => [line.dataset.kind, line.textContent],
        ),
      ).toEqual([
        ['del', '- comando: pnpm start:dev'],
        ['add', '+ comando: pnpm start:dev --inspect=9229'],
      ]);
    });
  });

  describe('day separators', () => {
    const NOW = new Date(2026, 10, 6, 9, 0).getTime();
    const at = (day: number, hour: number): number =>
      new Date(2026, 10, day, hour, 38).getTime();
    const LIST = [
      auditEntry('t1', { at: at(6, 8) }),
      auditEntry('t2', { at: at(6, 7) }),
      auditEntry('y1', { at: at(5, 23) }),
      auditEntry('o1', { at: at(3, 12) }),
    ];
    const days = (): string[] =>
      [...el('mcp-activity-rows').querySelectorAll('.act-day')].map((d) =>
        visible(d),
      );

    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    });

    it('opens a day while the time leads the sort', async () => {
      win = await openActivity(LIST);
      expect(days()).toEqual([
        'Hoy · viernes, 6 de noviembre',
        'Ayer · jueves, 5 de noviembre',
        'Martes, 3 de noviembre',
      ]);
      expect(el('mcp-activity-log').classList.contains('is-flat')).toBe(false);
    });

    it('runs flat, each time with its date, under another sort', async () => {
      win = await openActivity(LIST);
      click(sortButton('Cliente'));
      await win.settle('queryMcpAudit', auditPage(LIST));
      expect(days()).toEqual([]);
      expect(el('mcp-activity-log').classList.contains('is-flat')).toBe(true);
      expect(visible(row('t1').querySelector('.mcp-entry-time'))).toBe(
        '6 nov 08:38',
      );
    });
  });

  describe('empty', () => {
    it('says there is nothing yet when the log is empty', async () => {
      win = await openActivity([]);
      expect(visible(el('mcp-activity-rows'))).toBe('Sin actividad todavía.');
      expect(visible(el('mcp-activity-range'))).toBe('0 entradas');
    });

    it('says nothing matches when the filters leave nothing', async () => {
      win = await openActivity(auditPage([], { retained: 12 }));
      const empty = el('mcp-activity-rows').querySelector('.act-empty');
      expect(visible(empty?.querySelector('strong') ?? null)).toBe(
        'Nada coincide con estos filtros',
      );
      expect(visible(empty)).toContain(
        'Cambia la búsqueda o quita algún filtro de columna.',
      );
    });
  });

  describe('live entries', () => {
    it('reads the first page again, once for a burst, in the usual order', async () => {
      win = await openActivity([READ]);
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
        shouldAdvanceTime: true,
      });
      await win.push('onMcpAudit', CHANGE);
      await win.push('onMcpAudit', REJECTED);
      expect(win.callCount('queryMcpAudit')).toBe(1);
      await vi.advanceTimersByTimeAsync(LIVE_DELAY_MS);
      expect(win.callCount('queryMcpAudit')).toBe(2);
      await win.settle('queryMcpAudit', auditPage([CHANGE, READ]));
      expect(rowIds()).toEqual(['a1', 'a2']);
      expect(el('mcp-activity-fresh').hidden).toBe(true);
    });

    it('only offers «Actualizar» away from the first page', async () => {
      win = await openActivity(
        auditPage([READ], { total: 120, retained: 120 }),
      );
      click(
        el('mcp-activity-pages').querySelector(
          '[aria-label="Página siguiente"]',
        ),
      );
      await win.settle('queryMcpAudit', auditPage([CHANGE], { total: 120 }));
      await win.push('onMcpAudit', REJECTED);
      expect(el('mcp-activity-fresh').hidden).toBe(false);
      expect(win.callCount('queryMcpAudit')).toBe(2);
      click(el('mcp-activity-fresh'));
      expect(el('mcp-activity-fresh').hidden).toBe(true);
      expect(lastQuery(win).offset).toBe(50);
    });

    it('only offers «Actualizar» under another sort', async () => {
      win = await openActivity([READ]);
      click(sortButton('Resultado'));
      await win.settle('queryMcpAudit', auditPage([READ]));
      await win.push('onMcpAudit', REJECTED);
      expect(el('mcp-activity-fresh').hidden).toBe(false);
    });

    it('waits for the log to be opened before reading anything', async () => {
      win = await openMcp(mcpState());
      await win.push('onMcpAudit', CHANGE);
      expect(win.callCount('queryMcpAudit')).toBe(0);
      expect(el('mcp-activity-fresh').hidden).toBe(true);
    });
  });

  describe('undoing a change', () => {
    it('offers «Deshacer» only while the change can be undone', async () => {
      win = await openActivity([CHANGE, READ]);
      const undo = row('a1').querySelector('.mcp-entry-undo');
      expect(iconText(undo)).toBe('[undo-2]Deshacer');
      expect(row('a2').querySelector('.mcp-entry-undo')).toBeNull();
    });

    it('undoes it once confirmed, says so and reads the log again', async () => {
      win = await openActivity([CHANGE]);
      click(row('a1').querySelector('.mcp-entry-undo'));
      expect(win.callCount('undoMcpChange')).toBe(0);
      await confirmDialog();
      expect(win.argsFor('undoMcpChange')).toEqual([['undo-1']]);
      await win.settle('undoMcpChange', { ok: true });
      expect(el('toast').textContent).toBe('1 cambio deshecho');
      expect(win.callCount('queryMcpAudit')).toBe(2);
    });

    it('says why it could not be undone', async () => {
      win = await openActivity([CHANGE]);
      const undo =
        row('a1').querySelector<HTMLButtonElement>('.mcp-entry-undo');
      click(undo);
      await confirmDialog();
      expect(undo?.disabled).toBe(true);
      await win.settle('undoMcpChange', { ok: false, error: 'Ya no existe.' });
      expect(el('toast').textContent).toBe('Ya no existe.');
      expect(undo?.disabled).toBe(false);
      expect(win.callCount('queryMcpAudit')).toBe(1);
    });

    it('says what went wrong when the call fails', async () => {
      win = await openActivity([CHANGE]);
      click(row('a1').querySelector('.mcp-entry-undo'));
      await confirmDialog();
      await win.fail('undoMcpChange', new Error('sin conexión'));
      expect(el('toast').textContent).toBe('Error: sin conexión');
    });
  });
});
