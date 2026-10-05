import { describe, expect, it } from 'vitest';
import { createSessionApi, type RpcCall } from '../src/main/remote/api.js';
import { createDeviceStore } from '../src/main/remote/device-store.js';
import { createPairing } from '../src/main/remote/pairing.js';
import { createRateLimiter } from '../src/main/remote/rate-limit.js';
import {
  authMessage,
  generateIdentity,
  identityFromSeed,
  toB64,
} from '../src/main/remote/rc-protocol.js';
import type { Session } from '../src/main/remote/sessions.js';
import type { RemotePairRequest } from '../src/ipc-contract/remote-api.js';

/**
 * The session-level operations of devbar-rc/1, as plain functions of an
 * already-decrypted call: what an unauthenticated session may do (who am I
 * talking to, pairing), how a device proves who it is (`auth`), and what
 * only a proven device may do to itself (unlink, verify, rotate its key).
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let sessions = 0;
function session(): Session {
  sessions += 1;
  return {
    id: `sid-${sessions}`,
    ip: '192.168.1.40',
    transcript: Buffer.from(`transcript-${sessions}`),
    deviceId: null,
    logsId: null,
    open: () => null,
    seal: () => ({ n: 1, ct: '' }),
    sealEvent: () => '',
  };
}

function deviceKey() {
  const { seed, publicKey } = generateIdentity();
  const signer = identityFromSeed(seed);
  return {
    pub: toB64(publicKey),
    /** The auth proof over this session's transcript. */
    prove: (on: Session) => toB64(signer.sign(authMessage(on.transcript))),
  };
}

