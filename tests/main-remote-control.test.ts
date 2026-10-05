import { describe, expect, it } from 'vitest';
import {
  DAY,
  harness,
  pairingLink,
  scanAndRequest,
} from './helpers/remote-control-harness.js';
import { createChannel } from '../renderer/remote/channel.js';
import { generateSigningKey, toB64 } from '../renderer/remote/rc-protocol.js';
import type {
  RemotePairRequest,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * «Control remoto» assembled: the switch, the port, pairing and the device
 * list, as the config window and the app lifecycle drive them. What a phone
 * does over the encrypted channel is tests/remote-rc-e2e.test.ts.
 */

/** Redeems a pairing link as a phone would; the status of the answer. */
async function redeem(h: ReturnType<typeof harness>, url: string) {
  const { code, key } = pairingLink(url);
  const channel = createChannel(h.net.fetch);
  await channel.open(key);
  const answer = await channel.send('pair.request', {
    code,
    name: 'x',
    devicePub: toB64(generateSigningKey().publicKey),
  });
  return answer.status;
}

describe('src/main/remote/remote-control.ts', () => {
  describe('status', () => {
    it('starts off with the default port and the LAN addresses', () => {
      const h = harness();

      expect(h.remote.status()).toEqual({
        enabled: false,
        autoUnlink: true,
        notifyConnections: true,
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
      const { requestId } = await scanAndRequest(h);

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

      expect(await redeem(h, pairing.url)).toBe(410);
    });

    it('cancels a pairing request waiting for an answer', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const { requestId } = await scanAndRequest(h);

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
        /^http:\/\/192\.168\.1\.20:47821\/pair\?c=[A-Za-z0-9_-]{24}#k=[A-Za-z0-9_-]{43}$/,
      );
      expect(pairing.qr.modules).toHaveLength(pairing.qr.size ** 2);
      expect(pairing.expiresAt).toBeGreaterThan(0);
    });
  });

  describe('the pairing handshake', () => {
    it('tells the desktop, then links the phone once it is accepted', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const { requestId, channel, device } = await scanAndRequest(h);

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

      const answer = await channel.send('pair.status', { requestId });
      expect(answer.body).toEqual({
        status: 'accepted',
        deviceId: h.remote.status().devices[0]?.id,
      });
      expect(h.stored()?.devices[0]?.devicePub).toBe(toB64(device.publicKey));
      expect(
        (h.lastOn('remote:changed') as RemoteStatus).devices.map((d) => d.name),
      ).toEqual(['iPhone de Ana']);
    });

    it('closes a rejected request and creates nothing', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const { requestId } = await scanAndRequest(h);

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
      const { requestId } = await scanAndRequest(h);
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
      const { requestId } = await scanAndRequest(h);

      h.remote.respondPairing(requestId, true);

      expect(h.timers.find((t) => t.ms === 60_000)?.cleared).toBe(true);
    });

    it('cancels the active code', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const pairing = h.remote.startPairing();
      if (!pairing.ok) throw new Error(pairing.error);

      h.remote.cancelPairing();

      expect(await redeem(h, pairing.url)).toBe(410);
    });
  });

  describe('devices', () => {
    const seeded = (lastSeenAt: number) => ({
      autoUnlink: true,
      devices: [
        {
          id: 'd1',
          name: 'iPhone',
          devicePub: toB64(generateSigningKey().publicKey),
          client: 'Safari · iOS',
          createdAt: 1,
          lastSeenAt,
          verifiedAt: null,
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
