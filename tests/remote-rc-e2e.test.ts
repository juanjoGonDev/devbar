import { describe, expect, it } from 'vitest';
import { createChannel, RemoteError } from '../renderer/remote/channel.js';
import {
  fromB64,
  generateSigningKey,
  pairMessage,
  rotateMessage,
  safetyCode,
  sign,
  toB64,
} from '../renderer/remote/rc-protocol.js';
import type { RemoteStatus } from '../src/ipc-contract/remote-api.js';
import {
  DAY,
  fakeRuntime,
  harness,
  linkPhone,
  openEvents,
  pairingLink,
  reconnect,
  scanAndRequest,
  type Harness,
  type LinkedPhone,
} from './helpers/remote-control-harness.js';

/**
 * A phone and a computer talking devbar-rc/1 end to end: the real
 * «Control remoto» (src/main/remote/remote-control.ts, node:crypto) against
 * the phone's real channel (renderer/remote/channel.ts, @noble). Pairing,
 * every call and every event cross an actual handshake, sealed both ways.
 */

async function linked(runtime = fakeRuntime()) {
  const h = harness(undefined, { runtime });
  await h.remote.setEnabled(true);
  const phone = await linkPhone(h);
  return { h, phone };
}

async function codeOf(error: Promise<unknown>): Promise<string> {
  try {
    await error;
  } catch (failure) {
    return failure instanceof RemoteError ? failure.code : String(failure);
  }
  return 'resolved';
}

/** The fragment of the device's verification link, as the phone reads it. */
function verifyLink(h: Harness, phone: LinkedPhone) {
  const result = h.remote.securityCode(phone.deviceId);
  if (!result.ok || !result.url) throw new Error('no verification link');
  const fragment = new URLSearchParams(new URL(result.url).hash.slice(1));
  return {
    result,
    k: fromB64(fragment.get('k'), 32),
    d: fragment.get('d'),
    p: fragment.get('p'),
    t: fragment.get('t'),
  };
}

/** A new device key, with its proof over the channel's current handshake. */
function rotation(channel: LinkedPhone['channel']) {
  const next = generateSigningKey();
  const t = channel.handshake() ?? new Uint8Array();
  return {
    next,
    args: {
      devicePub: toB64(next.publicKey),
      sig: toB64(sign(next.secretKey, rotateMessage(t))),
    },
  };
}

