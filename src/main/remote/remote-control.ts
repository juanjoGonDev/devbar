import type os from 'node:os';
import type {
  RemotePairingResult,
  RemotePairRequestClosed,
  RemotePortResult,
  RemoteSecurityCodeResult,
  RemoteStatus,
} from '../../ipc-contract/remote-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import { remotePortError } from '../../remote-port.js';
import { createSessionApi } from './api.js';
import { createArrivals } from './arrivals.js';
import { createControlApi } from './control-api.js';
import { createDeviceStore, type RemoteControlState } from './device-store.js';
import { createIdentityKeys, type SecretBox } from './identity.js';
import { lanAddresses } from './lan.js';
import { createLive } from './live.js';
import { createPairing } from './pairing.js';
import { qrMatrix } from './qr.js';
import { createRateLimiter } from './rate-limit.js';
import { fromB64, safetyCode, toB64 } from './rc-protocol.js';
import { createRpc } from './rpc.js';
import { createSecureApi } from './secure-api.js';
import { createSessionTable } from './sessions.js';
import type { RemoteControlRuntime } from './runtime.js';
import {
  createRemoteServer,
  type RemoteServer,
  type RemoteServerDeps,
} from './server.js';
import { NODE_TIMERS, type TimerHandle, type Timers } from './timers.js';

/**
 * «Control remoto», assembled: the device store, this computer's identity
 * key, the pairing handshake, the LAN server, the encrypted transport
 * (devbar-rc/1: secure-api.ts, sessions.ts, rpc.ts), the control API and the
 * live event streams, behind the handful of operations the config window and
 * the app lifecycle need. `main.ts` builds it with `remoteControlFor`
 * (src/main/remote/remote-wiring.ts) and does nothing else with the pieces.
 *
 * Pushes to the windows: `remote:changed` (the whole status, after anything
 * that changes it — a phone connecting included), `remote:pairRequest` (a
 * phone is waiting for an answer) and `remote:pairRequestClosed` (answered,
 * expired or cancelled, from either end).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_LINKED = 'Ese dispositivo ya no está vinculado.';
const CONNECTED_TITLE = 'DevBar — control remoto';
const SEE_DEVICES = { label: 'Ver dispositivos', action: 'open-remote' };

export interface RemoteControlDeps {
  readState: () => unknown;
  writeState: (state: RemoteControlState) => void;
  send: (channel: string, payload: unknown) => void;
  readStatic: (file: string) => Buffer | null;
  appVersion: () => string;
  hostName: () => string;
  networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** What a linked phone drives: the app's own collaborators. */
  runtime: RemoteControlRuntime;
  /** Electron's safeStorage, which seals the identity key when it can. */
  secretBox?: SecretBox | null;
  /** The desktop banner (src/main/notification-banner.ts). */
  showBanner?: (
    title: string,
    body: string,
    options: { cta: { label: string; action: string }; record: false },
  ) => void;
  now?: () => number;
  timers?: Timers;
  createServer?: (deps: RemoteServerDeps) => RemoteServer;
}

export interface RemoteControl {
  status(): RemoteStatus;
  setEnabled(enabled: boolean): Promise<RemoteStatus>;
  setAutoUnlink(enabled: boolean): RemoteStatus;
  /** The «Avisar cuando un dispositivo se conecte» switch. */
  setNotifyConnections(enabled: boolean): RemoteStatus;
  /**
   * Persists a valid port and moves the server there: one server per port,
   * so the pairing code, the sessions and the streams of the old one end
   * with it. Linked phones stay linked: they shake hands on the new port.
   */
  setPort(port: number): Promise<RemotePortResult>;
  renameDevice(id: string, name: string): SimpleResult;
  unlinkDevice(id: string): SimpleResult;
  startPairing(): RemotePairingResult;
  cancelPairing(): void;
  respondPairing(requestId: string, accept: boolean): SimpleResult;
  /** The device's security code, and the QR its phone verifies it with. */
  securityCode(id: string): RemoteSecurityCodeResult;
  /** A new identity key: sessions, streams and pairing end; all unverified. */
  renewIdentity(): SimpleResult;
  /** A banner or completion the user was shown, for the phones' «Avisos». */
  notice(banner: { title: string; body: string; action: string | null }): void;
  /** Boot: brings the server up when the user left the switch on. */
  startIfEnabled(): Promise<void>;
  /** Shutdown: stops listening (fire and forget). */
  close(): void;
}

