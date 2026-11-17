// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { auditEntry, click, el, visible } from './helpers/mcp.js';
import {
  activityDialog,
  confirmDialog,
  flush,
  openActivity,
  row,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

/**
 * Every confirmation «Actividad» asks before it deletes entries or undoes
 * changes: what each one says, which button is red or blue, that «Cancelar»
 * takes focus first, that cancelling (button, Escape, a click outside)
 * changes nothing, and the toast after a yes.
 */

const CHANGE = auditEntry('a1', {
  tool: 'update_command',
  target: 'Back › Normal',
  diff: [],
  undoToken: 'u1',
});
const READ = auditEntry('a2', { tool: 'get_status' });

const title = (): string => el('mcp-activity-dialog-title').textContent;
const body = (): string[] =>
  [...el('mcp-activity-dialog-body').querySelectorAll('p')].map((p) =>
    visible(p),
  );
const ok = (): HTMLButtonElement =>
  el<HTMLButtonElement>('mcp-activity-dialog-ok');
const tile = (): HTMLElement => el('mcp-activity-dialog-tile');
const toast = (): HTMLElement => el('toast');

/** «Limpiar» › «Todo el historial…», with the popover's own reads answered. */
async function deleteAll(win: RendererWindow): Promise<void> {
  click(el('mcp-activity-clean'));
  await win.settle('getMcpAuditSelectionInfo', {
    total: 2,
    undoable: 1,
    oldest: 1,
  });
  await win.settle('getMcpAuditSelectionInfo', {
    total: 0,
    undoable: 0,
    oldest: null,
  });
  click(el('mcp-clean-all'));
}

describe('renderer/config/mcp-activity-bulk.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('deleting', () => {
    it('asks with the count and warns about the changes it can no longer undo', async () => {
      win = await openActivity([CHANGE, READ]);
      await deleteAll(win);
      expect(win.argsFor('getMcpAuditSelectionInfo').at(-1)).toEqual([
        { kind: 'all' },
      ]);
      await win.settle('getMcpAuditSelectionInfo', {
        total: 2,
        undoable: 1,
        oldest: 1,
      });

      expect(activityDialog().open).toBe(true);
      expect(title()).toBe('¿Eliminar 2 entradas?');
      expect(body()).toEqual([
        'Se borran del historial para siempre. Las llamadas no se repiten ni se deshacen: solo desaparece su registro.',
        '1 cambio con «Deshacer» ya no se podrá deshacer.',
      ]);
      expect(ok().textContent).toBe('Eliminar');
      expect(ok().className).toBe('danger');
      expect(tile().classList.contains('is-info')).toBe(false);
      expect(document.activeElement).toBe(el('mcp-activity-dialog-cancel'));
    });

    it('leaves the warning out when nothing could be undone', async () => {
      win = await openActivity([READ]);
      await deleteAll(win);
      await win.settle('getMcpAuditSelectionInfo', {
        total: 1,
        undoable: 0,
        oldest: 1,
      });
      expect(title()).toBe('¿Eliminar 1 entrada?');
      expect(body()).toHaveLength(1);
    });

    it('deletes on «Eliminar» and says how many went', async () => {
      win = await openActivity([CHANGE, READ]);
      await deleteAll(win);
      await win.settle('getMcpAuditSelectionInfo', {
        total: 2,
        undoable: 0,
        oldest: 1,
      });
      await confirmDialog();
      expect(win.argsFor('deleteMcpAudit')).toEqual([[{ kind: 'all' }]]);
      await win.settle('deleteMcpAudit', { deleted: 2 });
      expect(toast().textContent).toBe('2 entradas eliminadas');
      expect(win.callCount('queryMcpAudit')).toBe(2);
    });

    it.each([
      ['«Cancelar»', () => click(el('mcp-activity-dialog-cancel'))],
      ['Escape', () => activityDialog().dispatchEvent(new Event('cancel'))],
      ['a click outside', () => click(activityDialog())],
    ])('deletes nothing after %s', async (_label, cancel) => {
      win = await openActivity([CHANGE, READ]);
      await deleteAll(win);
      await win.settle('getMcpAuditSelectionInfo', {
        total: 2,
        undoable: 0,
        oldest: 1,
      });
      cancel();
      await flush();
      expect(activityDialog().open).toBe(false);
      expect(win.callCount('deleteMcpAudit')).toBe(0);
    });

    it('says what went wrong when the delete fails', async () => {
      win = await openActivity([READ]);
      await deleteAll(win);
      await win.settle('getMcpAuditSelectionInfo', {
        total: 1,
        undoable: 0,
        oldest: 1,
      });
      await confirmDialog();
      await win.fail('deleteMcpAudit', new Error('disco lleno'));
      expect(toast().textContent).toBe('Error: disco lleno');
    });
  });

  describe('undoing one change', () => {
    it('asks first, naming the change, in blue', async () => {
      win = await openActivity([CHANGE]);
      click(row('a1').querySelector('.mcp-entry-undo'));
      expect(title()).toBe('¿Deshacer este cambio?');
      expect(body()).toEqual([
        'update_command · Back › Normal',
        'Se restaura lo que había antes de este cambio.',
      ]);
      expect(ok().textContent).toBe('Deshacer');
      expect(ok().className).toBe('primary');
      expect(tile().classList.contains('is-info')).toBe(true);
      expect(document.activeElement).toBe(el('mcp-activity-dialog-cancel'));
    });

    it('undoes nothing when cancelled, and gives the button back', async () => {
      win = await openActivity([CHANGE]);
      const undo =
        row('a1').querySelector<HTMLButtonElement>('.mcp-entry-undo');
      undo?.focus();
      click(undo);
      click(el('mcp-activity-dialog-cancel'));
      await flush();
      expect(win.callCount('undoMcpChange')).toBe(0);
      expect(undo?.disabled).toBe(false);
      expect(document.activeElement).toBe(undo);
    });
  });

  describe('undoing the selection', () => {
    async function undoSelected(w: RendererWindow): Promise<void> {
      click(row('a1').querySelector('.sel-box input'));
      await w.settle('getMcpAuditSelectionInfo', {
        total: 1,
        undoable: 1,
        oldest: 1,
      });
      const button = [
        ...el('mcp-activity-head').querySelectorAll<HTMLButtonElement>(
          '.sel-act',
        ),
      ].find((each) => visible(each) === 'Deshacer seleccionados (1)');
      click(button ?? null);
    }

    it('asks how many, in blue', async () => {
      win = await openActivity([CHANGE, READ]);
      await undoSelected(win);
      expect(title()).toBe('¿Deshacer 1 cambio?');
      expect(body()).toEqual([
        'Se restaura lo que cambió cada uno, del más reciente al más antiguo. El resto de la selección no se toca.',
      ]);
      expect(ok().textContent).toBe('Deshacer 1');
      expect(tile().classList.contains('is-info')).toBe(true);
    });

    it('undoes them, says so and keeps the selection', async () => {
      win = await openActivity([CHANGE, READ]);
      await undoSelected(win);
      await confirmDialog();
      expect(win.argsFor('undoMcpChanges')).toEqual([
        [{ kind: 'ids', ids: ['a1'] }],
      ]);
      await win.settle('undoMcpChanges', { undone: 1, failed: 0 });
      expect(toast().textContent).toBe('1 cambio deshecho');
      expect(win.callCount('queryMcpAudit')).toBe(2);
      expect(el('mcp-activity-head').classList.contains('is-selecting')).toBe(
        true,
      );
    });

    it('says which could not be undone', async () => {
      win = await openActivity([CHANGE, READ]);
      await undoSelected(win);
      await confirmDialog();
      await win.settle('undoMcpChanges', {
        undone: 2,
        failed: 1,
        errors: ['Ya no existe'],
      });
      expect(toast().textContent).toBe(
        '2 cambios deshechos. No se pudo deshacer 1 cambio: Ya no existe',
      );
      expect(toast().className).toContain('error');
    });

    it('undoes nothing when cancelled', async () => {
      win = await openActivity([CHANGE, READ]);
      await undoSelected(win);
      click(el('mcp-activity-dialog-cancel'));
      await flush();
      expect(win.callCount('undoMcpChanges')).toBe(0);
    });
  });
});
