import type { McpClient } from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import { clientInitial, pendingLine, usageLine } from './mcp-format.js';

/**
 * The pieces a client is drawn with wherever it shows up: its avatar (a
 * warning glyph while it waits for a decision) and its name over its use.
 * The «Clientes» rows and the «¿Revocar el acceso…?» card share them, so the
 * card reads like the row it came from.
 */

export function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export function clientAvatar(client: McpClient): HTMLSpanElement {
  if (client.status === 'pending') {
    const tile = span('mcp-avatar is-pending', '');
    tile.append(icon('circle-alert'));
    return tile;
  }
  const tile = span('mcp-avatar', clientInitial(client.name));
  tile.dataset.kind = client.kind ?? 'other';
  return tile;
}

/** The name (with «Nuevo» while pending) over the client's use. */
export function clientText(client: McpClient, now: number): HTMLSpanElement {
  const text = span('mcp-client-text', '');
  const title = span('mcp-client-title', '');
  title.append(span('mcp-client-name', client.name));
  if (client.status === 'pending')
    title.append(span('mcp-tag mcp-tag-new', 'Nuevo'));
  const meta = span(
    'mcp-client-meta',
    client.status === 'pending'
      ? pendingLine(client, now)
      : usageLine(client, now),
  );
  text.append(title, meta);
  return text;
}
