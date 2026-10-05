import { byId } from '../dom.js';
import type { PortElements } from './remote-port.js';

/**
 * Every element of the «Control remoto» section and its three dialogs, resolved
 * in one place: config.ts calls this once, and
 * tests/renderer-dom-contract.test.ts checks each assertion against
 * config.html.
 */

export interface RemoteElements {
  enabled: HTMLInputElement;
  endpoint: HTMLElement;
  state: HTMLElement;
  address: HTMLElement;
  error: HTMLElement;
  /** This computer's key could not be read: renewing it is the way out. */
  keyError: HTMLElement;
  /** The collapsed gear section that holds the port field. */
  portSettings: HTMLDetailsElement;
  port: PortElements;
  deviceCount: HTMLElement;
  addDevice: HTMLButtonElement;
  devices: HTMLUListElement;
  devicesEmpty: HTMLElement;
  autoUnlink: HTMLInputElement;
  notifyConnections: HTMLInputElement;
  renewIdentity: HTMLButtonElement;
  safety: {
    dialog: HTMLDialogElement;
    device: HTMLElement;
    status: HTMLElement;
    qr: HTMLElement;
    hint: HTMLElement;
    code: HTMLElement;
  };
  pair: {
    dialog: HTMLDialogElement;
    qr: HTMLElement;
    countdown: HTMLElement;
    progress: HTMLDivElement;
    error: HTMLElement;
  };
  request: {
    dialog: HTMLDialogElement;
    name: HTMLElement;
    meta: HTMLElement;
    /** Where the user types the six digits the phone shows. */
    code: HTMLInputElement;
    codeError: HTMLElement;
    countdown: HTMLElement;
    reject: HTMLButtonElement;
    accept: HTMLButtonElement;
  };
}

export function remoteElements(): RemoteElements {
  return {
    enabled: byId<HTMLInputElement>('remote-enabled', HTMLInputElement),
    endpoint: byId<HTMLElement>('remote-endpoint', HTMLElement),
    state: byId<HTMLElement>('remote-state', HTMLElement),
    address: byId<HTMLElement>('remote-address', HTMLElement),
    error: byId<HTMLElement>('remote-error', HTMLElement),
    keyError: byId<HTMLElement>('remote-key-error', HTMLElement),
    portSettings: byId<HTMLDetailsElement>(
      'remote-port-settings',
      HTMLDetailsElement,
    ),
    port: {
      input: byId<HTMLInputElement>('remote-port', HTMLInputElement),
      apply: byId<HTMLButtonElement>('remote-port-apply', HTMLButtonElement),
      error: byId<HTMLElement>('remote-port-error', HTMLElement),
    },
    deviceCount: byId<HTMLElement>('remote-device-count', HTMLElement),
    addDevice: byId<HTMLButtonElement>('remote-add-device', HTMLButtonElement),
    devices: byId<HTMLUListElement>('remote-devices', HTMLUListElement),
    devicesEmpty: byId<HTMLElement>('remote-devices-empty', HTMLElement),
    autoUnlink: byId<HTMLInputElement>('remote-auto-unlink', HTMLInputElement),
    notifyConnections: byId<HTMLInputElement>(
      'remote-notify-connections',
      HTMLInputElement,
    ),
    renewIdentity: byId<HTMLButtonElement>(
      'remote-renew-identity',
      HTMLButtonElement,
    ),
    safety: {
      dialog: byId<HTMLDialogElement>(
        'remote-safety-dialog',
        HTMLDialogElement,
      ),
      device: byId<HTMLElement>('remote-safety-device', HTMLElement),
      status: byId<HTMLElement>('remote-safety-status', HTMLElement),
      qr: byId<HTMLElement>('remote-safety-qr', HTMLElement),
      hint: byId<HTMLElement>('remote-safety-hint', HTMLElement),
      code: byId<HTMLElement>('remote-safety-code', HTMLElement),
    },
    pair: {
      dialog: byId<HTMLDialogElement>('remote-pair-dialog', HTMLDialogElement),
      qr: byId<HTMLElement>('remote-qr', HTMLElement),
      countdown: byId<HTMLElement>('remote-pair-countdown', HTMLElement),
      progress: byId<HTMLDivElement>('remote-pair-progress', HTMLDivElement),
      error: byId<HTMLElement>('remote-pair-error', HTMLElement),
    },
    request: {
      dialog: byId<HTMLDialogElement>(
        'remote-request-dialog',
        HTMLDialogElement,
      ),
      name: byId<HTMLElement>('remote-request-name', HTMLElement),
      meta: byId<HTMLElement>('remote-request-meta', HTMLElement),
      code: byId<HTMLInputElement>('remote-request-code', HTMLInputElement),
      codeError: byId<HTMLElement>('remote-request-code-error', HTMLElement),
      countdown: byId<HTMLElement>('remote-request-countdown', HTMLElement),
      reject: byId<HTMLButtonElement>(
        'remote-request-reject',
        HTMLButtonElement,
      ),
      accept: byId<HTMLButtonElement>(
        'remote-request-accept',
        HTMLButtonElement,
      ),
    },
  };
}
