import { startRemoteApp, type RemoteEnv } from '../../renderer/remote/app.js';
import type { EventSourceLike } from '../../renderer/remote/connection.js';
import {
  generateSigningKey,
  toB64,
} from '../../renderer/remote/rc-protocol.js';
import type { ApiRequest } from '../../src/main/remote/api.js';
import type { EventSink } from '../../src/main/remote/events.js';
import { readSessionId } from '../../src/main/remote/http-guard.js';
import { createIdentityKeys } from '../../src/main/remote/identity.js';
import { createRateLimiter } from '../../src/main/remote/rate-limit.js';
import {
  authMessage,
  fromB64,
  verifySignature,
} from '../../src/main/remote/rc-protocol.js';
import { createSecureApi } from '../../src/main/remote/secure-api.js';
import { createSessionTable } from '../../src/main/remote/sessions.js';
import type { StoredIdentity } from '../../src/main/remote/device-store.js';
import type { RemoteStateView } from '../../src/ipc-contract/remote-wire.js';
import { LINKED, loadPage, NOW, settle, state } from './remote-page-dom.js';

export {
  buttonNamed,
  byId,
  CONFIRM,
  LINKED,
  loadPage,
  NOW,
  settle,
  state,
  tabButton,
  tap,
  tapId,
  text,
  UNLINKED,
  visibleTab,
  visibleView,
} from './remote-page-dom.js';

/**
 * The phone page (renderer/remote.html + renderer/remote/*) driven against a
 * real devbar-rc/1 server: the desktop's own secure layer and session table
 * (node:crypto), with a scripted dispatcher in place of DevBar — each
 * operation answered from a queue the test fills. Everything the page sends
 * and receives is sealed for real, so these tests run the phone's @noble
 * crypto against the desktop's on every call.
 *
 * Around it, fakes of what the browser provides: an EventSource the test
 * emits on (each event sealed through the session's own stream), timers and
 * intervals run by hand, a localStorage map and a fixed clock.
 */

/** One decrypted call the page made: the operation and its arguments. */
interface Call {
  op: string;
  body: unknown;
}

type Answer = { status: number; body: unknown } | Error;

export interface FakeSource extends EventSourceLike {
  url: string;
  closed: boolean;
  /** What the server answered instead of a stream, if it refused one. */
  refused: unknown;
  /**
   * `open` and `error` are the EventSource's own; any other type is a
   * DevBar event, sealed by the session and delivered as `event: m`.
   * Strings are taken as JSON, like the old wire format.
   */
  emit(type: string, data?: unknown): void;
}

const KEYS_RECORD = 'devbar.remote.keys';
const DEVICE_ID = 'd1';

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

/** Parses one sealed SSE frame back into its `data:` payload. */
const frameData = (chunk: string): string | null =>
  chunk.startsWith('event: m\n')
    ? (chunk.split('\n')[1]?.slice('data: '.length) ?? null)
    : null;

/** The storage a page gets: a map, or one that refuses all but the keys. */
function fakeStorage(option: Map<string, string> | 'broken') {
  const map = option === 'broken' ? new Map<string, string>() : option;
  // 'broken' refuses everything but the device keys, which a linked page
  // needs to exist at all: it is the read marks' fallbacks under test.
  const guard = (key: string): void => {
    if (option === 'broken' && key !== KEYS_RECORD)
      throw new Error('SecurityError: storage is disabled');
  };
  return {
    map,
    storage: () => ({
      getItem: (key: string) => {
        guard(key);
        return map.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        guard(key);
        map.set(key, value);
      },
      removeItem: (key: string) => {
        guard(key);
        map.delete(key);
      },
    }),
  };
}

