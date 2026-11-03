// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { group } from './helpers/config-window.js';
import {
  click,
  el,
  mcpClient,
  mcpState,
  openMcp,
  pick,
  visible,
} from './helpers/mcp.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { McpClient } from '../src/ipc-contract/mcp-api.js';

/**
 * «CLIENTES» in the «MCP» section and the permissions sheet each row opens,
 * driven through the real config window:
 * what the user reads for a pending, an allowed and a revoked assistant, and
 * what every decision asks main.
 */

const NOW = new Date(2026, 10, 3, 12, 45).getTime();
const MIN = 60_000;

function rows(): HTMLElement[] {
  return [...el('mcp-clients').querySelectorAll<HTMLElement>('.mcp-client')];
}
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.mcp-client')].find(
    (r) => r.querySelector('.mcp-client-name')?.textContent === name,
  );
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}
function button(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => visible(b) === label,
  );
  if (!found) throw new Error(`no «${label}» button`);
  return found;
}
const sheet = (): HTMLDialogElement =>
  el<HTMLDialogElement>('mcp-client-sheet');
const submit = (): void => {
  el<HTMLFormElement>('mcp-sheet-form').dispatchEvent(
    new Event('submit', { cancelable: true }),
  );
};
const scopeSwitch = (scope: string): HTMLInputElement =>
  el<HTMLInputElement>(`mcp-scope-${scope}`);
const policy = (scope: string): HTMLSelectElement =>
  el<HTMLSelectElement>(`mcp-confirm-${scope}`);
const chip = (name: string): HTMLButtonElement => {
  const found = [
    ...el('mcp-sheet-groups').querySelectorAll<HTMLButtonElement>('button'),
  ].find((b) => b.textContent === name);
  if (!found) throw new Error(`no chip ${name}`);
  return found;
};

const PENDING = mcpClient('Cursor', {
  kind: 'cursor',
  status: 'pending',
  createdAt: NOW - MIN,
});
const ALLOWED = mcpClient('Claude Code', {
  lastUsedAt: NOW - 3 * MIN,
  callsToday: 128,
  scopes: { read: true, control: true, workflows: true, config: true },
});

async function openWith(clients: McpClient[]): Promise<RendererWindow> {
  const win = await openMcp(mcpState({ clients }));
  await win.settle('listGroups', [group('Back'), group('Front')]);
  return win;
}

let win: RendererWindow | null = null;

function resetWindow(): void {
  localStorage.clear();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
}
function closeWindow(): void {
  win?.close();
  win = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
}

describe('renderer/config/mcp-clients.ts', () => {
  beforeEach(resetWindow);
  afterEach(closeWindow);

  describe('the list', () => {
    it('says how to get a first client when there is none', async () => {
      win = await openWith([]);
      expect(rows()).toEqual([]);
      expect(el('mcp-clients-empty').hidden).toBe(false);
      expect(visible(el('mcp-clients-empty'))).toBe(
        'Ningún cliente todavía. Copia el comando de arriba en tu asistente.',
      );
      expect(el('mcp-revoked').hidden).toBe(true);
    });

    it('says plainly what the permissions do not separate', async () => {
      win = await openWith([]);
      expect(visible(el('mcp-clients-trust'))).toContain(
        'por el nombre que anuncia',
      );
    });

    it('highlights a client asking to connect', async () => {
      win = await openWith([PENDING]);
      const r = row('Cursor');
      expect(r.classList.contains('is-pending')).toBe(true);
      expect(visible(r.querySelector('.mcp-tag-new'))).toBe('Nuevo');
      expect(visible(r.querySelector('.mcp-client-meta'))).toBe(
        'Quiere conectarse · hace 1 min',
      );
      expect(el('mcp-clients-empty').hidden).toBe(true);
    });

    it('lists an allowed client with its use and its scopes', async () => {
      win = await openWith([ALLOWED]);
      const r = row('Claude Code');
      expect(visible(r.querySelector('.mcp-avatar'))).toBe('C');
      expect(visible(r.querySelector('.mcp-client-meta'))).toBe(
        'Último uso: hace 3 min · 128 llamadas hoy',
      );
      expect(
        [...r.querySelectorAll<HTMLElement>('.mcp-scope-tag')].map((t) => [
          t.dataset.scope,
          visible(t),
        ]),
      ).toEqual([
        ['read', 'Lectura'],
        ['control', 'Control'],
        ['workflows', 'Workflows'],
        ['config', 'Configuración'],
      ]);
    });

    it('names a client that has not been used yet', async () => {
      win = await openWith([
        mcpClient('Claude Desktop', {
          scopes: {
            read: true,
            control: false,
            workflows: false,
            config: false,
          },
        }),
      ]);
      const r = row('Claude Desktop');
      expect(visible(r.querySelector('.mcp-client-meta'))).toBe(
        'Sin usar todavía',
      );
      expect(r.querySelectorAll('.mcp-scope-tag')).toHaveLength(1);
    });

    it('folds the revoked ones away, dimmed', async () => {
      win = await openWith([
        ALLOWED,
        mcpClient('Viejo', { status: 'revoked' }),
      ]);
      expect(rows()).toHaveLength(1);
      expect(el('mcp-revoked').hidden).toBe(false);
      expect(el<HTMLDetailsElement>('mcp-revoked').open).toBe(false);
      expect(visible(el('mcp-revoked-summary'))).toBe('Revocados (1)');
      expect(row('Viejo').classList.contains('is-revoked')).toBe(true);
    });

    it('turns a pending client away', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Rechazar'));
      expect(win.argsFor('rejectMcpClient')).toEqual([['client-Cursor']]);
      await win.settle('rejectMcpClient', {
        ok: true,
        state: mcpState({ clients: [{ ...PENDING, status: 'revoked' }] }),
      });
      expect(rows()).toEqual([]);
      expect(visible(el('mcp-revoked-summary'))).toBe('Revocados (1)');
    });

    it('says why main refused a rejection', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Rechazar'));
      await win.settle('rejectMcpClient', { ok: false, error: 'No existe.' });
      expect(el('toast').textContent).toBe('No existe.');
    });

    it('repaints the rows from a pushed state', async () => {
      win = await openWith([]);
      await win.push('onMcpUpdate', mcpState({ clients: [PENDING] }));
      expect(rows()).toHaveLength(1);
    });
  });
});

