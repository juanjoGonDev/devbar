import os from 'node:os';
import type { RemoteControlRuntime } from '../../src/main/remote/runtime.js';
import type { RemoteControlState } from '../../src/main/remote/device-store.js';
import type { SecretBox } from '../../src/main/remote/identity.js';
import {
  createRemoteControl,
  type RemoteControlDeps,
} from '../../src/main/remote/remote-control.js';
import type {
  RemoteServer,
  RemoteServerDeps,
} from '../../src/main/remote/server.js';
import { createChannel, type Channel } from '../../renderer/remote/channel.js';
import {
  fromB64,
  generateSigningKey,
  toB64,
} from '../../renderer/remote/rc-protocol.js';
import { bridge } from './rc-bridge.js';

/**
 * «Control remoto» assembled for real (src/main/remote/remote-control.ts)
 * with every outside collaborator faked: the clock, the timers, the store,
 * the window pushes and the HTTP server — whose request handlers are wired
 * to the phone's real network code through tests/helpers/rc-bridge.ts.
 */

export const DAY = 24 * 60 * 60 * 1000;

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  repeat: boolean;
}

function nic(address: string): os.NetworkInterfaceInfo {
  return {
    address,
    family: 'IPv4',
    internal: false,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: null,
  };
}

/** The app side, inert: no groups, nothing pending, nothing to update. */
export function fakeRuntime(): RemoteControlRuntime {
  return {
    actions: {
      startProcess: () => Promise.resolve({ ok: true }),
      stopProcess: () => Promise.resolve({ ok: true }),
      runAction: () => Promise.resolve({ ok: true, processId: 'x' }),
      stopAll: () => Promise.resolve({ ok: true, stopped: 0 }),
      runPipeline: () => Promise.resolve(null),
      listBranches: () => Promise.resolve({ ok: true, branches: [] }),
      switchBranch: () => Promise.resolve({ ok: true }),
      needsConfirm: () => false,
    },
    configStore: { getGroup: () => null },
    groupStates: () => [],
    pipelineState: () => ({
      status: 'idle',
      currentStep: null,
      totalSteps: 0,
      lastError: null,
      lastRunId: null,
      startedAt: null,
    }),
    currentBranch: () => Promise.resolve({ ok: false }),
    logs: () => [],
    logSeq: () => 0,
    onLog: () => undefined,
    confirms: {
      pending: () => [],
      onChange: () => () => undefined,
      hasPending: () => false,
      resolveConfirm: () => undefined,
    },
    settings: {
      get: () => {
        throw new Error('not used');
      },
      save: () => {
        throw new Error('not used');
      },
    },
    updater: {
      status: () => ({
        available: null,
        staged: null,
        lastCheckAt: null,
        currentVersion: '0.11.0',
        phase: { state: 'idle' },
      }),
      canInstallStaged: () => false,
      installStagedHeadless: () => Promise.resolve({ ok: false }),
    },
    onBus: () => undefined,
  };
}