export function pageHarness(
  location = '/',
  options: { storage?: Map<string, string> | 'broken' } = {},
) {
  const calls: Call[] = [];
  const answers = new Map<string, Answer[]>();
  /** The last answer of an operation keeps answering once its queue runs dry. */
  const sticky = new Map<string, Answer>();
  const timeouts: Timer[] = [];
  const intervals: Timer[] = [];
  const sources: FakeSource[] = [];
  const urls: string[] = [];
  const confirms: string[] = [];
  const kept = fakeStorage(options.storage ?? new Map<string, string>());
  /** The devices this fake DevBar knows: id → public key (base64url). */
  const devices = new Map<string, string>();
  let confirmAnswer = true;
  let reloads = 0;
  let hellos = 0;
  let clock = NOW;

  let identityRecord: StoredIdentity | null = null;
  const identity = createIdentityKeys({
    read: () => identityRecord,
    write: (record) => {
      identityRecord = record;
    },
    secretBox: null,
  });
  const sessions = createSessionTable({ now: () => clock });
  /** The sealing sink of each open stream, by its fake EventSource. */
  const sinks = new Map<FakeSource, EventSink>();
  let pendingSink: EventSink | null = null;

  /** `auth` checks the proof for real against the devices it knows. */
  const authAnswer = (args: unknown, transcript: Buffer): Answer => {
    const { deviceId, sig } = (args ?? {}) as Record<string, unknown>;
    const key = fromB64(devices.get(String(deviceId)), 32);
    const signature = fromB64(sig, 64);
    return key &&
      signature &&
      verifySignature(key, authMessage(transcript), signature)
      ? { status: 200, body: { ok: true } }
      : { status: 401, body: { error: 'unlinked' } };
  };

  const secure = createSecureApi({
    identity,
    sessions,
    limiter: createRateLimiter({
      limit: 1000,
      windowMs: 60_000,
      now: () => clock,
    }),
    dispatch: (op, args, call) => {
      calls.push({ op, body: args });
      const reply =
        answers.get(op)?.shift() ??
        sticky.get(op) ??
        (op === 'auth' ? authAnswer(args, call.session.transcript) : null) ??
        (op === 'logs.subscribe' ? { status: 200, body: { ok: true } } : null);
      if (reply && op !== 'auth') sticky.set(op, reply);
      if (!reply) return Promise.reject(new Error(`no answer for ${op}`));
      if (reply instanceof Error) return Promise.reject(reply);
      const given = (args ?? {}) as Record<string, unknown>;
      if (op === 'auth' && reply.status === 200)
        call.session.deviceId = String(given.deviceId);
      // Like the real DevBar: from now on only the new key signs in.
      if (
        op === 'device.rotate' &&
        reply.status === 200 &&
        call.session.deviceId
      )
        devices.set(call.session.deviceId, String(given.devicePub));
      return Promise.resolve(reply);
    },
    stream: () => ({
      open: (sink) => {
        pendingSink = sink;
        return () => undefined;
      },
    }),
    device: (id) =>
      devices.has(id)
        ? {
            id,
            name: 'iPhone de Ana',
            client: 'Safari · iOS',
            createdAt: 1,
            lastSeenAt: 1,
            verifiedAt: null,
          }
        : null,
  });

  const toRequest = (url: string, init?: RequestInit): ApiRequest => {
    const parsed = new URL(url, 'http://192.168.1.20:47821');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    return {
      method,
      pathname: parsed.pathname,
      query: parsed.searchParams,
      sessionId: readSessionId(headers['X-DevBar-Session']),
      ip: '192.168.1.40',
      userAgent: 'iPhone',
      body:
        method === 'POST'
          ? (JSON.parse(String(init?.body)) as unknown)
          : undefined,
    };
  };

  const answer = (op: string, ...replies: Answer[]): void => {
    answers.set(op, [...(answers.get(op) ?? []), ...replies]);
  };
  const parsedLocation = new URL(location, 'http://192.168.1.20:47821');
  const env: RemoteEnv = {
    fetch: async (url, init) => {
      const request = toRequest(url, init);
      if (request.pathname === '/api/hello') hellos += 1;
      const reply = await secure.route(request);
      const body = JSON.parse(JSON.stringify(reply.body)) as unknown;
      return { status: reply.status, json: () => Promise.resolve(body) };
    },
    pathname: parsedLocation.pathname,
    search: parsedLocation.search,
    hash: parsedLocation.hash,
    hostname: '192.168.1.20',
    replaceUrl: (url) => urls.push(url),
    confirm: (message) => {
      confirms.push(message);
      return confirmAnswer;
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      if (handle) (handle as Timer).cleared = true;
    },
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (handle) => {
      if (handle) (handle as Timer).cleared = true;
    },
    now: () => clock,
    openEvents: (url) => {
      const listeners = new Map<
        string,
        ((event: { data?: unknown }) => void)[]
      >();
      const dispatch = (type: string, payload: { data?: unknown }) => {
        for (const listener of listeners.get(type) ?? []) listener(payload);
      };
      const source: FakeSource = {
        url,
        closed: false,
        refused: null,
        addEventListener: (type, listener) =>
          listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        close: () => {
          source.closed = true;
        },
        emit: (type, data) => {
          if (type === 'open' || type === 'error') {
            dispatch(type, {});
            return;
          }
          const value: unknown =
            typeof data === 'string' ? JSON.parse(data) : (data ?? {});
          sinks.get(source)?.event(type, value);
        },
      };
      const answerTo = secure.events(toRequest(url));
      if ('open' in answerTo) {
        answerTo.open({
          write: (chunk) => {
            const payload = frameData(chunk);
            if (payload !== null) dispatch('m', { data: payload });
            return true;
          },
          end: () => undefined,
        });
        if (pendingSink) sinks.set(source, pendingSink);
        pendingSink = null;
      } else source.refused = answerTo;
      sources.push(source);
      return source;
    },
    storage: kept.storage,
    reload: () => {
      reloads += 1;
    },
  };
  return {
    env,
    calls,
    answer,
    urls,
    confirms,
    sources,
    storage: options.storage === 'broken' ? null : kept.map,
    /** The identity key this fake DevBar signs with, base64url. */
    serverKey: () => toB64(identity.publicKey()),
    /** A new identity key, as «Renovar clave del equipo» makes. */
    renewIdentity: () => {
      identity.renew();
      sessions.dropAll();
    },
    /** DevBar forgets every session (a restart, an idle expiry). */
    dropSessions: () => sessions.dropAll(),
    /** A device this DevBar knows; returns its keys. */
    addDevice: (id = DEVICE_ID) => {
      const key = generateSigningKey();
      devices.set(id, toB64(key.publicKey));
      return key;
    },
    forgetDevice: (id = DEVICE_ID) => devices.delete(id),
    /** DevBar learns a device's key, as accepting a pairing does. */
    knowDevice: (id: string, devicePub: string) => devices.set(id, devicePub),
    /** Stores linked-device keys for this DevBar in the page's storage. */
    seedKeys: (extra: Record<string, unknown> = {}) => {
      const key = generateSigningKey();
      devices.set(DEVICE_ID, toB64(key.publicKey));
      kept.map.set(
        KEYS_RECORD,
        JSON.stringify({
          serverIdPub: toB64(identity.publicKey()),
          deviceId: DEVICE_ID,
          devicePriv: toB64(key.secretKey),
          devicePub: toB64(key.publicKey),
          verified: false,
          hostName: 'Mac-de-Ana',
          ...extra,
        }),
      );
      return key;
    },
    /** What the page keeps as its device keys, parsed. */
    keys: () => {
      const raw = kept.map.get(KEYS_RECORD);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    hellos: () => hellos,
    refuseConfirm: () => {
      confirmAnswer = false;
    },
    /** The open (latest) event stream. */
    source: (): FakeSource => {
      const latest = sources.at(-1);
      if (!latest) throw new Error('no event stream was opened');
      return latest;
    },
    /** Runs the next pending one-shot timer and lets its work settle. */
    tick: async () => {
      const timer = timeouts.find((t) => !t.cleared);
      if (!timer) throw new Error('nothing scheduled');
      timer.cleared = true;
      timer.fn();
      await settle();
    },
    /** Runs every live interval once (the page's 1 s clock). */
    beat: () => {
      for (const timer of intervals.filter((t) => !t.cleared)) timer.fn();
    },
    pending: () => timeouts.filter((t) => !t.cleared).length,
    advance: (ms: number) => {
      clock += ms;
    },
    reloads: () => reloads,
    callsTo: (op: string) => calls.filter((call) => call.op === op),
    lastCall: () => calls.at(-1),
  };
}

export type PageHarness = ReturnType<typeof pageHarness>;

export async function start(h: PageHarness): Promise<void> {
  void startRemoteApp(h.env);
  await settle();
}

/** A pairing page opened from the QR: the code, and this DevBar's key. */
export function pairingHarness(
  code = 'CODE',
  options: Parameters<typeof pageHarness>[1] = {},
) {
  const h = pageHarness(`/pair?c=${code}`, options);
  h.env.hash = `#k=${h.serverKey()}`;
  return h;
}

/** A linked phone with the panel up, its first stream open and live. */
export async function startLinked(
  initial: RemoteStateView = state(),
  options: Parameters<typeof pageHarness>[1] = {},
): Promise<PageHarness> {
  loadPage();
  const h = pageHarness('/', options);
  h.seedKeys();
  h.answer('me', LINKED);
  h.answer('state', { status: 200, body: initial });
  h.answer('notices', { status: 200, body: { notices: [] } });
  await start(h);
  h.source().emit('open');
  return h;
}
