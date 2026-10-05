import type { RemoteDeviceRow } from '../../src/ipc-contract/remote-api.js';
import { wireModal } from '../modal.js';
import type { RemoteElements } from './remote-elements.js';
import { qrSvg } from './remote-qr.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «Código de seguridad» of one linked device: the six groups of five digits
 * its phone also shows (Ajustes › Seguridad), and the QR the phone scans
 * with its camera to compare both keys for the user — like verifying a chat
 * in WhatsApp. While it is open, the «Verificado» line follows the status
 * main pushes, so the scan shows up here the moment it happens.
 */

const SCAN_HINT =
  'Escanéalo con la cámara del móvil para verificar que la conexión está cifrada con esta clave.';
const OFF_HINT = 'Activa el control remoto para verificarlo desde el móvil.';

export interface SafetyDialog {
  open(device: RemoteDeviceRow): Promise<void>;
  /** The latest device list: repaints «Verificado» for the open device. */
  update(devices: readonly RemoteDeviceRow[]): void;
}

export function paintVerified(element: HTMLElement, verified: boolean): void {
  element.textContent = verified ? 'Verificado' : 'Sin verificar';
  element.classList.toggle('is-verified', verified);
}

export function createSafetyDialog(
  els: RemoteElements['safety'],
  showToast: ShowToast,
): SafetyDialog {
  let showing: string | null = null;

  wireModal(els.dialog);
  els.dialog.addEventListener('close', () => {
    showing = null;
  });

  return {
    open: async (device) => {
      let result;
      try {
        result = await window.api.getRemoteSecurityCode(device.id);
      } catch (err) {
        showToast(`Error: ${errorMessage(err)}`, 'error');
        return;
      }
      if (!result.ok) {
        showToast(result.error, 'error');
        return;
      }
      showing = device.id;
      els.device.textContent = device.name;
      paintVerified(els.status, result.verified);
      els.code.replaceChildren(
        ...result.code.map((group) => {
          const span = document.createElement('span');
          span.textContent = group;
          return span;
        }),
      );
      els.qr.hidden = result.qr === null;
      els.qr.replaceChildren(...(result.qr ? [qrSvg(result.qr)] : []));
      els.hint.textContent = result.qr ? SCAN_HINT : OFF_HINT;
      if (!els.dialog.open) els.dialog.showModal();
    },
    update: (devices) => {
      if (showing === null) return;
      const device = devices.find((each) => each.id === showing);
      if (!device) {
        els.dialog.close();
        return;
      }
      paintVerified(els.status, device.verifiedAt !== null);
    },
  };
}
