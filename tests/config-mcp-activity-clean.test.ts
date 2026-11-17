// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpAuditSelectionInfo } from '../src/ipc-contract/mcp-api.js';
import { auditEntry, click, el, visible } from './helpers/mcp.js';
import {
  activeLine,
  activityDialog,
  auditPage,
  confirmDialog,
  flush,
  openActivity,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

/**
 * «Limpiar» over «Actividad»: deleting what the filters match, a range of
 * dates or the whole log, and «Borrado automático» — the days entries are
 * kept, saved with «Listo» — driven through the real config window.
 */

const NOW = new Date(2026, 10, 6, 12, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const ENTRIES = [
  auditEntry('a1', { at: NOW - 1000 }),
  auditEntry('a2', { at: NOW - 2 * DAY, undoToken: 'u2', diff: [] }),
];

const info = (total: number, extra: Partial<McpAuditSelectionInfo> = {}) => ({
  total,
  undoable: 0,
  oldest: null,
  ...extra,
});

const pop = (): HTMLElement => el('mcp-activity-clean-pop');
const days = (): HTMLInputElement => el<HTMLInputElement>('mcp-clean-days');
const hint = (): HTMLElement => el('mcp-clean-hint');
const dialogText = (): string => visible(el('mcp-activity-dialog-body'));
const okButton = (): HTMLButtonElement =>
  el<HTMLButtonElement>('mcp-activity-dialog-ok');
const chip = (label: string): HTMLButtonElement => {
  const found = [
    ...el('mcp-activity-dialog-body').querySelectorAll<HTMLButtonElement>(
      '.xf-chip',
    ),
  ].find((each) => each.textContent === label);
  if (!found) throw new Error(`no chip ${label}`);
  return found;
};

/** Opens «Limpiar» and answers the two counts its hint reads. */
async function openClean(
  win: RendererWindow,
  all = info(2, { oldest: NOW - 30 * DAY }),
  older = info(0),
): Promise<void> {
  click(el('mcp-activity-clean'));
  await win.settle('getMcpAuditSelectionInfo', all);
  await win.settle('getMcpAuditSelectionInfo', older);
}

describe('renderer/config/mcp-activity-clean.ts', () => {
  let win: RendererWindow | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  describe('the popover', () => {
    it('opens under «Limpiar» and closes again, or with Escape', async () => {
      win = await openActivity(ENTRIES);
      const button = el('mcp-activity-clean');
      expect(pop().hidden).toBe(true);
      await openClean(win);
      expect(pop().hidden).toBe(false);
      expect(button.getAttribute('aria-expanded')).toBe('true');

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      expect(pop().hidden).toBe(true);
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on a click anywhere else', async () => {
      win = await openActivity(ENTRIES);
      await openClean(win);
      click(el('mcp-activity-rows'));
      expect(pop().hidden).toBe(true);
    });

    it('offers what the filters match only while something narrows the log', async () => {
      win = await openActivity(auditPage(ENTRIES, { retained: 9 }));
      await openClean(win);
      expect(el<HTMLButtonElement>('mcp-clean-filtered').disabled).toBe(true);
      expect(el('mcp-clean-filtered-n').textContent).toBe('');
      expect(el('mcp-clean-all-n').textContent).toBe('9');
      expect(el<HTMLButtonElement>('mcp-clean-all').disabled).toBe(false);
    });

    it('counts what the filters match once the search narrows it', async () => {
      win = await openActivity(auditPage(ENTRIES, { retained: 9 }));
      const search = el<HTMLInputElement>('mcp-activity-search');
      search.value = 'restart';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(win?.callCount('queryMcpAudit')).toBe(2));
      await win.settle('queryMcpAudit', auditPage(ENTRIES, { retained: 9 }));
      await openClean(win);
      expect(el<HTMLButtonElement>('mcp-clean-filtered').disabled).toBe(false);
      expect(el('mcp-clean-filtered-n').textContent).toBe('2');

      click(el('mcp-clean-filtered'));
      expect(pop().hidden).toBe(true);
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'query', query: { search: 'restart' } },
      ]);
    });

    it('turns «Todo el historial…» off when the log is empty', async () => {
      win = await openActivity([]);
      await openClean(win, info(0), info(0));
      expect(el<HTMLButtonElement>('mcp-clean-all').disabled).toBe(true);
      expect(hint().textContent).toBe(
        'Se revisa cada día. Ahora no hay entradas.',
      );
    });
  });

  describe('«Borrado automático»', () => {
    it('starts at the days main keeps and says how much there is', async () => {
      win = await openActivity(auditPage(ENTRIES, { retentionDays: 30 }));
      await openClean(win, info(2, { oldest: new Date(2026, 9, 7).getTime() }));
      expect(days().value).toBe('30');
      expect(hint().textContent).toBe(
        'Se revisa cada día. Ahora hay 2 entradas; la más antigua es del 7 oct.',
      );
      expect(hint().classList.contains('is-warn')).toBe(false);
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'range', to: NOW - 30 * DAY - 1 },
      ]);
    });

    it('warns how many saving fewer days would delete, and saves on «Listo»', async () => {
      win = await openActivity(ENTRIES);
      await openClean(win);
      click(pop().querySelector('.num-stepper-btn[data-step="-1"]'));
      expect(days().value).toBe('29');
      await win.settle('getMcpAuditSelectionInfo', info(2));
      await win.settle('getMcpAuditSelectionInfo', info(1));
      expect(hint().textContent).toBe(
        'Al guardar se eliminarán 1 entrada que ya superan 29 días.',
      );
      expect(hint().classList.contains('is-warn')).toBe(true);

      click(el('mcp-clean-done'));
      expect(pop().hidden).toBe(true);
      expect(win.argsFor('setMcpAuditRetention')).toEqual([[29]]);
      await win.settle('setMcpAuditRetention', { days: 29, deleted: 1 });
      expect(el('toast').textContent).toBe('1 entrada eliminada');
      expect(win.callCount('queryMcpAudit')).toBe(2);
    });

    it('saves nothing when the days did not change, or the popover was dismissed', async () => {
      win = await openActivity(ENTRIES);
      await openClean(win);
      click(el('mcp-clean-done'));
      await openClean(win);
      days().value = '3';
      days().dispatchEvent(new Event('change'));
      click(el('mcp-activity-rows'));
      expect(win.callCount('setMcpAuditRetention')).toBe(0);
    });

    it('stops the stepper at 1 and 365', async () => {
      win = await openActivity(auditPage(ENTRIES, { retentionDays: 365 }));
      await openClean(win);
      const plus = pop().querySelector<HTMLButtonElement>(
        '.num-stepper-btn[data-step="1"]',
      );
      expect(plus?.disabled).toBe(true);
      days().value = '0';
      days().dispatchEvent(new Event('change'));
      expect(days().value).toBe('1');
    });

    it('follows the days kept in the summary and the note under the log', async () => {
      win = await openActivity(auditPage(ENTRIES, { retentionDays: 7 }));
      expect(activeLine()).toBe('2 llamadas · 7 días');
      expect(el('mcp-activity-keep').textContent).toBe(
        'Se guardan los últimos 7 días. Los logs que lee un asistente no se copian aquí.',
      );
    });

    it('reads the log again when main says entries went', async () => {
      win = await openActivity(ENTRIES);
      await win.push('onMcpAuditRefresh');
      expect(win.callCount('queryMcpAudit')).toBe(2);
    });
  });

  describe('«Eliminar por fechas»', () => {
    async function openRange(w: RendererWindow): Promise<void> {
      await openClean(w);
      click(el('mcp-clean-range'));
      await flush();
    }

    it('starts on «Más de 7 días» and counts it, «Eliminar» off meanwhile', async () => {
      win = await openActivity(ENTRIES);
      await openRange(win);
      expect(activityDialog().open).toBe(true);
      expect(el('mcp-activity-dialog-title').textContent).toBe(
        'Eliminar por fechas',
      );
      expect(chip('Más de 7 días').getAttribute('aria-pressed')).toBe('true');
      expect(okButton().disabled).toBe(true);
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'range', to: NOW - 7 * DAY },
      ]);
      await win.settle('getMcpAuditSelectionInfo', info(3));
      expect(dialogText()).toContain('Se eliminarán 3 entradas.');
      expect(okButton().textContent).toBe('Eliminar 3');
      expect(okButton().disabled).toBe(false);
    });

    it('counts each preset, and keeps «Eliminar» off at none', async () => {
      win = await openActivity(ENTRIES);
      await openRange(win);
      await win.settle('getMcpAuditSelectionInfo', info(3));
      click(chip('Hoy'));
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'range', from: new Date(2026, 10, 6).getTime() },
      ]);
      await win.settle('getMcpAuditSelectionInfo', info(0));
      expect(okButton().disabled).toBe(true);
      expect(okButton().textContent).toBe('Eliminar');
      click(chip('Más de 1 día'));
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'range', to: NOW - DAY },
      ]);
    });

    it('brings up the range picker for «Rango…»', async () => {
      win = await openActivity(ENTRIES);
      await openRange(win);
      await win.settle('getMcpAuditSelectionInfo', info(3));
      click(chip('Rango…'));
      expect(
        el('mcp-activity-dialog-body').querySelector('.rp'),
      ).not.toBeNull();
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        {
          kind: 'range',
          from: new Date(2026, 9, 30).getTime(),
          to: NOW + 60_000 - 1,
        },
      ]);
    });

    it('deletes the window on «Eliminar N»', async () => {
      win = await openActivity(ENTRIES);
      await openRange(win);
      await win.settle('getMcpAuditSelectionInfo', info(2));
      await confirmDialog();
      expect(win.argsFor('deleteMcpAudit')).toEqual([
        [{ kind: 'range', to: NOW - 7 * DAY }],
      ]);
      await win.settle('deleteMcpAudit', { deleted: 2 });
      expect(el('toast').textContent).toBe('2 entradas eliminadas');
      expect(win.callCount('queryMcpAudit')).toBe(2);
    });

    it('deletes nothing when cancelled', async () => {
      win = await openActivity(ENTRIES);
      await openRange(win);
      click(el('mcp-activity-dialog-cancel'));
      await flush();
      expect(activityDialog().open).toBe(false);
      expect(win.callCount('deleteMcpAudit')).toBe(0);
    });
  });
});
