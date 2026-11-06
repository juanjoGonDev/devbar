// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { group } from './helpers/config-window.js';
import {
  click,
  el,
  mcpClient,
  mcpState,
  openMcp,
  visible,
} from './helpers/mcp.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { McpClient } from '../src/ipc-contract/mcp-api.js';

/**
 * The «⋯» menu of each «Clientes» row, driven through the real config
 * window: what it offers a pending, an allowed and a revoked client, renaming
 * a client in its row (renderer/config/mcp-client-rename.ts) and the
 * «¿Revocar el acceso…?» confirmation (renderer/config/mcp-revoke-dialog.ts).
 */

const NOW = new Date(2026, 10, 3, 12, 45).getTime();
const MIN = 60_000;
const NOTE =
  'Perderá todas las herramientas al momento. Podrás volver a permitirlo desde «Revocados».';

const PENDING = mcpClient('Cursor', {
  kind: 'cursor',
  status: 'pending',
  createdAt: NOW - MIN,
});
const ALLOWED = mcpClient('Claude Code', {
  lastUsedAt: NOW - 3 * MIN,
  callsToday: 128,
});
const REVOKED = mcpClient('Viejo', { status: 'revoked' });

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.mcp-client')].find(
    (r) => r.querySelector('.mcp-client-name')?.textContent === name,
  );
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}
/** The client's «⋯», as the list holds it now. */
function trigger(id: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `.mcp-client button[data-client-id="${id}"]`,
  );
  if (!found) throw new Error(`no «⋯» for ${id}`);
  return found;
}
/** The open menu's entries, as read: labels and `---` for a separator. */
function entries(): string[] {
  const menu = document.querySelector('.mcp-client [role="menu"]');
  if (!menu) throw new Error('no open menu');
  return [...menu.children].map((child) =>
    child.getAttribute('role') === 'separator' ? '---' : visible(child),
  );
}
function choose(id: string, label: string): void {
  click(trigger(id));
  const item = [
    ...document.querySelectorAll('.mcp-client [role="menuitem"]'),
  ].find((each) => visible(each) === label);
  if (!item) throw new Error(`no «${label}» for ${id}`);
  click(item);
}
const field = (): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>('.mcp-rename input');
  if (!found) throw new Error('no rename field');
  return found;
};
const key = (target: Element, name: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
};
const dialog = (): HTMLDialogElement =>
  el<HTMLDialogElement>('mcp-revoke-dialog');

async function openWith(clients: McpClient[]): Promise<RendererWindow> {
  const win = await openMcp(mcpState({ clients }));
  await win.settle('listGroups', [group('Back')]);
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
}

