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

/** Picks `label` in the «⋯» menu of the client's row. */
function fromMenu(name: string, label: string): void {
  const r = row(name);
  click(r.querySelector('.remote-menu-btn'));
  const item = [...r.querySelectorAll('[role="menuitem"]')].find(
    (each) => visible(each) === label,
  );
  if (!item) throw new Error(`no «${label}» in the menu of ${name}`);
  click(item);
}
const warning = (): HTMLDialogElement =>
  el<HTMLDialogElement>('mcp-config-warning');
/** Picks a confirmation policy the way the select does: value, then `change`. */
function choose(scope: string, value: string): void {
  const select = policy(scope);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
/** The patch of the latest `updateMcpClient` call. */
const lastPatch = (win: RendererWindow): unknown =>
  win.argsFor('updateMcpClient').at(-1)?.[1];

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
      expect(visible(el('mcp-sheet-title'))).toBe('Cursor');
      expect(visible(el('mcp-sheet-submit-label'))).toBe('Permitir');
      expect(scopeSwitch('read').checked).toBe(true);
      expect(scopeSwitch('control').checked).toBe(true);
      expect(scopeSwitch('workflows').checked).toBe(true);
      expect(scopeSwitch('config').checked).toBe(false);
      expect(policy('control').value).toBe('never');
      expect(policy('workflows').value).toBe('first');
      expect(policy('config').value).toBe('always');
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
            confirm: {
              control: 'always',
              workflows: 'first',
              config: 'always',
            },
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
      fromMenu('Claude Code', 'Permisos');
      expect(visible(el('mcp-sheet-submit-label'))).toBe('Guardar');
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

    it('fixes how reads are confirmed, and offers the rest a choice', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      expect(policy('read').disabled).toBe(true);
      expect(visible(policy('read').selectedOptions[0] ?? null)).toBe(
        'Sin preguntar',
      );
      expect(policy('config').disabled).toBe(false);
      expect(
        [...policy('config').options].map((o) => [o.value, o.text]),
      ).toEqual([
        ['never', 'Sin preguntar'],
        ['first', 'Preguntar la primera vez'],
        ['always', 'Preguntar siempre con diff'],
      ]);
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
      fromMenu('Claude Code', 'Permisos');
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
            confirm: { control: 'never', workflows: 'never', config: 'always' },
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
      fromMenu('Claude Code', 'Permisos');
      expect(el('mcp-sheet-groups').hidden).toBe(true);
      pick(el<HTMLInputElement>('mcp-sheet-groups-some'));
      expect(el('mcp-sheet-groups').hidden).toBe(false);
      pick(el<HTMLInputElement>('mcp-sheet-groups-all'));
      expect(el('mcp-sheet-groups').hidden).toBe(true);
    });

    it('asks before throwing edits away on close', async () => {
      win = await openWith([ALLOWED]);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
      fromMenu('Claude Code', 'Permisos');
      click(button(sheet(), 'Cancelar'));
      expect(ask).not.toHaveBeenCalled();
      expect(sheet().open).toBe(false);
      fromMenu('Claude Code', 'Permisos');
      scopeSwitch('read').checked = false;
      click(button(sheet(), 'Cancelar'));
      expect(ask).toHaveBeenCalledOnce();
      expect(sheet().open).toBe(true);
    });
  });

  describe('choosing how configuration changes are confirmed', () => {
    it('says that every change stays in Activity and can be undone', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      expect(visible(sheet().querySelector('.mcp-sheet-note'))).toBe(
        'Todo cambio de configuración, confirmado o no, queda en Actividad con su diff y se puede deshacer.',
      );
    });

    it('warns before letting a client skip the confirmation', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      choose('config', 'never');
      expect(warning().open).toBe(true);
      expect(visible(el('mcp-config-warning-title'))).toBe(
        '¿Permitir cambios de configuración sin confirmar?',
      );
      expect(visible(el('mcp-config-warning-body'))).toBe(
        'Claude Code podrá cambiar comandos, variables y carpetas —es decir, qué se ejecuta en tu equipo— sin tu aprobación previa. Cada cambio queda en Actividad y se puede deshacer.',
      );
      expect(visible(el('mcp-config-warning-allow'))).toBe('Permitir');
      expect(el('mcp-config-warning-allow').classList.contains('danger')).toBe(
        true,
      );
    });

    it('warns before asking only the first time', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      choose('config', 'first');
      expect(warning().open).toBe(true);
      expect(visible(el('mcp-config-warning-title'))).toBe(
        '¿Confirmar solo la primera vez?',
      );
      expect(visible(el('mcp-config-warning-body'))).toBe(
        'Claude Code solo pedirá tu aprobación la primera vez que cambie cada elemento mientras DevBar siga abierto; después podrá cambiar sus comandos, variables y carpetas sin preguntar. Cada cambio queda en Actividad y se puede deshacer.',
      );
    });

    it('puts the previous choice back when the warning is cancelled', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      choose('config', 'never');
      click(button(warning(), 'Cancelar'));
      expect(warning().open).toBe(false);
      expect(policy('config').value).toBe('always');
      expect(sheet().open).toBe(true);
      submit();
      expect(lastPatch(win)).toMatchObject({ confirm: { config: 'always' } });
    });

    it('puts the previous choice back on Escape, keeping the sheet open', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      choose('config', 'first');
      warning().dispatchEvent(new Event('cancel', { cancelable: true }));
      expect(warning().open).toBe(false);
      expect(policy('config').value).toBe('always');
      expect(sheet().open).toBe(true);
    });

    it('keeps the choice once allowed, and saves it', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      choose('config', 'never');
      click(el('mcp-config-warning-allow'));
      expect(warning().open).toBe(false);
      expect(policy('config').value).toBe('never');
      submit();
      expect(lastPatch(win)).toMatchObject({
        confirm: { control: 'never', workflows: 'first', config: 'never' },
      });
    });

    it('goes back to the last allowed choice, not the one it opened on', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      choose('config', 'never');
      click(el('mcp-config-warning-allow'));
      choose('config', 'first');
      click(button(warning(), 'Cancelar'));
      expect(policy('config').value).toBe('never');
    });

    it('asks nothing to go back to confirming every change', async () => {
      win = await openWith([
        { ...ALLOWED, confirm: { ...ALLOWED.confirm, config: 'first' } },
      ]);
      fromMenu('Claude Code', 'Permisos');
      expect(policy('config').value).toBe('first');
      choose('config', 'always');
      expect(warning().open).toBe(false);
      submit();
      expect(lastPatch(win)).toMatchObject({ confirm: { config: 'always' } });
    });

    it('sends the allowed choice with an approval too', async () => {
      win = await openWith([PENDING]);
      click(button(row('Cursor'), 'Permitir…'));
      choose('config', 'first');
      expect(visible(el('mcp-config-warning-body'))).toContain('Cursor solo');
      click(el('mcp-config-warning-allow'));
      submit();
      await win.settle('approveMcpClient', {
        ok: true,
        state: mcpState({ clients: [{ ...PENDING, status: 'allowed' }] }),
      });
      expect(lastPatch(win)).toMatchObject({ confirm: { config: 'first' } });
    });
  });

  describe('the header', () => {
    it('names the client as a plain title, with nothing to edit', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      expect(visible(el('mcp-sheet-title'))).toBe('Claude Code');
      expect(el('mcp-sheet-title').tagName).toBe('H2');
      expect(sheet().querySelector('.sheet-header input')).toBeNull();
      expect(sheet().getAttribute('aria-label')).toBe(
        'Permisos de Claude Code',
      );
    });

    it('has no way to revoke: that lives in the row menu', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      expect(
        [...sheet().querySelectorAll('button')].map((b) => visible(b)),
      ).not.toContain('Revocar acceso');
    });

    it('never sends a name with the permissions', async () => {
      win = await openWith([ALLOWED]);
      fromMenu('Claude Code', 'Permisos');
      submit();
      expect(lastPatch(win)).not.toHaveProperty('name');
    });
  });
});
