// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { iconText } from './helpers/icon-text.js';
import {
  auditEntry,
  click,
  el,
  mcpClient,
  mcpState,
  openMcp,
  visible,
} from './helpers/mcp.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { McpAuditEntry } from '../src/ipc-contract/mcp-api.js';

/**
 * «Actividad» in the «MCP» section: the audit log of every tool call, its
 * filters, the diff of a configuration change and «Deshacer», driven through
 * the real config window.
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
const READ = auditEntry('a2', {
  tool: 'search_logs',
  summary: '12 líneas',
});
const REJECTED = auditEntry('a3', {
  clientId: 'client-Cursor',
  clientName: 'Cursor',
  tool: 'delete_group',
  target: 'Browser',
  result: 'rejected',
});

const tab = (id: string): HTMLElement => el(`mcp-tab-${id}`);
function entries(): HTMLElement[] {
  return [
    ...el('mcp-activity-rows').querySelectorAll<HTMLElement>('.mcp-entry'),
  ];
}
function entry(id: string): HTMLElement {
  const found = entries().find((r) => r.dataset.id === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
}
const chip = (filter: string): HTMLElement => {
  const found = el('mcp-activity-filters').querySelector<HTMLElement>(
    `[data-filter="${filter}"]`,
  );
  if (!found) throw new Error(`no ${filter} chip`);
  return found;
};

async function openActivity(list: McpAuditEntry[]): Promise<RendererWindow> {
  const win = await openMcp(
    mcpState({
      clients: [mcpClient('Claude Code'), mcpClient('Cursor')],
    }),
  );
  click(tab('activity'));
  await win.settle('listMcpAudit', list);
  return win;
}

describe('renderer/config/mcp-activity.ts', () => {
  let win: RendererWindow | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('the tabs', () => {
    it('opens on the server view and reads nothing yet', async () => {
      win = await openMcp(mcpState());
      expect(tab('setup').getAttribute('aria-selected')).toBe('true');
      expect(el('mcp-setup').hidden).toBe(false);
      expect(el('mcp-activity').hidden).toBe(true);
      expect(win.callCount('listMcpAudit')).toBe(0);
    });

    it('switches to the log and reads it the first time', async () => {
      win = await openActivity([]);
      expect(tab('activity').getAttribute('aria-selected')).toBe('true');
      expect(tab('setup').getAttribute('aria-selected')).toBe('false');
      expect(el('mcp-setup').hidden).toBe(true);
      expect(el('mcp-activity').hidden).toBe(false);
      expect(win.argsFor('listMcpAudit')).toEqual([
        [{ filter: 'all', limit: 200 }],
      ]);
      expect(el('mcp-activity-empty').hidden).toBe(false);
      click(tab('setup'));
      click(tab('activity'));
      expect(win.callCount('listMcpAudit')).toBe(1);
    });

    it('says how long the log is kept', async () => {
      win = await openActivity([]);
      expect(visible(el('mcp-activity'))).toContain(
        'Se guardan los últimos 30 días.',
      );
    });
  });

  describe('the rows', () => {
    it('shows time, client, tool, target, summary and result', async () => {
      win = await openActivity([READ]);
      const r = entry('a2');
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
      expect(el('mcp-activity-empty').hidden).toBe(true);
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
        entries().map((r) => visible(r.querySelector('.mcp-entry-result'))),
      ).toEqual(['Aplicado', 'Rechazado', 'Con avisos', 'Error', 'Pendiente']);
    });

    it('unfolds the diff of a change', async () => {
      win = await openActivity([CHANGE, READ]);
      expect(entry('a2').querySelector('.mcp-entry-toggle')).toBeNull();
      const toggle =
        entry('a1').querySelector<HTMLButtonElement>('.mcp-entry-toggle');
      const diff = entry('a1').querySelector<HTMLElement>('.mcp-diff');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(diff?.hidden).toBe(true);
      click(toggle ?? null);
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(diff?.hidden).toBe(false);
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

  describe('filtering', () => {
    it('asks main again for the picked filter', async () => {
      win = await openActivity([CHANGE, READ]);
      click(chip('changes'));
      expect(chip('changes').getAttribute('aria-pressed')).toBe('true');
      expect(chip('all').getAttribute('aria-pressed')).toBe('false');
      expect(win.argsFor('listMcpAudit').at(-1)).toEqual([
        { filter: 'changes', limit: 200 },
      ]);
      await win.settle('listMcpAudit', [CHANGE]);
      expect(entries().map((r) => r.dataset.id)).toEqual(['a1']);
    });

    it('lists the clients to filter by and asks for the picked one', async () => {
      win = await openActivity([]);
      const select = el<HTMLSelectElement>('mcp-activity-client');
      expect([...select.options].map((o) => [o.value, o.text])).toEqual([
        ['', 'Todos los clientes'],
        ['client-Claude Code', 'Claude Code'],
        ['client-Cursor', 'Cursor'],
      ]);
      select.value = 'client-Cursor';
      select.dispatchEvent(new Event('change'));
      expect(win.argsFor('listMcpAudit').at(-1)).toEqual([
        { filter: 'all', clientId: 'client-Cursor', limit: 200 },
      ]);
    });

    it('drops an answer that a newer filter overtook', async () => {
      win = await openActivity([]);
      click(chip('changes'));
      click(chip('rejected'));
      await win.settleNewest('listMcpAudit', [REJECTED]);
      await win.settle('listMcpAudit', [CHANGE]);
      expect(entries().map((r) => r.dataset.id)).toEqual(['a3']);
    });
  });

  describe('live entries', () => {
    it('puts a new entry on top', async () => {
      win = await openActivity([READ]);
      await win.push('onMcpAudit', CHANGE);
      expect(entries().map((r) => r.dataset.id)).toEqual(['a1', 'a2']);
    });

    it('skips one the current filter would not show', async () => {
      win = await openActivity([]);
      click(chip('rejected'));
      await win.settle('listMcpAudit', []);
      await win.push('onMcpAudit', CHANGE);
      expect(entries()).toEqual([]);
      await win.push('onMcpAudit', REJECTED);
      expect(entries().map((r) => r.dataset.id)).toEqual(['a3']);
    });

    it('waits for the log to be opened before keeping any', async () => {
      win = await openMcp(mcpState());
      await win.push('onMcpAudit', CHANGE);
      click(tab('activity'));
      await win.settle('listMcpAudit', [READ]);
      expect(entries().map((r) => r.dataset.id)).toEqual(['a2']);
    });
  });

  describe('undoing a change', () => {
    it('offers «Deshacer» only while the change can be undone', async () => {
      win = await openActivity([CHANGE, READ]);
      const undo = entry('a1').querySelector('.mcp-entry-undo');
      expect(iconText(undo)).toBe('[undo-2]Deshacer');
      expect(entry('a2').querySelector('.mcp-entry-undo')).toBeNull();
    });

    it('undoes it, says so and reads the log again', async () => {
      win = await openActivity([CHANGE]);
      click(entry('a1').querySelector('.mcp-entry-undo'));
      expect(win.argsFor('undoMcpChange')).toEqual([['undo-1']]);
      await win.settle('undoMcpChange', { ok: true });
      expect(el('toast').textContent).toBe('Cambio deshecho');
      expect(win.callCount('listMcpAudit')).toBe(2);
    });

    it('says why it could not be undone', async () => {
      win = await openActivity([CHANGE]);
      click(entry('a1').querySelector('.mcp-entry-undo'));
      await win.settle('undoMcpChange', { ok: false, error: 'Ya no existe.' });
      expect(el('toast').textContent).toBe('Ya no existe.');
      expect(win.callCount('listMcpAudit')).toBe(1);
    });
  });
});