describe('renderer/config/mcp-clients.ts', () => {
  beforeEach(resetWindow);
  afterEach(closeWindow);

  describe('the «⋯» menu', () => {
    it('labels each row’s button after its client, as a menu button', async () => {
      win = await openWith([ALLOWED]);
      const button = trigger(ALLOWED.id);
      expect(button.getAttribute('aria-label')).toBe('Acciones de Claude Code');
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    });

    it('offers an allowed client its permissions, a new name and revoking', async () => {
      win = await openWith([ALLOWED]);
      click(trigger(ALLOWED.id));
      expect(entries()).toEqual([
        'Permisos',
        'Renombrar',
        '---',
        'Revocar acceso',
      ]);
      const danger = document.querySelector('.remote-menu-item.is-danger');
      expect(visible(danger)).toBe('Revocar acceso');
      expect(danger?.querySelector('[data-icon="shield-off"]')).not.toBeNull();
    });

    it('replaces the «Permisos» link of an allowed row', async () => {
      win = await openWith([ALLOWED]);
      const labels = [...row('Claude Code').querySelectorAll('button')].map(
        (b) => visible(b),
      );
      expect(labels).not.toContain('Permisos');
      expect(
        row('Claude Code').querySelectorAll('.mcp-scope-tag'),
      ).toHaveLength(3);
    });

    it('offers a pending client only a new name, next to its decision', async () => {
      win = await openWith([PENDING]);
      const labels = [...row('Cursor').querySelectorAll('button')].map((b) =>
        visible(b),
      );
      expect(labels).toEqual(['Rechazar', 'Permitir…', '']);
      click(trigger(PENDING.id));
      expect(entries()).toEqual(['Renombrar']);
    });

    it('offers a revoked client only a new name, next to «Permitir…»', async () => {
      win = await openWith([REVOKED]);
      expect(
        [...row('Viejo').querySelectorAll('button')].map((b) => visible(b)),
      ).toEqual(['Permitir…', '']);
      click(trigger(REVOKED.id));
      expect(entries()).toEqual(['Renombrar']);
    });

    it('opens the permissions sheet from «Permisos»', async () => {
      win = await openWith([ALLOWED]);
      choose(ALLOWED.id, 'Permisos');
      expect(el<HTMLDialogElement>('mcp-client-sheet').open).toBe(true);
      expect(visible(el('mcp-sheet-title'))).toBe('Claude Code');
      expect(document.querySelector('.mcp-client [role="menu"]')).toBeNull();
    });

    it('closes on a repaint, keeping focus on the same client’s «⋯»', async () => {
      win = await openWith([ALLOWED]);
      click(trigger(ALLOWED.id));
      await win.push('onMcpUpdate', mcpState({ clients: [ALLOWED] }));
      expect(document.querySelector('.mcp-client [role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger(ALLOWED.id));
    });
  });
});

describe('renderer/config/mcp-client-rename.ts', () => {
  beforeEach(resetWindow);
  afterEach(closeWindow);

  it('turns the name into a field, with the keys to leave it', async () => {
    win = await openWith([ALLOWED]);
    const r = row('Claude Code');
    choose(ALLOWED.id, 'Renombrar');
    expect(r.classList.contains('is-renaming')).toBe(true);
    expect(field().value).toBe('Claude Code');
    expect(field().maxLength).toBe(80);
    expect(field().getAttribute('aria-label')).toBe('Nombre de la conexión');
    expect(document.activeElement).toBe(field());
    expect(visible(r.querySelector('.mcp-client-meta'))).toBe(
      'Intro para guardar · Esc para cancelar',
    );
    expect(
      [...r.querySelectorAll('.mcp-rename button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Guardar (Intro)', 'Cancelar (Esc)']);
  });

  it('saves the trimmed name on Enter, then repaints the row', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Renombrar');
    field().value = '  Claude del trabajo  ';
    key(field(), 'Enter');
    expect(win.argsFor('updateMcpClient')).toEqual([
      [ALLOWED.id, { name: 'Claude del trabajo' }],
    ]);
    const renamed = { ...ALLOWED, name: 'Claude del trabajo' };
    await win.settle('updateMcpClient', {
      ok: true,
      state: mcpState({ clients: [renamed] }),
    });
    expect(document.querySelector('.mcp-rename')).toBeNull();
    expect(row('Claude del trabajo').classList.contains('is-renaming')).toBe(
      false,
    );
    expect(document.activeElement).toBe(trigger(ALLOWED.id));
  });

  it('saves from its check button and when the field loses focus', async () => {
    win = await openWith([ALLOWED, PENDING]);
    choose(ALLOWED.id, 'Renombrar');
    field().value = 'Uno';
    click(document.querySelector('.mcp-rename .is-save'));
    await win.settle('updateMcpClient', { ok: true, state: mcpState() });
    await win.push('onMcpUpdate', mcpState({ clients: [ALLOWED, PENDING] }));

    choose(PENDING.id, 'Renombrar');
    field().value = 'Dos';
    field().dispatchEvent(new FocusEvent('blur'));
    expect(win.argsFor('updateMcpClient')).toEqual([
      [ALLOWED.id, { name: 'Uno' }],
      [PENDING.id, { name: 'Dos' }],
    ]);
  });

  it('renames a revoked client too', async () => {
    win = await openWith([REVOKED]);
    choose(REVOKED.id, 'Renombrar');
    field().value = 'Antiguo';
    key(field(), 'Enter');
    expect(win.argsFor('updateMcpClient')).toEqual([
      [REVOKED.id, { name: 'Antiguo' }],
    ]);
  });

  it('cancels on Escape, without the key reaching anything else', async () => {
    win = await openWith([ALLOWED]);
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    choose(ALLOWED.id, 'Renombrar');
    field().value = 'Otro';
    const escape = key(field(), 'Escape');
    document.removeEventListener('keydown', outside);
    expect(escape.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    expect(win.callCount('updateMcpClient')).toBe(0);
    expect(document.querySelector('.mcp-rename')).toBeNull();
    expect(visible(row('Claude Code').querySelector('.mcp-client-meta'))).toBe(
      'Último uso: hace 3 min · 128 llamadas hoy',
    );
    expect(document.activeElement).toBe(trigger(ALLOWED.id));
  });

  it('cancels from its x button', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Renombrar');
    field().value = 'Otro';
    click(document.querySelector('.mcp-rename .is-cancel'));
    expect(win.callCount('updateMcpClient')).toBe(0);
    expect(document.querySelector('.mcp-rename')).toBeNull();
  });

  it('sends nothing for a blank or unchanged name', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Renombrar');
    field().value = '   ';
    key(field(), 'Enter');
    choose(ALLOWED.id, 'Renombrar');
    field().value = ' Claude Code ';
    key(field(), 'Enter');
    expect(win.callCount('updateMcpClient')).toBe(0);
    expect(document.querySelector('.mcp-rename')).toBeNull();
  });

  it('keeps what is being typed through a push from main', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Renombrar');
    const typing = field();
    typing.value = 'A medio';
    await win.push(
      'onMcpUpdate',
      mcpState({ clients: [{ ...ALLOWED, callsToday: 129 }] }),
    );
    expect(field()).toBe(typing);
    expect(typing.value).toBe('A medio');
    key(typing, 'Escape');
    expect(visible(row('Claude Code').querySelector('.mcp-client-meta'))).toBe(
      'Último uso: hace 3 min · 129 llamadas hoy',
    );
  });

  it('says why main refused the new name', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Renombrar');
    field().value = 'Otro';
    key(field(), 'Enter');
    await win.settle('updateMcpClient', { ok: false, error: 'No existe.' });
    expect(el('toast').textContent).toBe('No existe.');
    expect(document.querySelector('.mcp-rename')).toBeNull();
  });

  it('says so when the rename could not reach main', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Renombrar');
    field().value = 'Otro';
    key(field(), 'Enter');
    await win.fail('updateMcpClient', new Error('se cayó'));
    expect(el('toast').textContent).toBe('Error: se cayó');
  });
});

