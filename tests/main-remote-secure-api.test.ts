import { describe, expect, it } from 'vitest';
import type { ApiResponse, RpcCall } from '../src/main/remote/api.js';
import type { EventSink } from '../src/main/remote/events.js';
import { createIdentityKeys } from '../src/main/remote/identity.js';
import { createRateLimiter } from '../src/main/remote/rate-limit.js';
import {
  ephemeralKeyPair,
  generateIdentity,
  toB64,
} from '../src/main/remote/rc-protocol.js';
import { createSecureApi } from '../src/main/remote/secure-api.js';
import { createSessionTable } from '../src/main/remote/sessions.js';
import type { StoredIdentity } from '../src/main/remote/device-store.js';
import type { RemoteDeviceView } from '../src/ipc-contract/remote-api.js';
import { createChannel, RemoteError } from '../renderer/remote/channel.js';
import { fromB64 } from '../renderer/remote/rc-protocol.js';
import { bridge } from './helpers/rc-bridge.js';

/**
 * The encrypted transport of «Control remoto» (POST /api/hello, POST
 * /api/rpc, GET /api/events), driven by the phone's own channel code
 * (renderer/remote/channel.ts, @noble) against the desktop's (node:crypto):
 * a handshake, sealed calls both ways, sealed events, and every way a
 * message can be refused.
 */

const DEVICE: RemoteDeviceView = {
  id: 'd1',
  name: 'iPhone',
  client: 'Safari · iOS',
  createdAt: 1,
  lastSeenAt: 1,
  verifiedAt: null,
};