describe('devbar-rc/1 end to end', () => {
  describe('pairing', () => {
    it('links a phone that pinned the key of the QR, and only through the desktop', async () => {
      const h = harness();
      await h.remote.setEnabled(true);

      const phone = await linkPhone(h);

      expect(h.remote.status().devices).toMatchObject([
        { id: phone.deviceId, name: 'iPhone de Ana', verifiedAt: null },
      ]);
      await expect(phone.channel.send('me')).resolves.toMatchObject({
        status: 200,
        body: { linked: true, device: { id: phone.deviceId } },
      });
    });

    it('refuses to pair with a desktop whose key is not the one in the QR', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const pairing = h.remote.startPairing();
      if (!pairing.ok) throw new Error(pairing.error);
      const { key } = pairingLink(pairing.url);
      await h.remote.renewIdentity();

      const channel = createChannel(h.net.fetch);
      expect(await codeOf(channel.open(key))).toBe('changed');
      expect(channel.ready()).toBe(false);
    });

    it('lets only the connection that claimed the code ask to be linked', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const pairing = h.remote.startPairing();
      if (!pairing.ok) throw new Error(pairing.error);
      const { code, key } = pairingLink(pairing.url);
      const claimer = createChannel(h.net.fetch);
      await claimer.open(key);
      const other = createChannel(h.net.fetch);
      await other.open(key);
      const device = generateSigningKey();
      const ask = (channel: typeof other) =>
        channel.send('pair.request', {
          name: 'iPhone de Ana',
          devicePub: toB64(device.publicKey),
          sig: toB64(
            sign(
              device.secretKey,
              pairMessage(channel.handshake() ?? new Uint8Array()),
            ),
          ),
        });

      await claimer.send('pair.claim', { code });

      await expect(ask(other)).resolves.toEqual({
        status: 410,
        body: { error: 'claim-expired' },
      });
      await expect(ask(claimer)).resolves.toMatchObject({ status: 200 });
    });

    it('closes the desktop request dialog when the phone cancels', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const { requestId, channel } = await scanAndRequest(h);

      await channel.send('pair.cancel', { requestId });

      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'cancelled',
      });
      expect(h.timers.find((t) => t.ms === 60_000)?.cleared).toBe(true);
    });
  });

  describe('the control API', () => {
    it('answers a linked device only', async () => {
      const { h, phone } = await linked();
      const { channel: stranger } = await scanAndRequest(h, 'Otro');

      await expect(phone.channel.send('state')).resolves.toMatchObject({
        status: 200,
        body: { host: { name: 'mac-de-ana', version: '0.11.0' } },
      });
      await expect(stranger.send('state')).resolves.toEqual({
        status: 403,
        body: { error: 'auth-required' },
      });
      await expect(phone.channel.send('nope')).resolves.toMatchObject({
        status: 404,
      });
    });

    it('keeps the notices the notifications hand over', async () => {
      const { h, phone } = await linked();

      h.remote.notice({
        title: 'DevBar — pre-scripts',
        body: 'ok',
        action: null,
      });

      await expect(phone.channel.send('notices')).resolves.toMatchObject({
        body: { notices: [{ kind: 'success', title: 'Pre-scripts' }] },
      });
    });

    it('renames the device a phone asks to rename, and tells the desktop', async () => {
      const { h, phone } = await linked();

      await phone.channel.send('device.rename', { name: 'Móvil de Ana' });

      expect(
        (h.lastOn('remote:changed') as RemoteStatus).devices[0]?.name,
      ).toBe('Móvil de Ana');
    });
  });

  describe('the event stream', () => {
    it('opens for a linked device only, starting with the state', async () => {
      const { h, phone } = await linked();
      const { channel: stranger } = await scanAndRequest(h, 'Otro');

      expect(openEvents(h, stranger).refused).toMatchObject({ status: 403 });
      const stream = openEvents(h, phone.channel);
      expect(stream.refused).toBeNull();
      expect(stream.events()[0]?.type).toBe('state');
    });

    it('keeps one stream per session: opening another replaces it', async () => {
      const { h, phone } = await linked();
      const first = openEvents(h, phone.channel);

      const second = openEvents(h, phone.channel);

      expect(first.ended()).toBe(true);
      expect(second.refused).toBeNull();
      expect(second.ended()).toBe(false);
      expect(h.remote.status().devices[0]?.connected).toBe(true);
    });

    it('opens nothing for a session from another address', async () => {
      const { h, phone } = await linked();
      const reader = phone.channel.events();

      const stream = h.netFrom('192.168.1.66').openStream(reader?.url ?? '');

      expect(stream.refused).toMatchObject({ status: 401 });
      expect(h.remote.status().devices[0]?.connected).toBe(false);
    });

    it('shows the device as connected while it holds a stream', async () => {
      const { h, phone } = await linked();

      const stream = openEvents(h, phone.channel);
      expect(h.remote.status().devices[0]?.connected).toBe(true);

      stream.close();
      expect(h.remote.status().devices[0]?.connected).toBe(false);
    });

    it('never prunes a device that holds a stream right now', async () => {
      const { h, phone } = await linked();
      openEvents(h, phone.channel);

      h.advance(31 * DAY);
      h.timers.find((t) => t.repeat && t.ms === DAY)?.fn();

      expect(h.remote.status().devices).toHaveLength(1);
    });

    it('carries the lines of the process the session subscribed to', async () => {
      const runtime = fakeRuntime();
      let listener: Parameters<typeof runtime.onLog>[0] = () => undefined;
      runtime.onLog = (fn) => {
        listener = fn;
      };
      const { h, phone } = await linked(runtime);
      const stream = openEvents(h, phone.channel);

      await phone.channel.send('logs.subscribe', { id: 'cmd:g1:web' });
      listener({
        id: 'cmd:g1:web',
        entry: { ts: 1, seq: 1, stream: 'stdout', level: null, line: 'hola' },
      });
      h.timers.find((t) => !t.cleared && t.ms === 100)?.fn();

      expect(stream.events().at(-1)).toEqual({
        type: 'log',
        data: {
          id: 'cmd:g1:web',
          lines: [{ seq: 1, ts: 1, level: null, line: 'hola' }],
        },
      });
    });
  });

  describe('unlinking', () => {
    it('closes the streams of a device unlinked from the desktop, saying why', async () => {
      const { h, phone } = await linked();
      const stream = openEvents(h, phone.channel);

      h.remote.unlinkDevice(phone.deviceId);

      expect(stream.events().at(-1)?.type).toBe('unlinked');
      expect(stream.ended()).toBe(true);
      expect(await codeOf(phone.channel.send('state'))).toBe('session');
      expect(await reconnect(h, phone)).toMatchObject({
        auth: 401,
        error: 'unknown-device',
      });
    });

    it('closes the streams of a device that unlinked itself', async () => {
      const { h, phone } = await linked();
      const stream = openEvents(h, phone.channel);

      await expect(phone.channel.send('unlink')).resolves.toMatchObject({
        status: 200,
      });

      expect(stream.ended()).toBe(true);
      expect(h.remote.status().devices).toEqual([]);
    });
  });

  describe('server lifecycle', () => {
    it('drops every session and stream when the server stops', async () => {
      const { h, phone } = await linked();
      const stream = openEvents(h, phone.channel);

      await h.remote.setEnabled(false);
      await h.remote.setEnabled(true);

      expect(stream.ended()).toBe(true);
      expect(await codeOf(phone.channel.send('state'))).toBe('session');
    });

    it('keeps the phone linked across a port change: it simply shakes hands again', async () => {
      const { h, phone } = await linked();
      const stream = openEvents(h, phone.channel);

      await h.remote.setPort(50123);

      expect(stream.ended()).toBe(true);
      expect(await codeOf(phone.channel.send('state'))).toBe('session');
      const again = await reconnect(h, phone);
      expect(again.auth).toBe(200);
      await expect(again.channel.send('state')).resolves.toMatchObject({
        status: 200,
      });
    });
  });

  describe('the security code', () => {
    it('is the same six groups on both ends, with a link the phone can verify', async () => {
      const { h, phone } = await linked();

      const { result, k, d, p } = verifyLink(h, phone);

      expect(result.code).toEqual(
        safetyCode(phone.serverKey, phone.device.publicKey),
      );
      expect(result.code.join(' ')).toMatch(/^(\d{5} ){5}\d{5}$/);
      expect(result.url).toMatch(/^http:\/\/192\.168\.1\.20:47821\/verify#k=/);
      expect(result.qr?.modules).toHaveLength((result.qr?.size ?? 0) ** 2);
      expect(Buffer.from(k ?? [])).toEqual(Buffer.from(phone.serverKey));
      expect(d).toBe(phone.deviceId);
      expect(p).toBe(toB64(phone.device.publicKey));
      expect(result.verified).toBe(false);
    });

    it('carries a one-time token in the link, new each time it is shown', async () => {
      const { h, phone } = await linked();

      const { t } = verifyLink(h, phone);

      expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(verifyLink(h, phone).t).not.toBe(t);
    });

    it('still shows the code, without a link, while the server is off', async () => {
      const { h, phone } = await linked();
      await h.remote.setEnabled(false);

      expect(h.remote.securityCode(phone.deviceId)).toMatchObject({
        ok: true,
        url: null,
        qr: null,
      });
      expect(h.remote.securityCode('ghost')).toEqual({
        ok: false,
        error: 'Ese dispositivo ya no está vinculado.',
      });
    });

    it('turns the device verified once the phone hands back the token it scanned', async () => {
      const { h, phone } = await linked();
      const { t } = verifyLink(h, phone);

      await phone.channel.send('verify.done', { t });

      expect(h.remote.status().devices[0]?.verifiedAt).toEqual(
        expect.any(Number),
      );
      expect(verifyLink(h, phone).result.verified).toBe(true);
    });

    it("does not take the phone's word for it: no token, no verification", async () => {
      const { h, phone } = await linked();
      const { t } = verifyLink(h, phone);
      verifyLink(h, phone);

      for (const args of [{}, { t }])
        await expect(
          phone.channel.send('verify.done', args),
        ).resolves.toMatchObject({ status: 403 });
      expect(h.remote.status().devices[0]?.verifiedAt).toBeNull();
    });
  });

  describe('renewing keys', () => {
    it('from the phone: a new device key, unverified, and the old one no longer opens a session', async () => {
      const { h, phone } = await linked();
      await phone.channel.send('verify.done', {
        t: verifyLink(h, phone).t,
      });
      const stream = openEvents(h, phone.channel);
      const { next, args } = rotation(phone.channel);

      await expect(
        phone.channel.send('device.rotate', args),
      ).resolves.toMatchObject({ status: 200 });

      expect(stream.ended()).toBe(true);
      expect(h.remote.status().devices[0]?.verifiedAt).toBeNull();
      expect(await codeOf(phone.channel.send('state'))).toBe('session');
      expect(await reconnect(h, phone)).toMatchObject({
        auth: 401,
        error: 'auth-failed',
      });
      const renewed = await reconnect(h, { ...phone, device: next });
      expect(renewed.auth).toBe(200);
      expect(verifyLink(h, { ...phone, device: next }).result.code).toEqual(
        safetyCode(phone.serverKey, next.publicKey),
      );
    });

    it('from the computer: a new identity the phone refuses until it scans the new code', async () => {
      const { h, phone } = await linked();
      await phone.channel.send('verify.done', {
        t: verifyLink(h, phone).t,
      });
      const stream = openEvents(h, phone.channel);
      const { requestId } = await scanAndRequest(h, 'Pendiente');

      await expect(h.remote.renewIdentity()).resolves.toEqual({ ok: true });

      expect(stream.ended()).toBe(true);
      expect(h.lastOn('remote:pairRequestClosed')).toEqual({
        requestId,
        outcome: 'cancelled',
      });
      expect(h.remote.status().devices.map((d) => d.verifiedAt)).toEqual([
        null,
      ]);
      // The pinned key is the old one: the phone notices and stops there.
      expect(await codeOf(reconnect(h, phone))).toBe('changed');
      // Scanning the device's new security code hands it the new key.
      const { k, t } = verifyLink(h, phone);
      if (!k) throw new Error('no key');
      const repinned = await reconnect(h, { ...phone, serverKey: k });
      expect(repinned.auth).toBe(200);
      await expect(
        repinned.channel.send('verify.done', { t }),
      ).resolves.toMatchObject({ status: 200 });
      expect(verifyLink(h, phone).result.verified).toBe(true);
    });

    it('keeps the identity across a restart, stored as it is', async () => {
      const { h, phone } = await linked();
      const stored = h.stored();

      expect(stored?.identity?.sealed).toBe(false);
      const restarted = harness(structuredClone(stored));
      await restarted.remote.setEnabled(true);
      expect((await reconnect(restarted, phone)).auth).toBe(200);
    });
  });
});
