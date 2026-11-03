import type { McpClient } from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import {
  clientInitial,
  pendingLine,
  SCOPE_KEYS,
  SCOPE_LABELS,
  usageLine,
} from './mcp-format.js';

/**
 * «CLIENTES»: one row per assistant. A pending one is highlighted and asks
 * for a decision (Rechazar / Permitir…), an allowed one shows its use and its
 * scopes with a «Permisos» link, and the revoked ones fold away dimmed under
 * «Revocados (N)». The rows only report clicks; the pane decides.
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
}

export interface McpClientList {
  render(clients: readonly McpClient[], now: number): void;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
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

function avatar(client: McpClient): HTMLSpanElement {
  if (client.status === 'pending') {
    const tile = span('mcp-avatar is-pending', '');
    tile.append(icon('circle-alert'));
    return tile;
  }
  const tile = span('mcp-avatar', clientInitial(client.name));
  tile.dataset.kind = client.kind ?? 'other';
  return tile;
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
  function row(client: McpClient, now: number): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `mcp-client is-${client.status}`;
    li.dataset.id = client.id;

    const text = span('mcp-client-text', '');
    const name = span('mcp-client-name', client.name);
    const title = span('mcp-client-title', '');
    title.append(name);
    if (client.status === 'pending')
      title.append(span('mcp-tag mcp-tag-new', 'Nuevo'));
    const meta = span(
      'mcp-client-meta',
      client.status === 'pending'
        ? pendingLine(client, now)
        : usageLine(client, now),
    );
    text.append(title, meta);
    li.append(avatar(client), text);

    if (client.status === 'allowed') {
      li.append(
        scopeTags(client),
        textButton('Permisos', 'mcp-link-btn', () =>
          handlers.onPermissions(client),
        ),
      );
    } else {
      if (client.status === 'pending')
        li.append(
          textButton('Rechazar', 'small-btn', () => handlers.onReject(client)),
        );
      li.append(
        textButton('Permitir…', 'small-btn primary', () =>
          handlers.onAllow(client),
        ),
      );
    }
    return li;
  }

  return {
    render(clients, now) {
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
    },
  };
}