export function harness(
  seed: unknown = undefined,
  overrides: Partial<RemoteControlDeps> = {},
) {
  let clock = 40 * DAY;
  let stored: unknown = seed;
  const sent: { channel: string; payload: unknown }[] = [];
  const timers: FakeTimer[] = [];
  let serverDeps: RemoteServerDeps | null = null;
  let listening = false;
  let failListen: string | null = null;
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    en0: [nic('192.168.1.20')],
  };
  /** What the server was asked, in order: `start:<port>` and `stop`. */
  const lifecycle: string[] = [];
  /** Desktop banners «Control remoto» asked for. */
  const banners: { title: string; body: string; options: unknown }[] = [];
  /** A reversible stand-in for safeStorage. */
  const keychain: SecretBox = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`box:${plain}`),
    decryptString: (sealed) => sealed.toString().slice(4),
  };
  const server: RemoteServer = {
    start: () => {
      lifecycle.push(`start:${serverDeps?.port ?? '?'}`);
      if (failListen) {
        serverDeps?.onStateChange();
        return Promise.resolve();
      }
      listening = true;
      serverDeps?.onStateChange();
      return Promise.resolve();
    },
    stop: () => {
      lifecycle.push('stop');
      listening = false;
      serverDeps?.onStateChange();
      return Promise.resolve();
    },
    listening: () => listening,
    error: () => failListen,
    port: () => serverDeps?.port ?? 0,
  };
  const schedule = (repeat: boolean) => (fn: () => void, ms: number) => {
    const timer = { fn, ms, cleared: false, repeat };
    timers.push(timer);
    return timer;
  };
  const clear = (handle: unknown) => {
    (handle as FakeTimer).cleared = true;
  };
  const remote = createRemoteControl({
    readState: () => stored,
    writeState: (state: RemoteControlState) => {
      stored = structuredClone(state);
    },
    send: (channel, payload) => sent.push({ channel, payload }),
    readStatic: () => null,
    appVersion: () => '0.11.0',
    hostName: () => 'mac-de-ana',
    networkInterfaces: () => interfaces,
    now: () => clock,
    timers: {
      setTimeout: schedule(false),
      clearTimeout: clear,
      setInterval: schedule(true),
      clearInterval: clear,
    },
    createServer: (deps) => {
      serverDeps = deps;
      return server;
    },
    runtime: fakeRuntime(),
    secretBox: keychain,
    showBanner: (title, body, options) =>
      banners.push({ title, body, options }),
    ...overrides,
  });
  const net = bridge(() => {
    const deps = serverDeps;
    if (!deps) throw new Error('no server was created');
    return {
      api: (request) => deps.api(request),
      stream: (request) =>
        deps.stream?.(request) ?? { status: 404, body: { error: 'none' } },
    };
  });
  const codeOf = (url: string) => new URL(url).searchParams.get('c') ?? '';
  return {
    remote,
    net,
    banners,
    sent,
    timers,
    lifecycle,
    codeOf,
    stored: () => stored as RemoteControlState | undefined,
    channels: () => sent.map((entry) => entry.channel),
    lastOn: (channel: string) =>
      sent.filter((entry) => entry.channel === channel).at(-1)?.payload,
    failListen: (message: string | null) => {
      failListen = message;
    },
    setInterfaces: (value: NodeJS.Dict<os.NetworkInterfaceInfo[]>) => {
      interfaces = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    serverDeps: () => serverDeps,
  };
}

export type Harness = ReturnType<typeof harness>;

/** The identity key and the code a pairing URL carries. */
export function pairingLink(url: string): { code: string; key: Uint8Array } {
  const parsed = new URL(url);
  const key = fromB64(new URLSearchParams(parsed.hash.slice(1)).get('k'), 32);
  if (!key) throw new Error(`no key in ${url}`);
  return { code: parsed.searchParams.get('c') ?? '', key };
}

/** A phone that scanned the QR and asked to be linked. */
export async function scanAndRequest(h: Harness, name = 'iPhone de Ana') {
  const pairing = h.remote.startPairing();
  if (!pairing.ok) throw new Error(pairing.error);
  const { code, key } = pairingLink(pairing.url);
  const channel = createChannel(h.net.fetch);
  await channel.open(key);
  const device = generateSigningKey();
  const answer = await channel.send('pair.request', {
    code,
    name,
    devicePub: toB64(device.publicKey),
  });
  const requestId = String(answer.body.requestId);
  return { requestId, channel, device, serverKey: key, code };
}

export interface LinkedPhone {
  channel: Channel;
  device: { secretKey: Uint8Array; publicKey: Uint8Array };
  deviceId: string;
  serverKey: Uint8Array;
}

/** The whole pairing, accepted on the desktop; an authenticated channel. */
export async function linkPhone(h: Harness): Promise<LinkedPhone> {
  const scanned = await scanAndRequest(h);
  h.remote.respondPairing(scanned.requestId, true);
  const status = await scanned.channel.send('pair.status', {
    requestId: scanned.requestId,
  });
  const deviceId = String(status.body.deviceId);
  await scanned.channel.send('auth', {
    deviceId,
    sig: scanned.channel.proof(scanned.device.secretKey),
  });
  return { ...scanned, deviceId };
}

/** A fresh handshake and auth for a phone that is already linked. */
export async function reconnect(
  h: Harness,
  phone: LinkedPhone,
): Promise<{ channel: Channel; auth: number }> {
  const channel = createChannel(h.net.fetch);
  await channel.open(phone.serverKey);
  const answer = await channel.send('auth', {
    deviceId: phone.deviceId,
    sig: channel.proof(phone.device.secretKey),
  });
  return { channel, auth: answer.status };
}

/** Opens the event stream of an authenticated channel, reading it back. */
export function openEvents(h: Harness, channel: Channel) {
  const reader = channel.events();
  if (!reader) throw new Error('no session');
  const stream = h.net.openStream(reader.url);
  const decoded: { type: string; data: unknown }[] = [];
  return {
    ...stream,
    /** Every event so far, opened (each frame is read exactly once). */
    events: () => {
      for (const frame of stream.frames.slice(decoded.length))
        decoded.push(reader.read(frame) ?? { type: '?', data: null });
      return decoded;
    },
  };
}
