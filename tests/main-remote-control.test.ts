import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiRequest, ApiResponse } from '../src/main/remote/api.js';
import type { EventSink } from '../src/main/remote/events.js';
import type { RemoteControlRuntime } from '../src/main/remote/runtime.js';
import type { RemoteControlState } from '../src/main/remote/device-store.js';
import { hashToken } from '../src/main/remote/device-store.js';
import {
  createRemoteControl,
  remoteControlDeps,
  type RemoteControlDeps,
} from '../src/main/remote/remote-control.js';
import type {
  RemoteServer,
  RemoteServerDeps,
} from '../src/main/remote/server.js';
import { createWindowRegistry } from '../src/main/renderer-bus.js';
import { fakeAppWiring } from './helpers/remote-wiring.js';
import type {
  RemotePairRequest,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

const DAY = 24 * 60 * 60 * 1000;
const COOKIE = /^devbar_session=([A-Za-z0-9_-]{43});/;

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
function fakeRuntime(): RemoteControlRuntime {
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

function harness(
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
    ...overrides,
  });
  const request = (partial: Partial<ApiRequest>): ApiRequest => ({
    method: 'GET',
    pathname: '/api/me',
    query: new URLSearchParams(),
    token: null,
    ip: '192.168.1.40',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
    body: undefined,
    ...partial,
  });
  /** The pairing and session routes, which answer synchronously. */
  const api = (partial: Partial<ApiRequest>): ApiResponse => {
    if (!serverDeps) throw new Error('no server was created');
    return serverDeps.api(request(partial)) as ApiResponse;
  };
  /** Any route, awaited. */
  const call = async (partial: Partial<ApiRequest>): Promise<ApiResponse> => {
    if (!serverDeps) throw new Error('no server was created');
    return serverDeps.api(request(partial));
  };
  /** Opens /api/events the way the server does; null when refused. */
  const openStream = (token: string | null) => {
    const answer = serverDeps?.stream?.(
      request({ pathname: '/api/events', token }),
    );
    if (!answer) throw new Error('no stream handler');
    const chunks: string[] = [];
    let ended = false;
    const sink: EventSink = {
      write: (chunk) => {
        chunks.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
      },
    };
    if (!('open' in answer))
      return { refused: answer, chunks, ended: () => ended };
    const detach = answer.open(sink);
    return { refused: null, chunks, ended: () => ended, detach };
  };
  const codeOf = (url: string) => new URL(url).searchParams.get('c') ?? '';
  return {
    remote,
    api,
    call,
    openStream,
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

/** Pairing up to the desktop's decision; the phone's request id. */
function scanAndRequest(h: ReturnType<typeof harness>): string {
  const pairing = h.remote.startPairing();
  if (!pairing.ok) throw new Error(pairing.error);
  const answer = h.api({
    method: 'POST',
    pathname: '/api/pair/request',
    body: { code: h.codeOf(pairing.url), name: 'iPhone de Ana' },
  });
  return (answer.body as { requestId: string }).requestId;
}

describe('src/main/remote/remote-control.ts', () => {
  describe('status', () => {
    it('starts off with the default port and the LAN addresses', () => {
      const h = harness();

      expect(h.remote.status()).toEqual({
        enabled: false,
        autoUnlink: true,
        port: 47821,
        listening: false,
        error: null,
        addresses: ['192.168.1.20'],
        devices: [],
      });
    });

    it('creates the server on the stored port', () => {
      const h = harness({ port: 50123 });

      expect(h.serverDeps()?.port).toBe(50123);
      expect(h.serverDeps()?.addresses()).toEqual(['192.168.1.20']);
    });
  });

  describe('setEnabled', () => {
    it('persists the switch, starts the server and pushes the change', async () => {
      const h = harness();

      const status = await h.remote.setEnabled(true);

      expect(status).toMatchObject({ enabled: true, listening: true });
      expect(h.stored()?.enabled).toBe(true);
      expect(h.lastOn('remote:changed')).toMatchObject({ listening: true });
    });

    it('stops the server when switched off', async () => {
      const h = harness();
      await h.remote.setEnabled(true);

      const status = await h.remote.setEnabled(false);

      expect(status).toMatchObject({ enabled: false, listening: false });
      expect(h.stored()?.enabled).toBe(false);
    });

    it('shows a listen failure only while the switch is on', async () => {
      const h = harness();
      h.failListen('El puerto 47821 ya está en uso por otra aplicación.');

      expect(await h.remote.setEnabled(true)).toMatchObject({
        enabled: true,
        listening: false,
        error: 'El puerto 47821 ya está en uso por otra aplicación.',
      });
      expect((await h.remote.setEnabled(false)).error).toBeNull();
    });

    it('cancels a pending pairing request when switched off', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const requestId = scanAndRequest(h);

      await h.remote.setEnabled(false);

      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'cancelled',
      });
    });
  });

  describe('startIfEnabled', () => {
    it('starts the server at boot only when the user left it on', async () => {
      const off = harness();
      await off.remote.startIfEnabled();
      expect(off.remote.status().listening).toBe(false);

      const on = harness({ enabled: true });
      await on.remote.startIfEnabled();
      expect(on.remote.status().listening).toBe(true);
    });
  });

  describe('setPort', () => {
    it.each([80, 70_000, 50_000.5, Number.NaN])(
      'refuses %s with the reason and changes nothing',
      async (port) => {
        const h = harness();
        await h.remote.setEnabled(true);

        expect(await h.remote.setPort(port)).toEqual({
          ok: false,
          error: 'El puerto debe ser un número entero entre 1024 y 65535.',
        });
        expect(h.stored()?.port).toBe(47821);
        expect(h.lifecycle).toEqual(['start:47821']);
      },
    );

    it('persists and shows the port while off, starting nothing', async () => {
      const h = harness();

      const result = await h.remote.setPort(50123);

      expect(result).toEqual({ ok: true, status: h.remote.status() });
      expect(h.remote.status()).toMatchObject({
        port: 50123,
        listening: false,
      });
      expect(h.stored()?.port).toBe(50123);
      expect(h.lifecycle.some((step) => step.startsWith('start'))).toBe(false);
      expect(h.lastOn('remote:changed')).toMatchObject({ port: 50123 });
    });

    it('restarts a running server on the new port', async () => {
      const h = harness();
      await h.remote.setEnabled(true);

      const result = await h.remote.setPort(50123);

      expect(h.lifecycle).toEqual(['start:47821', 'stop', 'start:50123']);
      expect(result).toMatchObject({
        ok: true,
        status: { port: 50123, listening: true },
      });
      expect(h.stored()?.port).toBe(50123);
      expect(h.lastOn('remote:changed')).toMatchObject({
        port: 50123,
        listening: true,
      });
    });

    it('builds the pairing URL on the new port', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      await h.remote.setPort(50123);

      const pairing = h.remote.startPairing();

      if (!pairing.ok) throw new Error(pairing.error);
      expect(pairing.url).toMatch(/^http:\/\/192\.168\.1\.20:50123\/pair\?c=/);
    });

    it('retires the pairing code issued on the old port', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const pairing = h.remote.startPairing();
      if (!pairing.ok) throw new Error(pairing.error);

      await h.remote.setPort(50123);

      expect(
        h.api({
          method: 'POST',
          pathname: '/api/pair/request',
          body: { code: h.codeOf(pairing.url), name: 'x' },
        }).status,
      ).toBe(410);
    });

    it('cancels a pairing request waiting for an answer', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const requestId = scanAndRequest(h);

      await h.remote.setPort(50123);

      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'cancelled',
      });
    });

    it('shows a listen failure on the new port like any other', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      h.failListen('El puerto 50123 ya está en uso por otra aplicación.');

      expect(await h.remote.setPort(50123)).toMatchObject({
        ok: true,
        status: {
          listening: false,
          error: 'El puerto 50123 ya está en uso por otra aplicación.',
        },
      });
    });

    it('brings the server up on a free port when the old one was taken', async () => {
      const h = harness();
      h.failListen('El puerto 47821 ya está en uso por otra aplicación.');
      await h.remote.setEnabled(true);
      h.failListen(null);

      expect(await h.remote.setPort(50123)).toMatchObject({
        ok: true,
        status: { port: 50123, listening: true, error: null },
      });
    });

    it('leaves a running server alone when the port is the same', async () => {
      const h = harness();
      await h.remote.setEnabled(true);

      expect(await h.remote.setPort(47821)).toMatchObject({ ok: true });
      expect(h.lifecycle).toEqual(['start:47821']);
    });
  });

  describe('startPairing', () => {
    it('refuses while the server is not listening', () => {
      const h = harness();

      expect(h.remote.startPairing()).toEqual({
        ok: false,
        error: 'Activa el control remoto para vincular dispositivos.',
      });
    });

    it('refuses when this machine has no LAN address', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      h.setInterfaces({});

      expect(h.remote.startPairing()).toEqual({
        ok: false,
        error: 'Este equipo no tiene una dirección en la red local.',
      });
    });

    it('returns the pairing URL on the LAN address with its QR', async () => {
      const h = harness();
      await h.remote.setEnabled(true);

      const pairing = h.remote.startPairing();

      if (!pairing.ok) throw new Error(pairing.error);
      expect(pairing.url).toMatch(
        /^http:\/\/192\.168\.1\.20:47821\/pair\?c=[A-Za-z0-9_-]{24}$/,
      );
      expect(pairing.qr.modules).toHaveLength(pairing.qr.size ** 2);
      expect(pairing.expiresAt).toBeGreaterThan(0);
    });
  });

  describe('the pairing handshake', () => {
    it('tells the desktop, then links the phone once it is accepted', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const requestId = scanAndRequest(h);

      expect(h.lastOn('remote:pairRequest')).toMatchObject({
        requestId,
        name: 'iPhone de Ana',
        client: 'Safari · iOS',
        ip: '192.168.1.40',
      } satisfies Partial<RemotePairRequest>);

      expect(h.remote.respondPairing(requestId, true)).toEqual({ ok: true });
      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'accepted',
      });

      const answer = h.api({
        pathname: '/api/pair/status',
        query: new URLSearchParams({ id: requestId }),
      });
      const token = COOKIE.exec(answer.setCookie ?? '')?.[1] ?? '';
      expect(h.stored()?.devices[0]?.tokenHash).toBe(hashToken(token));
      expect(
        (h.lastOn('remote:changed') as RemoteStatus).devices.map((d) => d.name),
      ).toEqual(['iPhone de Ana']);
    });

    it('closes a rejected request and creates nothing', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const requestId = scanAndRequest(h);

      h.remote.respondPairing(requestId, false);

      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'rejected',
      });
      expect(h.remote.respondPairing(requestId, true)).toEqual({
        ok: false,
        error: 'La solicitud ya no está pendiente.',
      });
      expect(h.remote.status().devices).toEqual([]);
    });

    it('auto-rejects an unanswered request when its minute is up', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const requestId = scanAndRequest(h);
      const timer = h.timers.find((t) => !t.repeat && t.ms === 60_000);

      h.advance(60_000);
      timer?.fn();

      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'expired',
      });
    });

    it('clears the expiry timer of a request that was answered', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const requestId = scanAndRequest(h);

      h.remote.respondPairing(requestId, true);

      expect(h.timers.find((t) => t.ms === 60_000)?.cleared).toBe(true);
    });

    it('cancels the active code', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const pairing = h.remote.startPairing();
      if (!pairing.ok) throw new Error(pairing.error);

      h.remote.cancelPairing();

      expect(
        h.api({
          method: 'POST',
          pathname: '/api/pair/request',
          body: { code: h.codeOf(pairing.url), name: 'x' },
        }).status,
      ).toBe(410);
    });
  });

  describe('devices', () => {
    const seeded = (lastSeenAt: number) => ({
      autoUnlink: true,
      devices: [
        {
          id: 'd1',
          name: 'iPhone',
          tokenHash: hashToken('t'),
          client: 'Safari · iOS',
          createdAt: 1,
          lastSeenAt,
        },
      ],
    });

    it('renames a device and pushes the change', () => {
      const h = harness(seeded(50_000_000));

      expect(h.remote.renameDevice('d1', ' Tablet ')).toEqual({ ok: true });
      expect(
        (h.lastOn('remote:changed') as RemoteStatus).devices[0]?.name,
      ).toBe('Tablet');
    });

    it('explains a refused rename', () => {
      const h = harness(seeded(50_000_000));

      expect(h.remote.renameDevice('d1', '')).toEqual({
        ok: false,
        error: 'El nombre debe tener entre 1 y 40 caracteres.',
      });
      expect(h.remote.renameDevice('ghost', 'Tablet')).toEqual({
        ok: false,
        error: 'Ese dispositivo ya no está vinculado.',
      });
    });

    it('unlinks a device', () => {
      const h = harness(seeded(50_000_000));

      expect(h.remote.unlinkDevice('d1')).toEqual({ ok: true });
      expect(h.remote.status().devices).toEqual([]);
      expect(h.remote.unlinkDevice('d1')).toMatchObject({ ok: false });
    });

    it('prunes stale devices at start and once a day while listening', async () => {
      const h = harness({ ...seeded(1), enabled: true });

      await h.remote.startIfEnabled();
      expect(h.remote.status().devices).toEqual([]);
      const daily = h.timers.find((t) => t.repeat);
      expect(daily?.ms).toBe(DAY);

      await h.remote.setEnabled(false);
      expect(daily?.cleared).toBe(true);
    });

    it('prunes as soon as auto-unlink is switched back on', async () => {
      const h = harness({ ...seeded(1), autoUnlink: false, enabled: true });
      await h.remote.startIfEnabled();
      expect(h.remote.status().devices).toHaveLength(1);

      expect(h.remote.setAutoUnlink(true).devices).toEqual([]);
      expect(h.stored()?.autoUnlink).toBe(true);
    });
  });

  describe('close', () => {
    it('stops the server for the app shutdown', async () => {
      const h = harness({ enabled: true });
      await h.remote.startIfEnabled();

      h.remote.close();

      expect(h.remote.status().listening).toBe(false);
    });

    it('pushes nothing to the windows, which are being torn down', async () => {
      const h = harness({ enabled: true });
      await h.remote.startIfEnabled();
      h.remote.startPairing();
      h.sent.length = 0;

      h.remote.close();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(h.channels()).toEqual([]);
    });
  });
});

