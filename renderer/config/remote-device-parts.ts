import type { RemoteDeviceRow } from '../../src/ipc-contract/remote-api.js';
import { icon } from '../icon.js';

/**
 * The pieces a linked device is drawn with wherever it appears: its row in
 * «Dispositivos» (renderer/config/remote-devices.ts) and the card of
 * «¿Desvincular este dispositivo?» (remote-unlink-dialog.ts).
 */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The phone glyph, with a green dot while the device is connected. */
export function deviceAvatar(device: RemoteDeviceRow): HTMLElement {
  const avatar = element('span', 'remote-avatar');
  avatar.append(icon('smartphone'));
  if (device.connected) avatar.append(element('span', 'remote-presence'));
  return avatar;
}

/** The name, then a shield when it is verified: an image to assistive tech. */
export function deviceNameRow(device: RemoteDeviceRow): HTMLElement {
  const nameRow = element('div', 'remote-device-name-row');
  nameRow.append(element('strong', 'remote-device-name', device.name));
  if (device.verifiedAt === null) return nameRow;
  const mark = element('span', 'remote-verified-mark');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', 'Verificado');
  mark.title = 'Verificado';
  mark.append(icon('shield-check'));
  nameRow.append(mark);
  return nameRow;
}