describe('renderer/config/mcp-revoke-dialog.ts', () => {
  beforeEach(resetWindow);
  afterEach(closeWindow);

  it('asks first: «Revocar acceso» opens the dialog and revokes nothing', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    expect(dialog().open).toBe(true);
    expect(visible(el('mcp-revoke-title'))).toBe(
      '¿Revocar el acceso de Claude Code?',
    );
    expect(visible(el('mcp-revoke-note'))).toBe(NOTE);
    expect(dialog().querySelector('[data-icon="shield-off"]')).not.toBeNull();
    expect(win.callCount('revokeMcpClient')).toBe(0);
  });

  it('shows the client as its row does, and focuses «Cancelar»', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    const card = el('mcp-revoke-client');
    expect(visible(card.querySelector('.mcp-avatar'))).toBe('C');
    expect(visible(card.querySelector('.mcp-client-name'))).toBe('Claude Code');
    expect(visible(card.querySelector('.mcp-client-meta'))).toBe(
      'Último uso: hace 3 min · 128 llamadas hoy',
    );
    expect(document.activeElement).toBe(el('mcp-revoke-cancel'));
    expect(el('mcp-revoke-confirm').classList.contains('danger')).toBe(true);
    expect(visible(el('mcp-revoke-confirm'))).toBe('Revocar acceso');
  });

  it('revokes only on its red button, then folds the client away', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    click(el('mcp-revoke-confirm'));
    expect(dialog().open).toBe(false);
    expect(win.argsFor('revokeMcpClient')).toEqual([[ALLOWED.id]]);
    await win.settle('revokeMcpClient', {
      ok: true,
      state: mcpState({ clients: [{ ...ALLOWED, status: 'revoked' }] }),
    });
    expect(visible(el('mcp-revoked-summary'))).toBe('Revocados (1)');
  });

  it('says why main refused to revoke', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    click(el('mcp-revoke-confirm'));
    await win.settle('revokeMcpClient', { ok: false, error: 'Ocupado.' });
    expect(el('toast').textContent).toBe('Ocupado.');
  });

  it('does nothing on «Cancelar», and gives focus back to the «⋯»', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    click(el('mcp-revoke-cancel'));
    expect(dialog().open).toBe(false);
    expect(win.callCount('revokeMcpClient')).toBe(0);
    expect(document.activeElement).toBe(trigger(ALLOWED.id));
  });

  it('does nothing on Escape', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    const escape = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(dialog().open).toBe(false);
    expect(win.callCount('revokeMcpClient')).toBe(0);
    expect(document.activeElement).toBe(trigger(ALLOWED.id));
  });

  it('does nothing on a click outside it', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    click(dialog());
    expect(dialog().open).toBe(false);
    expect(win.callCount('revokeMcpClient')).toBe(0);
  });

  it('keeps the card current while the client stays allowed', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    await win.push(
      'onMcpUpdate',
      mcpState({ clients: [{ ...ALLOWED, name: 'Claude' }] }),
    );
    expect(dialog().open).toBe(true);
    expect(visible(el('mcp-revoke-title'))).toBe(
      '¿Revocar el acceso de Claude?',
    );
  });

  it('goes away when the client stops being allowed', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    await win.push(
      'onMcpUpdate',
      mcpState({ clients: [{ ...ALLOWED, status: 'revoked' }] }),
    );
    expect(dialog().open).toBe(false);
    expect(win.callCount('revokeMcpClient')).toBe(0);
  });

  it('goes away with its client', async () => {
    win = await openWith([ALLOWED]);
    choose(ALLOWED.id, 'Revocar acceso');
    await win.push('onMcpUpdate', mcpState({ clients: [] }));
    expect(dialog().open).toBe(false);
  });
});