describe('src/main/remote/remote-control.ts — phones', () => {
  /** A device that went through the whole handshake; its session token. */
  async function linked(runtime = fakeRuntime()) {
    const h = harness(undefined, { runtime });
    await h.remote.setEnabled(true);
    const requestId = scanAndRequest(h);
    h.remote.respondPairing(requestId, true);
    const answer = h.api({
      pathname: '/api/pair/status',
      query: new URLSearchParams({ id: requestId }),
    });
    const token = COOKIE.exec(answer.setCookie ?? '')?.[1] ?? '';
    return { h, token, id: h.remote.status().devices[0]?.id ?? '' };
  }

  it('answers the control API to a linked device only', async () => {
    const { h, token } = await linked();

    await expect(
      h.call({ pathname: '/api/state', token }),
    ).resolves.toMatchObject({
      status: 200,
      body: { host: { name: 'mac-de-ana', version: '0.11.0' } },
    });
    await expect(h.call({ pathname: '/api/state' })).resolves.toEqual({
      status: 401,
      body: { error: 'unlinked' },
      setCookie:
        'devbar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  });

  it('still answers 404 for a path nobody serves', async () => {
    const { h, token } = await linked();

    await expect(
      h.call({ pathname: '/api/nope', token }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('opens an event stream for a linked device only', async () => {
    const { h, token } = await linked();

    expect(h.openStream(null).refused).toMatchObject({ status: 401 });
    const stream = h.openStream(token);
    expect(stream.refused).toBeNull();
    expect(stream.chunks[0]).toMatch(/^event: state\n/);
  });

  it('shows the device as connected while it holds a stream', async () => {
    const { h, token } = await linked();

    const stream = h.openStream(token);
    expect(h.remote.status().devices[0]?.connected).toBe(true);
    expect(
      (h.lastOn('remote:changed') as RemoteStatus).devices[0]?.connected,
    ).toBe(true);

    stream.detach?.();
    expect(h.remote.status().devices[0]?.connected).toBe(false);
  });

  it('never prunes a device that holds a stream right now', async () => {
    const { h, token } = await linked();
    h.openStream(token);

    h.advance(31 * DAY);
    h.timers.find((t) => t.repeat && t.ms === DAY)?.fn();

    expect(h.remote.status().devices).toHaveLength(1);
  });

  it('closes the streams of a device unlinked from the desktop, saying why', async () => {
    const { h, token, id } = await linked();
    const stream = h.openStream(token);

    h.remote.unlinkDevice(id);

    expect(stream.chunks.at(-1)).toBe('event: unlinked\ndata: {}\n\n');
    expect(stream.ended()).toBe(true);
  });

  it('closes the streams of a device that unlinked itself', async () => {
    const { h, token } = await linked();
    const stream = h.openStream(token);

    await h.call({ method: 'POST', pathname: '/api/unlink', token, body: {} });

    expect(stream.ended()).toBe(true);
  });

  it('closes every stream when the server stops', async () => {
    const { h, token } = await linked();
    const stream = h.openStream(token);

    await h.remote.setEnabled(false);

    expect(stream.ended()).toBe(true);
  });

  it('closes every stream when the port changes, and the phone stays linked', async () => {
    const { h, token } = await linked();
    const stream = h.openStream(token);

    await h.remote.setPort(50123);

    expect(stream.ended()).toBe(true);
    expect(h.remote.status().devices).toHaveLength(1);
    await expect(
      h.call({ pathname: '/api/state', token }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('closes the desktop request dialog when the phone cancels', async () => {
    const h = harness();
    await h.remote.setEnabled(true);
    const requestId = scanAndRequest(h);

    h.api({
      method: 'POST',
      pathname: '/api/pair/cancel',
      body: { requestId },
    });

    expect(h.lastOn('remote:pairRequestClosed')).toEqual({
      requestId,
      outcome: 'cancelled',
    });
    expect(h.timers.find((t) => t.ms === 60_000)?.cleared).toBe(true);
  });

  it('keeps the notices the notifications hand over', async () => {
    const { h, token } = await linked();

    h.remote.notice({
      title: 'DevBar — pre-scripts',
      body: 'ok',
      action: null,
    });

    await expect(
      h.call({ pathname: '/api/notices', token }),
    ).resolves.toMatchObject({
      body: { notices: [{ kind: 'success', title: 'Pre-scripts' }] },
    });
  });

  it('renames the device a phone asks to rename, and tells the desktop', async () => {
    const { h, token } = await linked();

    await h.call({
      method: 'POST',
      pathname: '/api/device/rename',
      token,
      body: { name: 'Móvil de Ana' },
    });

    expect((h.lastOn('remote:changed') as RemoteStatus).devices[0]?.name).toBe(
      'Móvil de Ana',
    );
  });
});

describe('remoteControlDeps', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  function wiring() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-remote-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'remote.html'), '<p>hi</p>');
    let saved: RemoteControlState | null = null;
    const sent: unknown[] = [];
    const registry = createWindowRegistry(() => null);
    registry.config = {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => sent.push(args) },
      setBackgroundColor: () => undefined,
      getTitle: () => '',
      show: () => undefined,
      focus: () => undefined,
    };
    const app = fakeAppWiring().wiring;
    const deps = remoteControlDeps({
      ...app,
      host: {
        ...app.host,
        rendererFile: (name) => path.join(dir, name),
        appVersion: () => '0.11.0',
      },
      configStore: {
        ...app.configStore,
        getRemoteControl: () => ({ enabled: true }),
        saveRemoteControl: (state) => {
          saved = state;
        },
      },
      registry,
    });
    return { deps, sent, saved: () => saved };
  }

  it('reads whitelisted build files through the renderer directory', () => {
    const { deps } = wiring();

    expect(deps.readStatic('remote.html')?.toString()).toBe('<p>hi</p>');
    expect(deps.readStatic('missing.js')).toBeNull();
  });

  it('pushes to the app windows and persists through the config store', () => {
    const { deps, sent, saved } = wiring();
    const state: RemoteControlState = {
      enabled: false,
      autoUnlink: true,
      port: 47821,
      devices: [],
    };

    deps.send('remote:changed', { x: 1 });
    deps.writeState(state);

    expect(sent).toEqual([['remote:changed', { x: 1 }]]);
    expect(saved()).toEqual(state);
    expect(deps.readState()).toEqual({ enabled: true });
  });

  it('names the host without its local domain', () => {
    const { deps } = wiring();

    expect(deps.hostName()).toBe(os.hostname().split('.')[0]);
    expect(deps.appVersion()).toBe('0.11.0');
    expect(typeof deps.networkInterfaces()).toBe('object');
  });
});
