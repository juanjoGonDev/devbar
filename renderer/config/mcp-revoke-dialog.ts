import type { McpClient } from '../../src/ipc-contract/mcp-api.js';
import { wireModal } from '../modal.js';
import { clientAvatar, clientText } from './mcp-client-parts.js';

/**
 * «¿Revocar el acceso de <cliente>?»: what «Revocar acceso» in a client's
 * «⋯» menu opens, so one slip of the mouse cannot cut an assistant off. A
 * card shows the client as its row does (avatar, name, use), and only the red
 * «Revocar acceso» revokes. «Cancelar» (focused first), Escape and a click
 * outside leave everything as it was and give focus back to the client's
 * «⋯». If the client goes away or stops being allowed while the dialog is
 * open, the dialog goes too.
 */

export interface McpRevokeElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  client: HTMLElement;
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
}

export interface RevokeDialog {
  open(client: McpClient, now: number): void;
  /** The latest client list: repaints the card, or closes with its client. */
  update(clients: readonly McpClient[], now: number): void;
}

export interface RevokeDialogDeps {
  /** The revoke itself, once confirmed. */
  revoke(client: McpClient): void;
  /** Focus back on the client's «⋯» button. */
  focusMenuButton(clientId: string): void;
}

export function createRevokeDialog(
  els: McpRevokeElements,
  deps: RevokeDialogDeps,
): RevokeDialog {
  let showing: McpClient | null = null;
  /** Closing because «Revocar acceso» was pressed, not cancelled. */
  let confirmed = false;

  const paint = (client: McpClient, now: number): void => {
    showing = client;
    els.title.textContent = `¿Revocar el acceso de ${client.name}?`;
    els.client.replaceChildren(clientAvatar(client), clientText(client, now));
  };

  // «Cancelar» and a click outside close it; Escape is handled below.
  wireModal(els.dialog);
  els.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    els.dialog.close();
  });
  els.confirm.addEventListener('click', () => {
    const client = showing;
    if (!client) return;
    confirmed = true;
    els.dialog.close();
    deps.revoke(client);
  });
  els.dialog.addEventListener('close', () => {
    const client = showing;
    showing = null;
    if (client && !confirmed) deps.focusMenuButton(client.id);
    confirmed = false;
  });

  return {
    open: (client, now) => {
      confirmed = false;
      paint(client, now);
      if (!els.dialog.open) els.dialog.showModal();
      els.cancel.focus();
    },
    update: (clients, now) => {
      if (showing === null) return;
      const id = showing.id;
      const client = clients.find((each) => each.id === id);
      if (client?.status === 'allowed') paint(client, now);
      else els.dialog.close();
    },
  };
}
