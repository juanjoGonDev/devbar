import type { RemoteDeviceRow } from '../../src/ipc-contract/remote-api.js';
import { wireModal } from '../modal.js';
import { deviceAvatar, deviceNameRow, element } from './remote-device-parts.js';
import type { RemoteElements } from './remote-elements.js';
import { formatDate, lastSeen } from './remote-format.js';

/**
 * «¿Desvincular este dispositivo?»: what «Desvincular» in a device's «⋯»
 * menu opens, so one slip of the mouse cannot cut a phone off. A card tells
 * the device apart from its namesakes — glyph, name and shield, then its
 * client, last IP, link date and whether it is connected — and only the red
 * «Desvincular» unlinks. «Cancelar» (focused first), Escape and a click
 * outside leave everything as it was and give focus back to the device's
 * «⋯». If the device goes away while the dialog is open (it unlinked itself
 * from the phone, or auto-unlink took it), the dialog goes too.
 */

export interface UnlinkDialog {
  open(device: RemoteDeviceRow, now: number): void;
  /** The latest device list: repaints the card, or closes with its device. */
  update(devices: readonly RemoteDeviceRow[], now: number): void;
}

export interface UnlinkDialogDeps {
  /** The unlink itself, once confirmed. */
  unlink(device: RemoteDeviceRow): void;
  /** Focus back on the device's «⋯» button. */
  focusMenuButton(deviceId: string): void;
}

function card(device: RemoteDeviceRow, now: number): HTMLElement[] {
  const line = (text: string): HTMLElement =>
    element('p', 'remote-unlink-line', text);
  const lines = [
    line(device.client),
    ...(device.lastIp ? [line(device.lastIp)] : []),
    line(`Vinculado el ${formatDate(device.createdAt)}`),
    device.connected
      ? line('Conectado')
      : line(`Última conexión ${lastSeen(device.lastSeenAt, now)}`),
  ];
  const main = element('div', 'remote-device-main');
  main.append(deviceNameRow(device), ...lines);
  return [deviceAvatar(device), main];
}

export function createUnlinkDialog(
  els: RemoteElements['unlink'],
  deps: UnlinkDialogDeps,
): UnlinkDialog {
  let showing: RemoteDeviceRow | null = null;
  /** Closing because «Desvincular» was pressed, not cancelled. */
  let confirmed = false;

  const paint = (device: RemoteDeviceRow, now: number): void => {
    showing = device;
    els.device.replaceChildren(...card(device, now));
  };

  // «Cancelar» and a click outside close it; Escape is handled below.
  wireModal(els.dialog);
  els.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    els.dialog.close();
  });
  els.confirm.addEventListener('click', () => {
    const device = showing;
    if (!device) return;
    confirmed = true;
    els.dialog.close();
    deps.unlink(device);
  });
  els.dialog.addEventListener('close', () => {
    const device = showing;
    showing = null;
    if (device && !confirmed) deps.focusMenuButton(device.id);
    confirmed = false;
  });

  return {
    open: (device, now) => {
      confirmed = false;
      paint(device, now);
      if (!els.dialog.open) els.dialog.showModal();
      els.cancel.focus();
    },
    update: (devices, now) => {
      if (showing === null) return;
      const id = showing.id;
      const device = devices.find((each) => each.id === id);
      if (device) paint(device, now);
      else els.dialog.close();
    },
  };
}
