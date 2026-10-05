import type os from 'node:os';
import type {
  RemotePairCodeResult,
  RemotePairingResult,
  RemotePortResult,
  RemoteSecurityCodeResult,
  RemoteStatus,
} from '../../ipc-contract/remote-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import { remotePortError } from '../../remote-port.js';
import { createSessionApi } from './api.js';
import { createArrivals } from './arrivals.js';
import {
  createConnectionAlerts,
  type ConnectionAlertsDeps,
} from './connection-alerts.js';
import { createControlApi } from './control-api.js';
import { createDeviceStore, type RemoteControlState } from './device-store.js';
import { createIdentityKeys, type SecretBox } from './identity.js';
import { lanAddresses } from './lan.js';
import { createLive } from './live.js';
import { createPairing } from './pairing.js';
import { createPairingDesk } from './pairing-desk.js';
import { qrMatrix } from './qr.js';
import { createRateLimiter } from './rate-limit.js';
import { fromB64, safetyCode, toB64 } from './rc-protocol.js';
import { createRpc } from './rpc.js';
import { createSecureApi } from './secure-api.js';
import { createSerial } from './serial.js';
import { createSessionTable } from './sessions.js';
import type { RemoteControlRuntime } from './runtime.js';
import {
  createRemoteServer,
  type RemoteServer,
  type RemoteServerDeps,
} from './server.js';
import { NODE_TIMERS, type TimerHandle, type Timers } from './timers.js';
import { createVerifyTokens } from './verify-tokens.js';