export function createRemoteControl(deps: RemoteControlDeps): RemoteControl {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? NODE_TIMERS;
  const { runtime } = deps;
  const devices = createDeviceStore({
    read: deps.readState,
    write: deps.writeState,
    now,
  });
  const pairing = createPairing({ now });
  const identity = createIdentityKeys({
    read: () => devices.identity(),
    write: (record) => devices.saveIdentity(record),
    secretBox: deps.secretBox ?? null,
  });
  const sessions = createSessionTable({ now });
  const arrivals = createArrivals({ now });
  /** Where each device last proved itself from, for the notice. */
  const lastIp = new Map<string, string>();
  const expiries = new Map<string, TimerHandle>();
  let pruneTimer: TimerHandle = null;
  const hostInfo = () => ({
    name: deps.hostName(),
    version: deps.appVersion(),
  });

  const addresses = (): string[] => lanAddresses(deps.networkInterfaces());
  const status = (): RemoteStatus => {
    const settings = devices.settings();
    return {
      ...settings,
      port: server.port(),
      listening: server.listening(),
      error: settings.enabled ? server.error() : null,
      addresses: addresses(),
      devices: devices.list().map((device) => ({
        ...device,
        connected: live.isConnected(device.id),
      })),
    };
  };
  // At quit the windows are being torn down: a push then only logs
  // "Render frame was disposed", so shutdown stops without telling them.
  let shuttingDown = false;
  const send = (channel: string, payload: unknown): void => {
    if (!shuttingDown) deps.send(channel, payload);
  };
  const changed = (): void => send('remote:changed', status());

  const live = createLive({
    runtime,
    hostInfo,
    now,
    timers,
    // Presence is what «Conectado ahora» shows; a stream that just closed
    // is also the moment «Última conexión» starts counting from.
    onPresenceChange: (deviceId) => {
      devices.touch(deviceId);
      if (!live.isConnected(deviceId)) arrivals.left(deviceId);
      else if (arrivals.arrived(deviceId, false)) announce(deviceId);
      changed();
    },
  });

  /** «… se ha conectado»: a banner here, a notice for the other phones. */
  function announce(deviceId: string): void {
    const device = devices.find(deviceId);
    if (!device) return;
    const body = `«${device.name}» se ha conectado desde ${lastIp.get(deviceId) ?? 'la red local'}.`;
    live.announce({ kind: 'info', title: 'Control remoto', body }, deviceId);
    if (devices.settings().notifyConnections)
      deps.showBanner?.(CONNECTED_TITLE, body, {
        cta: SEE_DEVICES,
        record: false,
      });
  }

  const closeRequest = (
    requestId: string,
    outcome: RemotePairRequestClosed['outcome'],
  ): void => {
    const timer = expiries.get(requestId);
    if (timer !== undefined) timers.clearTimeout(timer);
    expiries.delete(requestId);
    const closed: RemotePairRequestClosed = { requestId, outcome };
    send('remote:pairRequestClosed', closed);
  };

  /** Ends a device's sessions and their streams; the phone reconnects. */
  const dropSessions = (deviceId: string): void =>
    live.closeSessions(sessions.dropDevice(deviceId));

  const sessionApi = createSessionApi({
    devices,
    pairing,
    limiter: createRateLimiter({ limit: 5, windowMs: 60_000, now }),
    hostInfo,
    devicesChanged: changed,
    pairRequested: (request) => {
      send('remote:pairRequest', request);
      const expire = (): void => {
        if (pairing.expire(request.requestId))
          closeRequest(request.requestId, 'expired');
      };
      expiries.set(
        request.requestId,
        timers.setTimeout(expire, Math.max(0, request.expiresAt - now())),
      );
    },
    pairWithdrawn: (requestId) => closeRequest(requestId, 'cancelled'),
    deviceUnlinked: (id) => {
      live.drop(id);
      dropSessions(id);
    },
    deviceRotated: dropSessions,
    deviceAuthenticated: (deviceId, ip) => {
      lastIp.set(deviceId, ip);
      if (arrivals.arrived(deviceId, live.isConnected(deviceId)))
        announce(deviceId);
    },
  });

  const controlApi = createControlApi({
    configStore: runtime.configStore,
    runtime: runtime.actions,
    state: () => live.state(),
    logs: (id) => runtime.logs(id),
    logSeq: (id) => runtime.logSeq(id),
    notices: (deviceId) => live.notices(deviceId),
    confirms: runtime.confirms,
    settings: runtime.settings,
    updater: runtime.updater,
    renameDevice: (id, name) => {
      const outcome = devices.rename(id, name);
      if (outcome === 'ok') changed();
      return outcome;
    },
    branchSwitched: (groupId) => live.branchSwitched(groupId),
    reportError: (error) =>
      console.error('[remote] background request failed:', error),
  });

  const secure = createSecureApi({
    identity,
    sessions,
    limiter: createRateLimiter({ limit: 30, windowMs: 60_000, now }),
    dispatch: createRpc({
      session: sessionApi,
      control: controlApi,
      devices,
      devicesChanged: changed,
      subscribeLogs: (sessionId, logsId) => live.subscribe(sessionId, logsId),
    }),
    stream: (session, device) =>
      live.stream({
        deviceId: device.id,
        sessionId: session.id,
        logsId: session.logsId,
      }),
    device: (id) => devices.find(id),
  });

  const serverFor = (port: number): RemoteServer =>
    (deps.createServer ?? createRemoteServer)({
      port,
      addresses,
      readStatic: deps.readStatic,
      onStateChange: changed,
      api: (request) => secure.route(request),
      stream: (request) => secure.events(request),
    });
  /** Where a phone reaches this server, when it can. */
  const origin = (): string | null => {
    const [address] = addresses();
    return server.listening() && address
      ? `http://${address}:${server.port()}`
      : null;
  };
  let server = serverFor(devices.settings().port);

  /**
   * Auto-unlink, sparing whoever is connected: a phone can sit on one open
   * stream for weeks without another request, and being connected is being
   * seen.
   */
  const pruneStale = (): number => {
    for (const device of devices.list())
      if (live.isConnected(device.id)) devices.touch(device.id);
    return devices.pruneStale();
  };
  const prune = (): void => {
    if (pruneStale() > 0) changed();
  };

  const start = async (): Promise<void> => {
    await server.start();
    if (!server.listening()) return;
    prune();
    pruneTimer ??= timers.setInterval(prune, DAY_MS);
  };

  const stop = async (): Promise<void> => {
    for (const requestId of pairing.clear())
      closeRequest(requestId, 'cancelled');
    if (pruneTimer !== null) timers.clearInterval(pruneTimer);
    pruneTimer = null;
    live.close();
    sessions.dropAll();
    await server.stop();
  };

  return {
    status,
    setEnabled: async (enabled) => {
      devices.setEnabled(enabled);
      await (enabled ? start() : stop());
      return status();
    },
    setAutoUnlink: (enabled) => {
      devices.setAutoUnlink(enabled);
      if (enabled && server.listening()) pruneStale();
      changed();
      return status();
    },
    setNotifyConnections: (enabled) => {
      devices.setNotifyConnections(enabled);
      changed();
      return status();
    },
    setPort: async (port) => {
      const error = remotePortError(port);
      if (error !== null) return { ok: false, error };
      if (port !== devices.settings().port) {
        devices.setPort(port);
        // The switch decides, not `listening()`: a listen that failed on the
        // old port is exactly what the user is fixing here.
        await stop();
        server = serverFor(port);
        if (devices.settings().enabled) await start();
        else changed();
      }
      return { ok: true, status: status() };
    },
    renameDevice: (id, name) => {
      const outcome = devices.rename(id, name);
      if (outcome === 'invalid-name')
        return {
          ok: false,
          error: 'El nombre debe tener entre 1 y 40 caracteres.',
        };
      if (outcome === 'not-found') return { ok: false, error: NOT_LINKED };
      changed();
      return { ok: true };
    },
    unlinkDevice: (id) => {
      if (!devices.remove(id)) return { ok: false, error: NOT_LINKED };
      live.drop(id);
      dropSessions(id);
      changed();
      return { ok: true };
    },
    startPairing: () => {
      if (!server.listening())
        return {
          ok: false,
          error: 'Activa el control remoto para vincular dispositivos.',
        };
      const [address] = addresses();
      if (!address)
        return {
          ok: false,
          error: 'Este equipo no tiene una dirección en la red local.',
        };
      const { code, expiresAt } = pairing.startPairing();
      // The identity key rides in the fragment, which the browser never
      // sends anywhere: the phone pins it before it trusts a single answer.
      const key = toB64(identity.publicKey());
      const url = `http://${address}:${server.port()}/pair?c=${code}#k=${key}`;
      return { ok: true, url, expiresAt, qr: qrMatrix(url) };
    },
    cancelPairing: () => pairing.cancelPairing(),
    respondPairing: (requestId, accept) => {
      if (!pairing.respond(requestId, accept))
        return { ok: false, error: 'La solicitud ya no está pendiente.' };
      closeRequest(requestId, accept ? 'accepted' : 'rejected');
      return { ok: true };
    },
    securityCode: (id) => {
      const device = devices.find(id);
      const devicePub = fromB64(devices.devicePub(id));
      if (!device || !devicePub) return { ok: false, error: NOT_LINKED };
      const serverPub = identity.publicKey();
      const base = origin();
      const url = base
        ? `${base}/verify#k=${toB64(serverPub)}&d=${encodeURIComponent(id)}&p=${toB64(devicePub)}`
        : null;
      return {
        ok: true,
        code: safetyCode(serverPub, devicePub),
        verified: device.verifiedAt !== null,
        url,
        qr: url ? qrMatrix(url) : null,
      };
    },
    renewIdentity: () => {
      identity.renew();
      devices.clearVerified();
      for (const requestId of pairing.clear())
        closeRequest(requestId, 'cancelled');
      // Every phone reconnects, sees the new key and stops until the user
      // verifies it again.
      live.close();
      sessions.dropAll();
      changed();
      return { ok: true };
    },
    notice: (banner) => live.notice(banner),
    startIfEnabled: async () => {
      if (devices.settings().enabled) await start();
    },
    close: () => {
      shuttingDown = true;
      void stop();
    },
  };
}