function harness() {
  let clock = 10_000_000;
  const now = () => clock;
  const events: string[] = [];
  const requests: RemotePairRequest[] = [];
  const devices = createDeviceStore({
    read: () => undefined,
    write: () => undefined,
    now,
  });
  const pairing = createPairing({ now });
  const api = createSessionApi({
    devices,
    pairing,
    limiter: createRateLimiter({ limit: 5, windowMs: 60_000, now }),
    hostInfo: () => ({ name: 'mac-de-ana', version: '0.11.0' }),
    devicesChanged: () => events.push('changed'),
    pairRequested: (request) => {
      events.push('pairRequested');
      requests.push(request);
    },
    pairWithdrawn: (requestId) => events.push(`withdrawn:${requestId}`),
    deviceUnlinked: (id) => events.push(`unlinked:${id}`),
    deviceRotated: (id) => events.push(`rotated:${id}`),
    deviceAuthenticated: (id, ip) => events.push(`authenticated:${id}@${ip}`),
  });
  const callOn = (on: Session, op: string, args: unknown = {}) => {
    const call: RpcCall = { session: on, ip: on.ip, userAgent: IPHONE_UA };
    return api.handle(op, args, call);
  };
  const call = (op: string, args: unknown = {}) => callOn(session(), op, args);
  /** Pairing up to the desktop's decision; the phone's request id. */
  const request = (key = deviceKey(), on = session()) => {
    const { code } = pairing.startPairing();
    const answer = callOn(on, 'pair.request', {
      code,
      name: 'iPhone de Ana',
      devicePub: key.pub,
    });
    return (answer.body as { requestId: string }).requestId;
  };
  /** The whole pairing, accepted; then an authenticated session. */
  const link = () => {
    const key = deviceKey();
    const requestId = request(key);
    pairing.respond(requestId, true);
    const answer = call('pair.status', { requestId });
    const deviceId = (answer.body as { deviceId: string }).deviceId;
    const on = session();
    callOn(on, 'auth', { deviceId, sig: key.prove(on) });
    return { key, deviceId, session: on };
  };
  return {
    api,
    call,
    callOn,
    devices,
    pairing,
    events,
    requests,
    request,
    link,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('src/main/remote/api.ts', () => {
  it('knows exactly the session-level operations', () => {
    const { api } = harness();
    for (const op of [
      'me',
      'pair.request',
      'pair.status',
      'pair.cancel',
      'auth',
      'unlink',
      'verify.done',
      'device.rotate',
    ])
      expect(api.handles(op), op).toBe(true);
    expect(api.handles('state')).toBe(false);
  });

  describe('me', () => {
    it('tells an unauthenticated session the host name and a name to suggest', () => {
      const h = harness();

      expect(h.call('me')).toEqual({
        status: 200,
        body: {
          linked: false,
          host: { name: 'mac-de-ana' },
          suggestedName: 'iPhone',
        },
      });
    });

    it('describes the device an authenticated session proved to be', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();

      expect(h.callOn(on, 'me')).toEqual({
        status: 200,
        body: {
          linked: true,
          device: {
            id: deviceId,
            name: 'iPhone de Ana',
            createdAt: 10_000_000,
          },
          host: { name: 'mac-de-ana', version: '0.11.0' },
        },
      });
    });
  });

  describe('pair.request', () => {
    it('opens a request for a valid code and tells the desktop', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();

      const answer = h.call('pair.request', {
        code,
        name: '  iPhone de Ana ',
        devicePub: deviceKey().pub,
      });

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        requestId: expect.any(String) as unknown,
        verificationCode: expect.stringMatching(/^\d{6}$/) as unknown,
      });
      expect(h.requests[0]).toMatchObject({
        name: 'iPhone de Ana',
        client: 'Safari · iOS',
        ip: '192.168.1.40',
      });
      expect(h.events).toEqual(['pairRequested']);
    });

    it('answers 410 with the reason for a used or unknown code', () => {
      const h = harness();
      const pub = deviceKey().pub;

      expect(
        h.call('pair.request', { code: 'nope', name: 'x', devicePub: pub }),
      ).toEqual({ status: 410, body: { error: 'invalid' } });
    });

    it('refuses an invalid name or key before spending the code', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();

      expect(
        h.call('pair.request', { code, name: '', devicePub: deviceKey().pub }),
      ).toEqual({ status: 400, body: { error: 'invalid-name' } });
      expect(
        h.call('pair.request', { code, name: 'x', devicePub: 'short' }),
      ).toEqual({ status: 400, body: { error: 'invalid-request' } });
      expect(h.pairing.hasActiveCode()).toBe(true);
    });

    it('allows five attempts a minute per address, then answers 429', () => {
      const h = harness();
      for (let i = 0; i < 5; i++)
        h.call('pair.request', { code: 'x', name: 'n', devicePub: 'x' });

      expect(
        h.call('pair.request', { code: 'x', name: 'n', devicePub: 'x' }),
      ).toEqual({ status: 429, body: { error: 'rate-limited' } });
    });
  });

  describe('pair.status', () => {
    it('reports pending, then creates the device with its key exactly once', () => {
      const h = harness();
      const key = deviceKey();
      const requestId = h.request(key);

      expect(h.call('pair.status', { requestId })).toEqual({
        status: 200,
        body: { status: 'pending' },
      });
      h.pairing.respond(requestId, true);
      const answer = h.call('pair.status', { requestId });

      const deviceId = h.devices.list()[0]?.id;
      expect(answer).toEqual({
        status: 200,
        body: { status: 'accepted', deviceId },
      });
      expect(h.devices.devicePub(deviceId ?? '')).toBe(key.pub);
      expect(h.call('pair.status', { requestId })).toEqual({
        status: 404,
        body: { error: 'unknown-request' },
      });
      expect(h.devices.list()).toHaveLength(1);
    });

    it('reports a rejection without creating anything', () => {
      const h = harness();
      const requestId = h.request();
      h.pairing.respond(requestId, false);

      expect(h.call('pair.status', { requestId })).toEqual({
        status: 200,
        body: { status: 'rejected' },
      });
      expect(h.devices.list()).toEqual([]);
    });

    it('answers 400 without a request id', () => {
      expect(harness().call('pair.status', {})).toEqual({
        status: 400,
        body: { error: 'invalid-request' },
      });
    });
  });

  describe('pair.cancel', () => {
    it('withdraws the pending request so the desktop can close its dialog', () => {
      const h = harness();
      const requestId = h.request();

      expect(h.call('pair.cancel', { requestId })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(h.events).toContain(`withdrawn:${requestId}`);
      expect(h.call('pair.cancel', { requestId }).status).toBe(404);
      expect(h.call('pair.cancel', {}).status).toBe(400);
    });
  });

  describe('auth', () => {
    it('binds the session to the device whose key signed this handshake', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();

      expect(on.deviceId).toBe(deviceId);
      expect(h.events).toContain(`authenticated:${deviceId}@192.168.1.40`);
    });

    it('refuses a proof made for another handshake', () => {
      const h = harness();
      const { key, deviceId } = h.link();
      const elsewhere = session();
      const on = session();

      expect(
        h.callOn(on, 'auth', { deviceId, sig: key.prove(elsewhere) }),
      ).toEqual({ status: 401, body: { error: 'unlinked' } });
      expect(on.deviceId).toBeNull();
    });

    it('refuses another key, an unknown device and a malformed proof alike', () => {
      const h = harness();
      const { deviceId } = h.link();
      const on = session();

      for (const args of [
        { deviceId, sig: deviceKey().prove(on) },
        { deviceId: 'ghost', sig: deviceKey().prove(on) },
        { deviceId, sig: 'short' },
        {},
      ])
        expect(h.callOn(on, 'auth', args)).toEqual({
          status: 401,
          body: { error: 'unlinked' },
        });
      expect(on.deviceId).toBeNull();
      expect(
        h.events.filter((e) => e.startsWith('authenticated:')),
      ).toHaveLength(1);
    });
  });

  describe('unlink', () => {
    it('removes the calling device and tells the live layer', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      h.events.length = 0;

      expect(h.callOn(on, 'unlink')).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(h.devices.list()).toEqual([]);
      expect(h.events).toEqual([`unlinked:${deviceId}`, 'changed']);
    });

    it('answers 401 to a session that is not a linked device', () => {
      expect(harness().call('unlink')).toEqual({
        status: 401,
        body: { error: 'unlinked' },
      });
    });
  });

  describe('verify.done', () => {
    it('records that this device verified the security code', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      h.advance(5000);

      expect(h.callOn(on, 'verify.done')).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(h.devices.find(deviceId)?.verifiedAt).toBe(10_005_000);
      expect(h.events.at(-1)).toBe('changed');
      expect(h.call('verify.done').status).toBe(401);
    });
  });

  describe('device.rotate', () => {
    it('replaces the key, unverifies the device and drops its sessions', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      h.callOn(on, 'verify.done');
      const next = deviceKey();
      h.events.length = 0;

      expect(h.callOn(on, 'device.rotate', { devicePub: next.pub })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(h.devices.devicePub(deviceId)).toBe(next.pub);
      expect(h.devices.find(deviceId)?.verifiedAt).toBeNull();
      expect(h.events).toEqual([`rotated:${deviceId}`, 'changed']);

      // From now on only the new key proves who the device is.
      const fresh = session();
      expect(
        h.callOn(fresh, 'auth', { deviceId, sig: next.prove(fresh) }).status,
      ).toBe(200);
    });

    it('refuses a malformed key, and an unauthenticated session', () => {
      const h = harness();
      const { session: on } = h.link();

      expect(h.callOn(on, 'device.rotate', { devicePub: 'x' })).toEqual({
        status: 400,
        body: { error: 'invalid-request' },
      });
      expect(
        h.call('device.rotate', { devicePub: deviceKey().pub }).status,
      ).toBe(401);
    });
  });
});
