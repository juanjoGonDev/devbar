import { describe, expect, it } from 'vitest';
import { createSessionApi, type RpcCall } from '../src/main/remote/api.js';
import { createDeviceStore } from '../src/main/remote/device-store.js';
import { createPairing } from '../src/main/remote/pairing.js';
import { createRateLimiter } from '../src/main/remote/rate-limit.js';
import {
  authMessage,
  generateIdentity,
  identityFromSeed,
  pairMessage,
  replaceMessage,
  rotateMessage,
  toB64,
} from '../src/main/remote/rc-protocol.js';
import type { Session } from '../src/main/remote/sessions.js';
import { createVerifyTokens } from '../src/main/remote/verify-tokens.js';
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
    pairClaimed: false,
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
    /** The auth proof of `deviceId` over this session's transcript. */
    prove: (on: Session, deviceId: string) =>
      toB64(signer.sign(authMessage(deviceId, on.transcript))),
    /** Proof that this new key is held, asking to be paired. */
    pairProof: (on: Session) => toB64(signer.sign(pairMessage(on.transcript))),
    /** Proof that this new key is held, replacing a device's key. */
    rotateProof: (on: Session) =>
      toB64(signer.sign(rotateMessage(on.transcript))),
    /** Proof by this (old) key that a new pairing replaces its device. */
    replaceProof: (on: Session) =>
      toB64(signer.sign(replaceMessage(on.transcript))),
  };
}

/** The identity point: OpenSSL takes R = identity, S = 0 as its signature. */
const WEAK_KEY = toB64(Buffer.from([1, ...new Array<number>(31).fill(0)]));
const FORGED_SIG = toB64(Buffer.from([1, ...new Array<number>(63).fill(0)]));