function harness(options: { perIp?: number; helloLimit?: number } = {}) {
  let clock = 1_000_000;
  let stored: StoredIdentity | null = null;
  const identity = createIdentityKeys({
    read: () => stored,
    write: (record) => {
      stored = record;
    },
    secretBox: null,
  });
  const sessions = createSessionTable({
    now: () => clock,
    ...(options.perIp ? { perIp: options.perIp } : {}),
  });
  const calls: { op: string; args: unknown; call: RpcCall }[] = [];
  const sinks: EventSink[] = [];
  let answer: ApiResponse = { status: 200, body: { hello: 'phone' } };
  const secure = createSecureApi({
    identity,
    sessions,
    limiter: createRateLimiter({
      limit: options.helloLimit ?? 30,
      windowMs: 60_000,
      now: () => clock,
    }),
    dispatch: (op, args, call) => {
      calls.push({ op, args, call });
      // A stand-in for `auth`: the session becomes device d1.
      if (op === 'auth') call.session.deviceId = 'd1';
      return Promise.resolve(answer);
    },
    stream: (session, device) => ({
      open: (sink) => {
        sinks.push(sink);
        sink.event('state', { for: device.id, session: session.id });
        return () => undefined;
      },
    }),
    device: (id) => (id === 'd1' ? DEVICE : null),
  });
  const net = bridge(() => ({
    api: (request) => secure.route(request),
    stream: (request) => secure.events(request),
  }));
  const channel = createChannel(net.fetch);
  /** A channel shaken hands with this desktop's real key. */
  const connected = async () => {
    await channel.open(identity.publicKey());
    return channel;
  };
  const post = (
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DevBar-Request': '1',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return {
    secure,
    sessions,
    identity,
    net,
    channel,
    connected,
    calls,
    sinks,
    post,
    answer: (next: ApiResponse) => {
      answer = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RemoteError ? error.code : String(error);
  }
  return 'resolved';
}

describe('src/main/remote/secure-api.ts', () => {
  describe('POST /api/hello', () => {
    it('shakes hands under the identity the phone expects', async () => {
      const h = harness();

      await h.connected();

      expect(h.channel.ready()).toBe(true);
      expect(h.sessions.size()).toBe(1);
    });

    it('lets the phone notice a different identity (a changed key)', async () => {
      const h = harness();

      expect(
        await errorCode(h.channel.open(generateIdentity().publicKey)),
      ).toBe('changed');
      expect(h.channel.ready()).toBe(false);
    });

    it('refuses a malformed or low-order client key, or another version', async () => {
      const h = harness();
      const c = toB64(ephemeralKeyPair().publicKey);

      for (const body of [
        { v: 2, c },
        { v: 1, c: 'short' },
        { v: 1, c: toB64(Buffer.alloc(32)) },
        'junk',
      ])
        expect((await h.post('/api/hello', body)).status).toBe(400);
      expect(h.sessions.size()).toBe(0);
    });

    it('rate-limits handshakes per address', async () => {
      const h = harness({ helloLimit: 2 });
      await h.connected();
      await h.connected();

      expect(await errorCode(h.connected())).toBe('http');
      const reply = await h.post('/api/hello', {
        v: 1,
        c: toB64(ephemeralKeyPair().publicKey),
      });
      expect(reply.status).toBe(429);
    });

    it('answers 503 when every session at the cap is streaming', async () => {
      const h = harness({ perIp: 1 });
      const channel = await h.connected();
      await channel.send('auth', {});
      const reader = channel.events();
      h.net.openStream(reader?.url ?? '');

      const reply = await h.post('/api/hello', {
        v: 1,
        c: toB64(ephemeralKeyPair().publicKey),
      });
      expect(reply.status).toBe(503);
    });
  });

  describe('POST /api/rpc', () => {
    it('opens the call, dispatches it and seals the answer', async () => {
      const h = harness();
      const channel = await h.connected();

      const answer = await channel.send('me', { a: 1 });

      expect(answer).toEqual({ status: 200, body: { hello: 'phone' } });
      expect(h.calls[0]).toMatchObject({ op: 'me', args: { a: 1 } });
      expect(h.calls[0]?.call.ip).toBe('192.168.1.40');
      // Nothing readable crossed the wire.
      expect(JSON.stringify(h.net.log)).not.toContain('phone');
    });

    it('answers 401 session for an unknown or expired session', async () => {
      const h = harness();
      const channel = await h.connected();
      h.advance(11 * 60_000);

      expect(await errorCode(channel.send('me'))).toBe('session');
      expect(channel.ready()).toBe(false);
      const reply = await h.post('/api/rpc', { n: 1, ct: 'AA' });
      expect(reply.status).toBe(401);
      await expect(reply.json()).resolves.toEqual({ error: 'session' });
    });

    it('refuses a replayed, tampered or misdirected message with a bare 400', async () => {
      const h = harness();
      const channel = await h.connected();
      const other = createChannel(h.net.fetch);
      await other.open(h.identity.publicKey());
      await other.send('me');
      await channel.send('me');
      const sent = h.net.log.at(-1);
      const captured = h.net.sent.at(-1);
      if (!sent?.sessionId || !captured) throw new Error('nothing captured');
      const headers = { 'X-DevBar-Session': sent.sessionId };

      const replayed = await h.post('/api/rpc', captured, headers);
      const bytes = fromB64(captured.ct) ?? new Uint8Array();
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      const tampered = await h.post(
        '/api/rpc',
        { n: captured.n + 1, ct: toB64(bytes) },
        headers,
      );
      const otherSid = h.net.log.find(
        (entry) => entry.sessionId && entry.sessionId !== sent.sessionId,
      )?.sessionId;
      const misdirected = await h.post(
        '/api/rpc',
        { ...captured, n: captured.n },
        { 'X-DevBar-Session': otherSid ?? '' },
      );

      for (const reply of [replayed, tampered, misdirected]) {
        expect(reply.status).toBe(400);
        await expect(reply.json()).resolves.toEqual({ error: 'bad-request' });
      }
      expect(h.calls).toHaveLength(2);
    });

    it('refuses a body that is not a counter and a ciphertext', async () => {
      const h = harness();
      const channel = await h.connected();
      const sid = channel.events()?.url.split('=')[1] ?? '';
      const session = { 'X-DevBar-Session': sid };

      for (const body of [
        {},
        { n: 0, ct: 'AA' },
        { n: 1.5, ct: 'AA' },
        { n: 1, ct: '%' },
      ])
        expect((await h.post('/api/rpc', body, session)).status).toBe(400);
    });

    it('answers 404 elsewhere under /api and 405 to a GET of a POST route', async () => {
      const h = harness();

      expect((await h.post('/api/me', {})).status).toBe(404);
      expect((await h.net.fetch('/api/rpc')).status).toBe(405);
    });
  });

  describe('GET /api/events', () => {
    it('streams sealed events the phone can open, sharing the reply counter', async () => {
      const h = harness();
      const channel = await h.connected();
      await channel.send('auth', {});
      const reader = channel.events();
      if (!reader) throw new Error('no reader');

      const stream = h.net.openStream(reader.url);
      h.sinks[0]?.heartbeat();
      h.sinks[0]?.event('notice', { title: 'Hola' });
      await channel.send('me');
      h.sinks[0]?.event('log', { id: 'x' });

      expect(stream.refused).toBeNull();
      expect(stream.chunks).toContain(': heartbeat\n\n');
      expect(stream.frames.map((frame) => reader.read(frame))).toEqual([
        {
          type: 'state',
          data: { for: 'd1', session: reader.url.split('=')[1] },
        },
        { type: 'notice', data: { title: 'Hola' } },
        { type: 'log', data: { id: 'x' } },
      ]);
      // Event types travel sealed too.
      expect(stream.chunks.join('')).not.toContain('notice');
      // A frame read twice is a replay.
      expect(reader.read(stream.frames[0])).toBeNull();
    });

    it('keeps a streaming session alive past the idle timeout', async () => {
      const h = harness();
      const channel = await h.connected();
      await channel.send('auth', {});
      h.net.openStream(channel.events()?.url ?? '');

      h.advance(30 * 60_000);

      await expect(channel.send('me')).resolves.toMatchObject({ status: 200 });
    });

    it('refuses an unknown session, an unauthenticated one and any other query', async () => {
      const h = harness();
      const channel = await h.connected();
      const url = channel.events()?.url ?? '';

      expect(h.net.openStream(url).refused).toEqual({
        status: 403,
        body: { error: 'forbidden' },
      });
      expect(
        h.net.openStream('/api/events?sid=AAAAAAAAAAAAAAAAAAAAAA').refused,
      ).toEqual({ status: 401, body: { error: 'session' } });
      await channel.send('auth', {});
      expect(h.net.openStream(`${url}&logs=x`).refused).toMatchObject({
        status: 400,
      });
      expect(h.net.openStream('/api/events').refused).toMatchObject({
        status: 401,
      });
    });
  });
});
