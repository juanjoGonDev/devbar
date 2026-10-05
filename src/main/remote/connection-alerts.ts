import type { RemoteNotice } from '../../ipc-contract/remote-wire.js';
import type { Arrivals } from './arrivals.js';
import type { DeviceStore } from './device-store.js';

/**
 * What the desktop says when a linked device connects:
 *
 *   an arrival   «… se ha conectado desde <ip>.» — its first connection
 *                since DevBar started, or one after ten minutes away
 *                (src/main/remote/arrivals.ts); a banner only while
 *                «Avisar cuando un dispositivo se conecte» is on;
 *   a new IP     «… se ha conectado desde una IP nueva (<ip>). Si no has
 *                sido tú, desvincúlalo.» — a sign-in from an address the
 *                device has not used before (where it paired, then where it
 *                last signed in). Always a banner, whatever that switch and
 *                however recent the last visit: a device key read off the
 *                phone by a page served on this computer's address
 *                (src/main/remote/rc-protocol.ts) would surface exactly so.
 *
 * Either is also logged in «Avisos» for every phone but that one.
 */

const TITLE = 'DevBar — control remoto';
const SEE_DEVICES = { label: 'Ver dispositivos', action: 'open-remote' };

export interface ConnectionAlertsDeps {
  devices: Pick<DeviceStore, 'find' | 'recordIp' | 'settings'>;
  arrivals: Arrivals;
  isConnected(deviceId: string): boolean;
  /** A notice about one device, for every phone but that one. */
  announce(
    notice: Pick<RemoteNotice, 'kind' | 'title' | 'body'>,
    aboutDevice: string,
  ): void;
  /** The desktop banner (src/main/notification-banner.ts). */
  showBanner(
    title: string,
    body: string,
    options: { cta: { label: string; action: string }; record: false },
  ): void;
}

export interface ConnectionAlerts {
  /** A session proved to be this device, from `ip`; true when that changed it. */
  signedIn(deviceId: string, ip: string): boolean;
  /** The device opened its first stream or closed its last one. */
  presence(deviceId: string): void;
}

export function createConnectionAlerts(
  deps: ConnectionAlertsDeps,
): ConnectionAlerts {
  const { devices, arrivals } = deps;

  const tell = (
    deviceId: string,
    kind: RemoteNotice['kind'],
    body: string,
    banner: boolean,
  ): void => {
    deps.announce({ kind, title: 'Control remoto', body }, deviceId);
    if (banner)
      deps.showBanner(TITLE, body, { cta: SEE_DEVICES, record: false });
  };

  const arrived = (deviceId: string): void => {
    const device = devices.find(deviceId);
    if (!device) return;
    const where = device.lastIp ?? 'la red local';
    tell(
      deviceId,
      'info',
      `«${device.name}» se ha conectado desde ${where}.`,
      devices.settings().notifyConnections,
    );
  };

  return {
    signedIn: (deviceId, ip) => {
      const previous = devices.recordIp(deviceId, ip);
      const arrival = arrivals.arrived(deviceId, deps.isConnected(deviceId));
      const name = devices.find(deviceId)?.name;
      if (previous !== null && previous !== ip && name !== undefined) {
        tell(
          deviceId,
          'error',
          `«${name}» se ha conectado desde una IP nueva (${ip}). Si no has sido tú, desvincúlalo.`,
          true,
        );
      } else if (arrival) arrived(deviceId);
      return previous !== ip;
    },
    presence: (deviceId) => {
      if (!deps.isConnected(deviceId)) arrivals.left(deviceId);
      else if (arrivals.arrived(deviceId, false)) arrived(deviceId);
    },
  };
}
