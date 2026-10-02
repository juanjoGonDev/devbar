import fs from 'node:fs';
import os from 'node:os';
import type {
  RemotePairingResult,
  RemotePairRequestClosed,
  RemoteStatus,
} from '../../ipc-contract/remote-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import { sendToRenderers } from '../renderer-bus.js';
import { createApi, type ApiRequest, type ApiResponse } from './api.js';
import { createControlApi } from './control-api.js';
import { createDeviceStore, type RemoteControlState } from './device-store.js';
import { clearedSessionCookie } from './http-guard.js';
import { lanAddresses } from './lan.js';
import { createLive } from './live.js';
import { createPairing } from './pairing.js';
import { qrMatrix } from './qr.js';
import { createRateLimiter } from './rate-limit.js';
import {
  remoteRuntime,
  type RemoteAppWiring,
  type RemoteControlRuntime,
} from './runtime.js';
import {
  createRemoteServer,
  type RemoteServer,
  type RemoteServerDeps,
} from './server.js';
import { NODE_TIMERS, type TimerHandle, type Timers } from './timers.js';

/**
 * «Control remoto», assembled: the device store, the pairing handshake, the
 * LAN server, the control API and the live event streams, behind the handful
 * of operations the config window and the app lifecycle need. `main.ts`
 * builds it with `remoteControlFor` and does nothing else with the pieces.
 *
 * Pushes to the windows: `remote:changed` (the whole status, after anything
 * that changes it — a phone connecting included), `remote:pairRequest` (a
 * phone is waiting for an answer) and `remote:pairRequestClosed` (answered,
 * expired or cancelled, from either end).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_LINKED = 'Ese dispositivo ya no está vinculado.';

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
  now?: () => number;
  timers?: Timers;
  createServer?: (deps: RemoteServerDeps) => RemoteServer;
}

export interface RemoteControl {
  status(): RemoteStatus;
  setEnabled(enabled: boolean): Promise<RemoteStatus>;
  setAutoUnlink(enabled: boolean): RemoteStatus;
  renameDevice(id: string, name: string): SimpleResult;
  unlinkDevice(id: string): SimpleResult;
  startPairing(): RemotePairingResult;
  cancelPairing(): void;
  respondPairing(requestId: string, accept: boolean): SimpleResult;
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
  const changed = (): void => deps.send('remote:changed', status());

  const live = createLive({
    runtime,
    hostInfo,
    now,
    timers,
    // Presence is what «Conectado ahora» shows; a stream that just closed
    // is also the moment «Última conexión» starts counting from.
    onPresenceChange: (deviceId) => {
      devices.touch(deviceId);
      changed();
    },
  });

  const closeRequest = (
    requestId: string,
    outcome: RemotePairRequestClosed['outcome'],
  ): void => {
    const timer = expiries.get(requestId);
    if (timer !== undefined) timers.clearTimeout(timer);
    expiries.delete(requestId);
    const closed: RemotePairRequestClosed = { requestId, outcome };
    deps.send('remote:pairRequestClosed', closed);
  };

  const sessionApi = createApi({
    devices,
    pairing,
    limiter: createRateLimiter({ limit: 5, windowMs: 60_000, now }),
    hostInfo,
    devicesChanged: changed,
    pairRequested: (request) => {
      deps.send('remote:pairRequest', request);
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
    deviceUnlinked: (id) => live.drop(id),
  });

  const controlApi = createControlApi({
    configStore: runtime.configStore,
    runtime: runtime.actions,
    state: () => live.state(),
    logs: (id) => runtime.logs(id),
    logSeq: (id) => runtime.logSeq(id),
    notices: () => live.notices(),
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

  /** The calling device, or null; seeing it is also a sign of life. */
  const caller = (request: ApiRequest) => {
    const device = request.token ? devices.findByToken(request.token) : null;
    if (device && devices.touch(device.id)) changed();
    return device;
  };
  const unlinked = (): ApiResponse => ({
    status: 401,
    body: { error: 'unlinked' },
    setCookie: clearedSessionCookie(),
  });

  const server = (deps.createServer ?? createRemoteServer)({
    port: devices.settings().port,
    addresses,
    readStatic: deps.readStatic,
    onStateChange: changed,
    api: (request) => {
      if (!controlApi.handles(request.pathname)) return sessionApi(request);
      const device = caller(request);
      return device ? controlApi.handle(request, device) : unlinked();
    },
    stream: (request) => {
      const device = caller(request);
      return device ? live.stream(request, device) : unlinked();
    },
  });

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
      const url = `http://${address}:${server.port()}/pair?c=${code}`;
      return { ok: true, url, expiresAt, qr: qrMatrix(url) };
    },
    cancelPairing: () => pairing.cancelPairing(),
    respondPairing: (requestId, accept) => {
      if (!pairing.respond(requestId, accept))
        return { ok: false, error: 'La solicitud ya no está pendiente.' };
      closeRequest(requestId, accept ? 'accepted' : 'rejected');
      return { ok: true };
    },
    notice: (banner) => live.notice(banner),
    startIfEnabled: async () => {
      if (devices.settings().enabled) await start();
    },
    close: () => void stop(),
  };
}

/** What main.ts already has at hand. */
interface RemoteWiring extends RemoteAppWiring {
  host: RemoteAppWiring['host'] & {
    rendererFile(name: string): string;
    appVersion(): string;
  };
  configStore: RemoteAppWiring['configStore'] & {
    getRemoteControl(): unknown;
    saveRemoteControl(state: RemoteControlState): void;
  };
}

/** The real collaborators: disk, OS, the window fan-out and the app. */
export function remoteControlDeps(wiring: RemoteWiring): RemoteControlDeps {
  return {
    readState: () => wiring.configStore.getRemoteControl(),
    writeState: (state) => wiring.configStore.saveRemoteControl(state),
    send: (channel, payload) =>
      sendToRenderers(wiring.registry, channel, payload),
    readStatic: (file) => {
      try {
        return fs.readFileSync(wiring.host.rendererFile(file));
      } catch {
        return null;
      }
    },
    appVersion: () => wiring.host.appVersion(),
    // "Mac-de-Ana.local" → "Mac-de-Ana": what the phone calls this computer.
    hostName: () => os.hostname().split('.')[0] ?? os.hostname(),
    networkInterfaces: () => os.networkInterfaces(),
    runtime: remoteRuntime(wiring),
  };
}

export function remoteControlFor(wiring: RemoteWiring): RemoteControl {
  return createRemoteControl(remoteControlDeps(wiring));
}