/** A linked device: its key and its id. */
interface Linked {
  key: ReturnType<typeof deviceKey>;
  deviceId: string;
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
  const tokens = createVerifyTokens({ now });
  const api = createSessionApi({
    devices,
    pairing,
    verifyTokens: tokens,
    limiter: createRateLimiter({ limit: 5, windowMs: 60_000, now }),
    hostInfo: () => ({ name: 'mac-de-ana', version: '0.11.0' }),
    devicesChanged: () => events.push('changed'),
    pairRequested: (request) => {
      events.push('pairRequested');
      requests.push(request);
    },
    pairWithdrawn: (requestId) => events.push(`withdrawn:${requestId}`),
    pairClaimed: () => events.push('pairClaimed'),
    deviceUnlinked: (id) => events.push(`unlinked:${id}`),
    deviceRotated: (id) => events.push(`rotated:${id}`),
    deviceAuthenticated: (id, ip) => events.push(`authenticated:${id}@${ip}`),
  });
  const callOn = (on: Session, op: string, args: unknown = {}) => {
    const call: RpcCall = { session: on, ip: on.ip, userAgent: IPHONE_UA };
    return api.handle(op, args, call);
  };
  const call = (op: string, args: unknown = {}) => callOn(session(), op, args);
  /** A fresh QR scanned on `on`: its code claimed there. */
  const claimOn = (on: Session) =>
    callOn(on, 'pair.claim', { code: pairing.startPairing().code });
  /** Pairing up to the desktop's decision; the phone's request id. */
  const request = (key = deviceKey(), on = session()) => {
    claimOn(on);
    const answer = callOn(on, 'pair.request', {
      name: 'iPhone de Ana',
      devicePub: key.pub,
      sig: key.pairProof(on),
    });
    return answer.body as { requestId: string; verificationCode: string };
  };
  /** Accepted on the desktop, with the digits the phone shows. */
  const accept = (pending: { requestId: string; verificationCode: string }) =>
    pairing.respond(pending.requestId, true, pending.verificationCode);
  /** The whole pairing, accepted; then an authenticated session. */
  const link = () => {
    const key = deviceKey();
    const pending = request(key);
    accept(pending);
    const answer = call('pair.status', { requestId: pending.requestId });
    const deviceId = (answer.body as { deviceId: string }).deviceId;
    const on = session();
    callOn(on, 'auth', { deviceId, sig: key.prove(on, deviceId) });
    return { key, deviceId, session: on };
  };
  return {
    api,
    call,
    callOn,
    claimOn,
    devices,
    pairing,
    tokens,
    events,
    requests,
    request,
    accept,
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
      'pair.claim',
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

  describe('pair.claim', () => {
    it('spends a valid code for this session, for two minutes, and tells the desktop', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();

      expect(h.call('pair.claim', { code })).toEqual({
        status: 200,
        body: { expiresAt: 10_000_000 + 2 * 60_000 },
      });
      expect(h.pairing.hasActiveCode()).toBe(false);
      expect(h.events).toEqual(['pairClaimed']);
    });

    it('answers 410 with the reason for an unknown, used or expired code', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      h.call('pair.claim', { code });
      const stale = h.pairing.startPairing().code;
      h.advance(30_000);

      expect(h.call('pair.claim', { code: 'nope' })).toEqual({
        status: 410,
        body: { error: 'invalid' },
      });
      expect(h.call('pair.claim', { code })).toEqual({
        status: 410,
        body: { error: 'used' },
      });
      expect(h.call('pair.claim', { code: stale })).toEqual({
        status: 410,
        body: { error: 'expired' },
      });
      expect(h.events).toEqual(['pairClaimed']);
    });

    it('claims once per session, leaving the next code to someone else', () => {
      const h = harness();
      const on = session();
      h.claimOn(on);

      expect(h.claimOn(on)).toEqual({
        status: 409,
        body: { error: 'already-claimed' },
      });
      expect(h.pairing.hasActiveCode()).toBe(true);
    });

    it('needs a code', () => {
      expect(harness().call('pair.claim', {})).toEqual({
        status: 400,
        body: { error: 'invalid-request' },
      });
    });

    it('shares the five attempts a minute per address of pairing', () => {
      const h = harness();
      for (let i = 0; i < 5; i++) h.call('pair.claim', { code: 'x' });

      expect(h.call('pair.claim', { code: 'x' })).toEqual({
        status: 429,
        body: { error: 'rate-limited' },
      });
      expect(h.call('pair.request', {})).toEqual({
        status: 429,
        body: { error: 'rate-limited' },
      });
    });
  });

  describe('pair.request', () => {
    /** A request on `on` with a key that proves it is held there. */
    const ask = (
      h: ReturnType<typeof harness>,
      on: Session,
      name = 'x',
      key = deviceKey(),
    ) =>
      h.callOn(on, 'pair.request', {
        name,
        devicePub: key.pub,
        sig: key.pairProof(on),
      });

    it("opens a request for the session's claim and tells the desktop", () => {
      const h = harness();
      const on = session();
      h.claimOn(on);

      const answer = ask(h, on, '  iPhone de Ana ');

      expect(answer.status).toBe(200);
      // The time left, not a deadline: the phone's clock may disagree.
      expect(answer.body).toEqual({
        requestId: expect.any(String) as unknown,
        verificationCode: expect.stringMatching(/^\d{6}$/) as unknown,
        expiresInMs: 60_000,
      });
      expect(h.requests[0]).toMatchObject({
        name: 'iPhone de Ana',
        client: 'Safari · iOS',
        ip: '192.168.1.40',
      });
      expect(h.events).toEqual(['pairClaimed', 'pairRequested']);
    });

    it('answers 410 claim-expired to a session that claimed nothing', () => {
      const h = harness();
      h.pairing.startPairing();

      expect(ask(h, session())).toEqual({
        status: 410,
        body: { error: 'claim-expired' },
      });
      expect(h.requests).toEqual([]);
    });

    it('answers 410 claim-expired to a session that is not the one that claimed', () => {
      const h = harness();
      h.claimOn(session());

      expect(ask(h, session())).toEqual({
        status: 410,
        body: { error: 'claim-expired' },
      });
    });

    it('answers 410 claim-expired once the two minutes of the claim are up', () => {
      const h = harness();
      const on = session();
      h.claimOn(on);
      h.advance(2 * 60_000);

      expect(ask(h, on)).toEqual({
        status: 410,
        body: { error: 'claim-expired' },
      });
    });

    it('refuses an invalid name or key before spending the claim', () => {
      const h = harness();
      const key = deviceKey();
      const on = session();
      const sig = key.pairProof(on);
      h.claimOn(on);

      expect(
        h.callOn(on, 'pair.request', { name: '', devicePub: key.pub, sig }),
      ).toEqual({ status: 400, body: { error: 'invalid-name' } });
      expect(
        h.callOn(on, 'pair.request', { name: 'x', devicePub: 'short', sig }),
      ).toEqual({ status: 400, body: { error: 'invalid-request' } });
      expect(ask(h, on, 'x', key).status).toBe(200);
    });

    it('refuses a key that does not prove it is held, before spending the claim', () => {
      const h = harness();
      const key = deviceKey();
      const on = session();
      // Straight on the state machine: five refusals fill the rate limit.
      h.pairing.claim({ code: h.pairing.startPairing().code, sid: on.id });

      for (const sig of [
        undefined,
        deviceKey().pairProof(on),
        key.pairProof(session()),
        key.rotateProof(on),
        key.prove(on, 'd1'),
      ])
        expect(
          h.callOn(on, 'pair.request', {
            name: 'x',
            devicePub: key.pub,
            sig,
          }),
        ).toEqual({ status: 400, body: { error: 'invalid-request' } });
      expect(h.requests).toEqual([]);
      expect(
        h.pairing.request({
          sid: on.id,
          name: 'x',
          client: 'Safari · iOS',
          ip: on.ip,
          devicePub: key.pub,
        }).ok,
      ).toBe(true);
    });

    it('refuses a small-order key, whose "proof" anyone can forge', () => {
      const h = harness();
      const on = session();
      h.claimOn(on);

      expect(
        h.callOn(on, 'pair.request', {
          name: 'x',
          devicePub: WEAK_KEY,
          sig: FORGED_SIG,
        }),
      ).toEqual({ status: 400, body: { error: 'invalid-request' } });
      expect(ask(h, on).status).toBe(200);
    });

    it('allows five attempts a minute per address, then answers 429', () => {
      const h = harness();
      for (let i = 0; i < 5; i++)
        h.call('pair.request', { name: 'n', devicePub: 'x' });

      expect(h.call('pair.request', { name: 'n', devicePub: 'x' })).toEqual({
        status: 429,
        body: { error: 'rate-limited' },
      });
    });
  });

  describe('pair.status', () => {
    it('reports pending, then creates the device with its key exactly once', () => {
      const h = harness();
      const key = deviceKey();
      const pending = h.request(key);
      const { requestId } = pending;

      expect(h.call('pair.status', { requestId })).toEqual({
        status: 200,
        body: { status: 'pending' },
      });
      h.accept(pending);
      const answer = h.call('pair.status', { requestId });

      const deviceId = h.devices.list()[0]?.id;
      expect(answer).toEqual({
        status: 200,
        body: { status: 'accepted', deviceId },
      });
      expect(h.devices.devicePub(deviceId ?? '')).toBe(key.pub);
      // Where it paired from is the address its sign-ins are compared with.
      expect(h.devices.list()[0]?.lastIp).toBe('192.168.1.40');
      expect(h.call('pair.status', { requestId })).toEqual({
        status: 404,
        body: { error: 'unknown-request' },
      });
      expect(h.devices.list()).toHaveLength(1);
    });

    it("keeps a name that repeats an existing device's as it is", () => {
      const h = harness();
      h.link();
      const pending = h.request();
      h.accept(pending);

      h.call('pair.status', { requestId: pending.requestId });

      expect(h.devices.list().map((device) => device.name)).toEqual([
        'iPhone de Ana',
        'iPhone de Ana',
      ]);
    });

    it('reports a rejection without creating anything', () => {
      const h = harness();
      const { requestId } = h.request();
      h.pairing.respond(requestId, false, '');

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

  describe('pair.request replacing a previous device', () => {
    /**
     * The same phone pairing again, `previous` built from the linked device
     * on the session that asks; accepted, and the new device read back.
     */
    const repair = (
      h: ReturnType<typeof harness>,
      previous: (on: Session) => unknown,
    ) => {
      const on = session();
      h.claimOn(on);
      const key = deviceKey();
      const answer = h.callOn(on, 'pair.request', {
        name: 'iPhone de Ana',
        devicePub: key.pub,
        sig: key.pairProof(on),
        previous: previous(on),
      });
      const pending = answer.body as {
        requestId: string;
        verificationCode: string;
      };
      h.accept(pending);
      const status = h.call('pair.status', { requestId: pending.requestId });
      return {
        answer,
        deviceId: (status.body as { deviceId: string }).deviceId,
      };
    };

    it('removes the old device once the new one is accepted, when its key proves it', () => {
      const h = harness();
      const old = h.link();
      h.events.length = 0;

      const { answer, deviceId } = repair(h, (on) => ({
        deviceId: old.deviceId,
        proof: old.key.replaceProof(on),
      }));

      expect(answer.status).toBe(200);
      expect(h.devices.list().map((device) => device.id)).toEqual([deviceId]);
      // Its sessions and live streams end like an unlinked device's.
      expect(h.events).toEqual([
        'pairClaimed',
        'pairRequested',
        `unlinked:${old.deviceId}`,
        'changed',
      ]);
    });

    it('removes nothing before the desktop accepts', () => {
      const h = harness();
      const old = h.link();
      const on = session();
      h.claimOn(on);
      const key = deviceKey();
      const { requestId } = h.callOn(on, 'pair.request', {
        name: 'x',
        devicePub: key.pub,
        sig: key.pairProof(on),
        previous: { deviceId: old.deviceId, proof: old.key.replaceProof(on) },
      }).body as { requestId: string };
      h.pairing.respond(requestId, false, '');

      h.call('pair.status', { requestId });

      expect(h.devices.list().map((device) => device.id)).toEqual([
        old.deviceId,
      ]);
    });

    it.each([
      ['no proof', (_on: Session, old: Linked) => ({ deviceId: old.deviceId })],
      [
        'a proof by another key',
        (on: Session, old: Linked) => ({
          deviceId: old.deviceId,
          proof: deviceKey().replaceProof(on),
        }),
      ],
      [
        'a proof made for another handshake',
        (_on: Session, old: Linked) => ({
          deviceId: old.deviceId,
          proof: old.key.replaceProof(session()),
        }),
      ],
      [
        'a proof that says something else',
        (on: Session, old: Linked) => ({
          deviceId: old.deviceId,
          proof: old.key.pairProof(on),
        }),
      ],
      [
        'an unknown device id',
        (on: Session, old: Linked) => ({
          deviceId: 'ghost',
          proof: old.key.replaceProof(on),
        }),
      ],
      ['no previous at all, just garbage', () => 'd1'],
    ])('ignores a previous with %s, and still pairs', (_name, previous) => {
      const h = harness();
      const old = h.link();

      const { answer, deviceId } = repair(h, (on) => previous(on, old));

      expect(answer.status).toBe(200);
      expect(h.devices.list().map((device) => device.id)).toEqual([
        old.deviceId,
        deviceId,
      ]);
    });

    it("never takes a small-order key's word for it", () => {
      const h = harness();
      // Only a hand-edited store could hold one: nothing stores it.
      const weak = h.devices.add({
        name: 'x',
        client: 'y',
        devicePub: WEAK_KEY,
      });

      const { deviceId } = repair(h, () => ({
        deviceId: weak.id,
        proof: FORGED_SIG,
      }));

      expect(h.devices.list().map((device) => device.id)).toEqual([
        weak.id,
        deviceId,
      ]);
    });

    it('keeps an old device whose key changed after the proof', () => {
      const h = harness();
      const old = h.link();
      const on = session();
      h.claimOn(on);
      const key = deviceKey();
      const pending = h.callOn(on, 'pair.request', {
        name: 'x',
        devicePub: key.pub,
        sig: key.pairProof(on),
        previous: { deviceId: old.deviceId, proof: old.key.replaceProof(on) },
      }).body as { requestId: string; verificationCode: string };
      h.devices.setDevicePub(old.deviceId, deviceKey().pub);
      h.accept(pending);

      h.call('pair.status', { requestId: pending.requestId });

      expect(h.devices.list()).toHaveLength(2);
    });
  });

  describe('pair.cancel', () => {
    it('withdraws the pending request so the desktop can close its dialog', () => {
      const h = harness();
      const { requestId } = h.request();

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

    it('refuses a proof made for another handshake or another device id', () => {
      const h = harness();
      const { key, deviceId } = h.link();
      const elsewhere = session();
      const on = session();

      for (const sig of [
        key.prove(elsewhere, deviceId),
        key.prove(on, 'other'),
      ])
        expect(h.callOn(on, 'auth', { deviceId, sig })).toEqual({
          status: 401,
          body: { error: 'auth-failed' },
        });
      expect(on.deviceId).toBeNull();
    });

    it('says unknown-device only for a device it does not know', () => {
      const h = harness();
      const { deviceId } = h.link();
      const on = session();

      for (const args of [
        { deviceId: 'ghost', sig: deviceKey().prove(on, 'ghost') },
        {},
      ])
        expect(h.callOn(on, 'auth', args)).toEqual({
          status: 401,
          body: { error: 'unknown-device' },
        });
      for (const args of [
        { deviceId, sig: deviceKey().prove(on, deviceId) },
        { deviceId, sig: 'short' },
      ])
        expect(h.callOn(on, 'auth', args)).toEqual({
          status: 401,
          body: { error: 'auth-failed' },
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

    it('asks a session that has not signed in to sign in first', () => {
      expect(harness().call('unlink')).toEqual({
        status: 403,
        body: { error: 'auth-required' },
      });
    });

    it('answers 401 unlinked once the signed-in device is gone', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      h.devices.remove(deviceId);

      expect(h.callOn(on, 'unlink')).toEqual({
        status: 401,
        body: { error: 'unlinked' },
      });
    });
  });

  describe('verify.done', () => {
    it('records the verification with the one-time token of the QR', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      const t = h.tokens.issue(deviceId);
      h.advance(5000);

      expect(h.callOn(on, 'verify.done', { t })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(h.devices.find(deviceId)?.verifiedAt).toBe(10_005_000);
      expect(h.events.at(-1)).toBe('changed');
      expect(h.call('verify.done', { t }).status).toBe(403);
    });

    it('marks nothing without a valid token: missing, wrong, used or stale', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      const other = h.link();
      const used = h.tokens.issue(deviceId);
      h.callOn(on, 'verify.done', { t: used });
      h.devices.clearVerified();
      const stale = h.tokens.issue(deviceId);
      h.advance(10 * 60_000);
      const foreign = h.tokens.issue(other.deviceId);

      for (const args of [
        {},
        { t: 'AAAAAAAAAAAAAAAAAAAAAA' },
        { t: used },
        { t: stale },
        { t: foreign },
      ])
        expect(h.callOn(on, 'verify.done', args)).toEqual({
          status: 403,
          body: { error: 'invalid-token' },
        });
      expect(h.devices.find(deviceId)?.verifiedAt).toBeNull();
    });
  });

  describe('device.rotate', () => {
    it('replaces the key, unverifies the device and drops its sessions', () => {
      const h = harness();
      const { deviceId, session: on } = h.link();
      h.callOn(on, 'verify.done', { t: h.tokens.issue(deviceId) });
      const next = deviceKey();
      h.events.length = 0;

      expect(
        h.callOn(on, 'device.rotate', {
          devicePub: next.pub,
          sig: next.rotateProof(on),
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(h.devices.devicePub(deviceId)).toBe(next.pub);
      expect(h.devices.find(deviceId)?.verifiedAt).toBeNull();
      expect(h.events).toEqual([`rotated:${deviceId}`, 'changed']);

      // From now on only the new key proves who the device is.
      const fresh = session();
      expect(
        h.callOn(fresh, 'auth', { deviceId, sig: next.prove(fresh, deviceId) })
          .status,
      ).toBe(200);
    });

    it('refuses a key that does not prove it is held, or a weak one', () => {
      const h = harness();
      const { key, deviceId, session: on } = h.link();
      const next = deviceKey();

      for (const args of [
        { devicePub: 'x', sig: next.rotateProof(on) },
        { devicePub: next.pub },
        { devicePub: next.pub, sig: key.rotateProof(on) },
        { devicePub: next.pub, sig: next.pairProof(on) },
        { devicePub: next.pub, sig: next.rotateProof(session()) },
        { devicePub: WEAK_KEY, sig: FORGED_SIG },
      ])
        expect(h.callOn(on, 'device.rotate', args)).toEqual({
          status: 400,
          body: { error: 'invalid-request' },
        });
      expect(h.devices.devicePub(deviceId)).toBe(key.pub);
    });

    it('asks a session that has not signed in to sign in first', () => {
      const h = harness();
      const next = deviceKey();
      const on = session();

      expect(
        h.callOn(on, 'device.rotate', {
          devicePub: next.pub,
          sig: next.rotateProof(on),
        }).status,
      ).toBe(403);
    });
  });
});