/**
 * «Control remoto», assembled: the device store, this computer's identity
 * key, the pairing handshake (pairing.ts, and pairing-desk.ts for the
 * desktop's dialog), the LAN server, the encrypted transport (devbar-rc/1:
 * secure-api.ts, sessions.ts, rpc.ts), the control API, the live event
 * streams and what is said when a device connects (connection-alerts.ts),
 * behind the handful of operations the config window and the app lifecycle
 * need. `main.ts` builds it with `remoteControlFor`
 * (src/main/remote/remote-wiring.ts) and does nothing else with the pieces.
 *
 * The server never starts behind an identity key it cannot read (a locked
 * or denied keychain): the status says why (`keyError`) until a retry reads
 * it or the user renews the key. Reading it can wait on the keychain for as
 * long as a macOS permission prompt stays open, so nothing here blocks on
 * it: the status says it is waiting (`keyPending`), and every start, stop,
 * port change and renewal runs one at a time behind it — one identity and
 * one server, however often the switch is pressed meanwhile.
 *
 * Pushes to the windows: `remote:changed` (the whole status, after anything
 * that changes it — a phone connecting included), `remote:pairCodeClaimed`
 * (a phone spent the QR's code), `remote:pairRequest` (a phone is waiting
 * for an answer) and `remote:pairRequestClosed` (answered, expired or
 * cancelled, from either end).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_LINKED = 'Ese dispositivo ya no está vinculado.';
const KEY_ERROR =
  'No se pudo leer la clave de seguridad del llavero del sistema. Desbloquéalo y pulsa Reintentar.';

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
  showBanner?: ConnectionAlertsDeps['showBanner'];
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
  /** The digits typed in «¿Vincular este dispositivo?» against the phone's. */
  checkPairCode(requestId: string, code: string): RemotePairCodeResult;
  /** Accepting re-checks the digits; rejecting needs none. */
  respondPairing(
    requestId: string,
    accept: boolean,
    code: string,
  ): SimpleResult;
  /** The device's security code, and the QR its phone verifies it with. */
  securityCode(id: string): Promise<RemoteSecurityCodeResult>;
  /**
   * A new identity key: sessions, streams and pairing end; all unverified.
   * The only way an unreadable key is ever replaced.
   */
  renewIdentity(): Promise<SimpleResult>;
  /** A banner or completion the user was shown, for the phones' «Avisos». */
  notice(banner: { title: string; body: string; action: string | null }): void;
  /**
   * Boot: brings the server up when the user left the switch on. It may wait
   * on the keychain, so boot kicks it off without awaiting it.
   */
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
  const verifyTokens = createVerifyTokens({ now });
  let pruneTimer: TimerHandle = null;
  /** Set while the stored identity cannot be read: the server stays off. */
  let keyError: string | null = null;
  /** Set while a start waits on the keychain for the identity key. */
  let keyPending = false;
  /** Starts, stops, port changes and renewals: one at a time. */
  const serial = createSerial();
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
      keyError: settings.enabled ? keyError : null,
      keyPending: settings.enabled && keyPending,
      keyUnsealed: identity.unsealed(),
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
      alerts.presence(deviceId);
      changed();
    },
  });
  const alerts = createConnectionAlerts({
    devices,
    arrivals: createArrivals({ now }),
    isConnected: (deviceId) => live.isConnected(deviceId),
    announce: (notice, aboutDevice) => live.announce(notice, aboutDevice),
    showBanner: (title, body, options) =>
      deps.showBanner?.(title, body, options),
  });
  const desk = createPairingDesk({ pairing, now, timers, send });

  /** Ends a device's sessions and their streams; the phone reconnects. */
  const dropSessions = (deviceId: string): void => {
    verifyTokens.revoke(deviceId);
    live.closeSessions(sessions.dropDevice(deviceId));
  };
  const forget = (deviceId: string): void => {
    live.drop(deviceId);
    dropSessions(deviceId);
  };

  const sessionApi = createSessionApi({
    devices,
    pairing,
    verifyTokens,
    limiter: createRateLimiter({ limit: 5, windowMs: 60_000, now }),
    hostInfo,
    devicesChanged: changed,
    pairClaimed: () => desk.claimed(),
    pairRequested: (request) => desk.requested(request),
    pairWithdrawn: (requestId) => desk.withdrawn(requestId),
    deviceUnlinked: forget,
    deviceRotated: dropSessions,
    deviceAuthenticated: (deviceId, ip) => {
      if (alerts.signedIn(deviceId, ip)) changed();
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

  /** The identity key, saying meanwhile that the keychain is being asked. */
  const loadIdentity = async (): Promise<boolean> => {
    if (!identity.loaded()) {
      keyPending = true;
      keyError = null;
      changed();
    }
    try {
      return await identity.load();
    } finally {
      keyPending = false;
    }
  };

  /** Only ever run through `serial`. */
  const start = async (): Promise<void> => {
    const readable = await loadIdentity();
    // Fail closed: never a server behind a key the phones did not pin.
    keyError = readable ? null : KEY_ERROR;
    // The keychain may have taken its time: the switch, or the app, may be
    // off by now.
    if (!readable || shuttingDown || !devices.settings().enabled) {
      changed();
      return;
    }
    if (!server.listening()) await server.start();
    if (!server.listening()) return;
    prune();
    pruneTimer ??= timers.setInterval(prune, DAY_MS);
  };

  const stop = async (): Promise<void> => {
    desk.clear();
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
      await serial(enabled ? start : stop);
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
      await serial(async () => {
        if (port === devices.settings().port) return;
        devices.setPort(port);
        // The switch decides, not `listening()`: a listen that failed on the
        // old port is exactly what the user is fixing here.
        await stop();
        server = serverFor(port);
        if (devices.settings().enabled) await start();
        else changed();
      });
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
      forget(id);
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
      return desk.start(
        `http://${address}:${server.port()}`,
        identity.publicKey(),
      );
    },
    cancelPairing: () => pairing.cancelPairing(),
    checkPairCode: (requestId, code) => desk.checkCode(requestId, code),
    respondPairing: (requestId, accept, code) =>
      desk.respond(requestId, accept, code),
    securityCode: async (id) => {
      if (!devices.find(id)) return { ok: false, error: NOT_LINKED };
      // With the server off the key may not be in memory yet.
      if (!(await identity.load())) return { ok: false, error: KEY_ERROR };
      const device = devices.find(id);
      const devicePub = fromB64(devices.devicePub(id));
      if (!device || !devicePub) return { ok: false, error: NOT_LINKED };
      const serverPub = identity.publicKey();
      const base = origin();
      // `t`: a one-time token, so the phone's «verify.done» proves it
      // scanned this very screen (src/main/remote/verify-tokens.ts).
      const url = base
        ? `${base}/verify#k=${toB64(serverPub)}&d=${encodeURIComponent(id)}&p=${toB64(devicePub)}&t=${verifyTokens.issue(id)}`
        : null;
      return {
        ok: true,
        code: safetyCode(serverPub, devicePub),
        verified: device.verifiedAt !== null,
        url,
        qr: url ? qrMatrix(url) : null,
      };
    },
    renewIdentity: () =>
      serial(async () => {
        await identity.renew();
        devices.clearVerified();
        verifyTokens.clear();
        desk.clear();
        // Every phone reconnects, sees the new key and stops until the user
        // verifies it again.
        live.close();
        sessions.dropAll();
        changed();
        // A key that could not be read kept the server off until now.
        if (keyError !== null && devices.settings().enabled) await start();
        return { ok: true };
      }),
    notice: (banner) => live.notice(banner),
    startIfEnabled: () =>
      serial(async () => {
        if (devices.settings().enabled) await start();
      }),
    close: () => {
      shuttingDown = true;
      void stop();
    },
  };
}
