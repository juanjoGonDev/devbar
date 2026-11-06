import type { McpClient } from '../../src/ipc-contract/mcp-api.js';
import { iconButton } from '../icon.js';
import { clientAvatar, clientText, span } from './mcp-client-parts.js';
import { startRename } from './mcp-client-rename.js';
import { SCOPE_KEYS, SCOPE_LABELS } from './mcp-format.js';
import { createDeviceMenu, type MenuEntry } from './remote-device-menu.js';

/**
 * «CLIENTES»: one row per assistant. A pending one is highlighted and asks
 * for a decision (Rechazar / Permitir…), an allowed one shows its use and its
 * scopes, and the revoked ones fold away dimmed under «Revocados (N)». Every
 * row has a «⋯» menu, the same one a linked device has: «Renombrar» always,
 * plus «Permisos» and «Revocar acceso» for an allowed client. Renaming
 * happens in the row (renderer/config/mcp-client-rename.ts), and while a
 * name is being edited the list is not repainted, so a push from main cannot
 * wipe what the user is typing. The rows only report clicks; the pane
 * decides.
 */

export interface McpClientListElements {
  list: HTMLUListElement;
  empty: HTMLElement;
  revoked: HTMLDetailsElement;
  revokedSummary: HTMLElement;
  revokedList: HTMLUListElement;
}

export interface McpClientListHandlers {
  onReject(client: McpClient): void;
  /** Opens the permissions sheet to let a pending or revoked client in. */
  onAllow(client: McpClient): void;
  onPermissions(client: McpClient): void;
  /** «Revocar acceso»: the pane asks before anything happens. */
  onRevoke(client: McpClient): void;
  /** A new, trimmed name; settles once main answered. */
  onRename(client: McpClient, name: string): Promise<void>;
}

export interface McpClientList {
  render(clients: readonly McpClient[], now: number): void;
  /** Focus on the client's «⋯», as the list holds it now (if still there). */
  focusMenuButton(clientId: string): void;
}

function textButton(
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function scopeTags(client: McpClient): HTMLElement {
  const tags = span('mcp-scope-tags', '');
  for (const key of SCOPE_KEYS) {
    if (!client.scopes[key]) continue;
    const tag = span('mcp-tag mcp-scope-tag', SCOPE_LABELS[key]);
    tag.dataset.scope = key;
    tags.append(tag);
  }
  return tags;
}

export function createMcpClientList(
  els: McpClientListElements,
  handlers: McpClientListHandlers,
): McpClientList {
  const menu = createDeviceMenu();
  let latest: readonly McpClient[] = [];
  let editing = false;

  /** The client's «⋯», as the list holds it now (repaints replace it). */
  const menuButton = (clientId: string): HTMLButtonElement | undefined =>
    [els.list, els.revokedList]
      .flatMap((list) => [
        ...list.querySelectorAll<HTMLButtonElement>('.remote-menu-btn'),
      ])
      .find((each) => each.dataset.clientId === clientId);

  function rename(row: HTMLElement, client: McpClient): void {
    const started = startRename(row, client, {
      save: (name) => handlers.onRename(client, name),
      done: (refocus) => {
        editing = false;
        paint(latest, Date.now());
        if (refocus) menuButton(client.id)?.focus();
      },
    });
    if (started) editing = true;
  }

  function actions(row: HTMLElement, client: McpClient): MenuEntry[] {
    const renameEntry: MenuEntry = {
      label: 'Renombrar',
      icon: 'pencil',
      run: () => rename(row, client),
    };
    if (client.status !== 'allowed') return [renameEntry];
    return [
      {
        label: 'Permisos',
        icon: 'sliders-horizontal',
        run: () => handlers.onPermissions(client),
      },
      renameEntry,
      null,
      {
        label: 'Revocar acceso',
        icon: 'shield-off',
        danger: true,
        run: () => handlers.onRevoke(client),
      },
    ];
  }

  function menuTrigger(row: HTMLElement, client: McpClient): HTMLElement {
    const trigger = iconButton(
      'ellipsis',
      `Acciones de ${client.name}`,
      'remote-menu-btn',
    );
    trigger.dataset.clientId = client.id;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () =>
      menu.toggle(trigger, actions(row, client)),
    );
    return trigger;
  }

  function row(client: McpClient, now: number): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `mcp-client is-${client.status}`;
    li.dataset.id = client.id;
    li.append(clientAvatar(client), clientText(client, now));

    const buttons = span('mcp-client-actions', '');
    if (client.status === 'allowed') {
      li.append(scopeTags(client));
    } else {
      if (client.status === 'pending')
        buttons.append(
          textButton('Rechazar', 'small-btn', () => handlers.onReject(client)),
        );
      buttons.append(
        textButton('Permitir…', 'small-btn primary', () =>
          handlers.onAllow(client),
        ),
      );
    }
    buttons.append(menuTrigger(li, client));
    li.append(buttons);
    return li;
  }

  function paint(clients: readonly McpClient[], now: number): void {
    const focused = menu.close()?.dataset.clientId;
    // Pending first: they are the ones waiting on the user.
    const live = clients
      .filter((client) => client.status !== 'revoked')
      .sort(
        (a, b) =>
          Number(b.status === 'pending') - Number(a.status === 'pending'),
      );
    const revoked = clients.filter((client) => client.status === 'revoked');
    els.list.replaceChildren(...live.map((client) => row(client, now)));
    els.empty.hidden = live.length > 0;
    els.revokedList.replaceChildren(
      ...revoked.map((client) => row(client, now)),
    );
    els.revoked.hidden = revoked.length === 0;
    els.revokedSummary.textContent = `Revocados (${revoked.length})`;
    if (focused !== undefined) menuButton(focused)?.focus();
  }

  return {
    render(clients, now) {
      latest = clients;
      if (!editing) paint(clients, now);
    },
    focusMenuButton: (clientId) => menuButton(clientId)?.focus(),
  };
}