describe('renderer/config/mcp-client-sheet.ts', () => {
  beforeEach(resetWindow);
  afterEach(closeWindow);

  describe('letting a pending client in', () => {
    it('opens the sheet on the defaults, worded as a permission', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Permitir…'));
      expect(sheet().open).toBe(true);
      expect(el('mcp-sheet-title').textContent).toBe('Cursor');
      expect(visible(el('mcp-sheet-submit-label'))).toBe('Permitir');
      expect(el('mcp-sheet-revoke').hidden).toBe(true);
      expect(scopeSwitch('read').checked).toBe(true);
      expect(scopeSwitch('control').checked).toBe(true);
      expect(scopeSwitch('workflows').checked).toBe(true);
      expect(scopeSwitch('config').checked).toBe(false);
      expect(policy('control').value).toBe('never');
      expect(policy('workflows').value).toBe('first');
    });

    it('approves with the scopes picked, then closes', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Permitir…'));
      scopeSwitch('control').checked = false;
      submit();
      expect(win.argsFor('approveMcpClient')).toEqual([
        [
          'client-Cursor',
          { read: true, control: false, workflows: true, config: false },
        ],
      ]);
      await win.settle('approveMcpClient', {
        ok: true,
        state: mcpState({ clients: [{ ...PENDING, status: 'allowed' }] }),
      });
      expect(win.callCount('updateMcpClient')).toBe(0);
      expect(sheet().open).toBe(false);
      expect(row('Cursor').classList.contains('is-pending')).toBe(false);
    });

    it('saves the rest of the sheet once approved', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Permitir…'));
      policy('control').value = 'always';
      el<HTMLInputElement>('mcp-sheet-redact').checked = false;
      submit();
      await win.settle('approveMcpClient', {
        ok: true,
        state: mcpState({ clients: [{ ...PENDING, status: 'allowed' }] }),
      });
      expect(win.argsFor('updateMcpClient')).toEqual([
        [
          'client-Cursor',
          {
            confirm: { control: 'always', workflows: 'first' },
            groups: 'all',
            redactSecrets: false,
          },
        ],
      ]);
      await win.settle('updateMcpClient', { ok: true, state: mcpState() });
      expect(sheet().open).toBe(false);
    });

    it('retries only the rest once approved, when that second save failed', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Permitir…'));
      policy('control').value = 'always';
      submit();
      await win.settle('approveMcpClient', {
        ok: true,
        state: mcpState({ clients: [{ ...PENDING, status: 'allowed' }] }),
      });
      await win.settle('updateMcpClient', { ok: false, error: 'Ocupado.' });
      expect(sheet().open).toBe(true);

      submit();
      await win.settle('updateMcpClient', { ok: true, state: mcpState() });

      expect(win.argsFor('approveMcpClient')).toHaveLength(1);
      expect(win.argsFor('updateMcpClient')[1]?.[1]).toMatchObject({
        scopes: { read: true },
        confirm: { control: 'always' },
      });
      expect(sheet().open).toBe(false);
    });

    it('keeps the sheet open and says why main refused', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Permitir…'));
      submit();
      await win.settle('approveMcpClient', { ok: false, error: 'Revocado.' });
      expect(sheet().open).toBe(true);
      expect(el('toast').textContent).toBe('Revocado.');
    });

    it('lets a revoked client back in from its folded row', async () => {
      win = await openWith([mcpClient('Viejo', { status: 'revoked' })]);
      click(button(row('Viejo'), 'Permitir…'));
      expect(visible(el('mcp-sheet-submit-label'))).toBe('Permitir');
    });
  });

  describe('editing an allowed client', () => {
    it('opens on what the client has now', async () => {
      win = await openWith([
        {
          ...ALLOWED,
          confirm: { control: 'first', workflows: 'always', config: 'always' },
          groups: ['group-Front'],
          redactSecrets: false,
        },
      ]);
      click(button(row('Claude Code'), 'Permisos'));
      expect(visible(el('mcp-sheet-submit-label'))).toBe('Guardar');
      expect(el('mcp-sheet-revoke').hidden).toBe(false);
      expect(scopeSwitch('config').checked).toBe(true);
      expect(policy('control').value).toBe('first');
      expect(policy('workflows').value).toBe('always');
      expect(el<HTMLInputElement>('mcp-sheet-groups-some').checked).toBe(true);
      expect(el('mcp-sheet-groups').hidden).toBe(false);
      expect(chip('Front').getAttribute('aria-pressed')).toBe('true');
      expect(chip('Back').getAttribute('aria-pressed')).toBe('false');
      expect(el<HTMLInputElement>('mcp-sheet-redact').checked).toBe(false);
      expect(visible(el('mcp-sheet-connection'))).toBe(
        'Local (stdio) · vinculado el 3 nov · último uso hace 3 min',
      );
    });

    it('fixes how reads and configuration changes are confirmed', async () => {
      win = await openWith([ALLOWED]);
      click(button(row('Claude Code'), 'Permisos'));
      expect(policy('read').disabled).toBe(true);
      expect(visible(policy('read').selectedOptions[0] ?? null)).toBe(
        'Sin preguntar',
      );
      expect(policy('config').disabled).toBe(true);
      expect(visible(policy('config').selectedOptions[0] ?? null)).toBe(
        'Preguntar siempre con diff',
      );
      expect(
        [...policy('control').options].map((o) => [o.value, o.text]),
      ).toEqual([
        ['never', 'Sin preguntar'],
        ['first', 'Preguntar la primera vez'],
        ['always', 'Preguntar siempre'],
      ]);
      expect(
        visible(el('mcp-sheet-scopes').querySelector('.mcp-scope-warning')),
      ).toBe('Puede cambiar qué se ejecuta en tu equipo.');
    });

    it('saves every field of the sheet', async () => {
      win = await openWith([ALLOWED]);
      click(button(row('Claude Code'), 'Permisos'));
      scopeSwitch('config').checked = false;
      policy('workflows').value = 'never';
      pick(el<HTMLInputElement>('mcp-sheet-groups-some'));
      click(chip('Back'));
      submit();
      expect(win.argsFor('updateMcpClient')).toEqual([
        [
          'client-Claude Code',
          {
            scopes: {
              read: true,
              control: true,
              workflows: true,
              config: false,
            },
            confirm: { control: 'never', workflows: 'never' },
            groups: ['group-Back'],
            redactSecrets: true,
          },
        ],
      ]);
      await win.settle('updateMcpClient', { ok: true, state: mcpState() });
      expect(sheet().open).toBe(false);
    });

    it('hides the group chips while it sees every group', async () => {
      win = await openWith([ALLOWED]);
      click(button(row('Claude Code'), 'Permisos'));
      expect(el('mcp-sheet-groups').hidden).toBe(true);
      pick(el<HTMLInputElement>('mcp-sheet-groups-some'));
      expect(el('mcp-sheet-groups').hidden).toBe(false);
      pick(el<HTMLInputElement>('mcp-sheet-groups-all'));
      expect(el('mcp-sheet-groups').hidden).toBe(true);
    });

    it('revokes access after asking', async () => {
      win = await openWith([ALLOWED]);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(button(row('Claude Code'), 'Permisos'));
      click(el('mcp-sheet-revoke'));
      expect(ask).toHaveBeenCalledOnce();
      expect(win.argsFor('revokeMcpClient')).toEqual([['client-Claude Code']]);
      await win.settle('revokeMcpClient', {
        ok: true,
        state: mcpState({ clients: [{ ...ALLOWED, status: 'revoked' }] }),
      });
      expect(sheet().open).toBe(false);
      expect(visible(el('mcp-revoked-summary'))).toBe('Revocados (1)');
    });

    it('keeps access when the user backs out of revoking', async () => {
      win = await openWith([ALLOWED]);
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      click(button(row('Claude Code'), 'Permisos'));
      click(el('mcp-sheet-revoke'));
      expect(win.callCount('revokeMcpClient')).toBe(0);
      expect(sheet().open).toBe(true);
    });

    it('asks before throwing edits away on close', async () => {
      win = await openWith([ALLOWED]);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
      click(button(row('Claude Code'), 'Permisos'));
      click(button(sheet(), 'Cancelar'));
      expect(ask).not.toHaveBeenCalled();
      expect(sheet().open).toBe(false);
      click(button(row('Claude Code'), 'Permisos'));
      scopeSwitch('read').checked = false;
      click(button(sheet(), 'Cancelar'));
      expect(ask).toHaveBeenCalledOnce();
      expect(sheet().open).toBe(true);
    });
  });
});
