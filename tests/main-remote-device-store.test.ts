import { describe, expect, it } from 'vitest';
import {
  createDeviceStore,
  normalizeDeviceName,
  normalizeRemoteState,
  type RemoteControlState,
} from '../src/main/remote/device-store.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Raw 32-byte Ed25519 public keys, base64url: 43 characters. */
const PUB_A = 'A'.repeat(42) + 'A';
const PUB_B = 'B'.repeat(42) + 'A';
const IDENTITY = {
  publicKey: 'C'.repeat(42) + 'A',
  secret: 'sealed',
  sealed: true,
};

function harness(seed: unknown = undefined) {
  let clock = 1_000_000;
  const writes: RemoteControlState[] = [];
  let ids = 0;
  const store = createDeviceStore({
    read: () => seed,
    write: (state) => writes.push(structuredClone(state)),
    now: () => clock,
    randomUUID: () => `00000000-0000-4000-8000-00000000000${++ids}`,
  });
  return {
    store,
    writes,
    last: () => writes.at(-1),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('src/main/remote/device-store.ts', () => {
  describe('normalizeRemoteState', () => {
    it('defaults to off, auto-unlink on, port 47821 and no devices', () => {
      expect(normalizeRemoteState(undefined)).toEqual({
        enabled: false,
        autoUnlink: true,
        notifyConnections: true,
        port: 47821,
        devices: [],
        identity: null,
      });
    });

    it('drops hand-edited devices that miss a field instead of trusting them', () => {
      const good = {
        id: 'a',
        name: 'iPhone',
        devicePub: PUB_A,
        client: 'Safari · iOS',
        createdAt: 1,
        lastSeenAt: 2,
        verifiedAt: null,
      };
      const state = normalizeRemoteState({
        enabled: true,
        autoUnlink: false,
        notifyConnections: false,
        port: 50000,
        devices: [
          good,
          { ...good, id: 'b', devicePub: 'short' },
          // A session-cookie device from before the encryption: no key.
          { ...good, id: 'c', devicePub: undefined, tokenHash: 'f'.repeat(64) },
          'junk',
        ],
        identity: IDENTITY,
      });

      expect(state).toEqual({
        enabled: true,
        autoUnlink: false,
        notifyConnections: false,
        port: 50000,
        devices: [good],
        identity: IDENTITY,
      });
    });

    it('reads a missing verification as unverified, a bad one as a bad device', () => {
      const base = {
        id: 'a',
        name: 'iPhone',
        devicePub: PUB_A,
        client: 'c',
        createdAt: 1,
        lastSeenAt: 2,
      };
      const state = normalizeRemoteState({
        devices: [base, { ...base, id: 'b', verifiedAt: 'yesterday' }],
      });

      expect(state.devices).toEqual([{ ...base, verifiedAt: null }]);
    });

    it('drops an identity that is not a well-formed record', () => {
      for (const identity of [
        'junk',
        { ...IDENTITY, publicKey: 'short' },
        { ...IDENTITY, secret: 3 },
        { ...IDENTITY, sealed: 'yes' },
      ])
        expect(normalizeRemoteState({ identity }).identity).toBeNull();
    });

    it('falls back to the default port for an unusable value', () => {
      expect(normalizeRemoteState({ port: 80 }).port).toBe(47821);
      expect(normalizeRemoteState({ port: 'x' }).port).toBe(47821);
    });
  });

  describe('normalizeDeviceName', () => {
    it('trims and accepts 1 to 40 characters', () => {
      expect(normalizeDeviceName('  iPhone de Ana  ')).toBe('iPhone de Ana');
      expect(normalizeDeviceName('x'.repeat(40))).toBe('x'.repeat(40));
    });

    it('rejects empty, too long, control characters and non-strings', () => {
      expect(normalizeDeviceName('   ')).toBeNull();
      expect(normalizeDeviceName('x'.repeat(41))).toBeNull();
      expect(normalizeDeviceName('a\nb')).toBeNull();
      expect(normalizeDeviceName(42)).toBeNull();
    });
  });

  describe('add', () => {
    it('persists the device with its public key, unverified', () => {
      const h = harness();

      const device = h.store.add({
        name: 'iPhone',
        client: 'Safari · iOS',
        devicePub: PUB_A,
      });

      expect(device).toEqual({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'iPhone',
        client: 'Safari · iOS',
        createdAt: h.now(),
        lastSeenAt: h.now(),
        verifiedAt: null,
      });
      expect(h.last()?.devices[0]?.devicePub).toBe(PUB_A);
    });

    it('never lists the public key', () => {
      const h = harness();
      h.store.add({ name: 'iPhone', client: 'Safari · iOS', devicePub: PUB_A });

      expect(h.store.list()[0]).not.toHaveProperty('devicePub');
      expect(h.store.find(h.store.list()[0]?.id ?? '')).not.toHaveProperty(
        'devicePub',
      );
    });
  });

  describe('find and devicePub', () => {
    it('finds a device by id with its key, and nothing once removed', () => {
      const h = harness();
      const device = h.store.add({ name: 'A', client: 'c', devicePub: PUB_A });

      expect(h.store.find(device.id)?.name).toBe('A');
      expect(h.store.devicePub(device.id)).toBe(PUB_A);
      expect(h.store.remove(device.id)).toBe(true);
      expect(h.store.find(device.id)).toBeNull();
      expect(h.store.devicePub(device.id)).toBeNull();
      expect(h.store.remove(device.id)).toBe(false);
    });
  });

  describe('verification', () => {
    it('marks a device verified now, and a new key clears it', () => {
      const h = harness();
      const device = h.store.add({ name: 'A', client: 'c', devicePub: PUB_A });

      expect(h.store.markVerified(device.id)).toBe(true);
      expect(h.store.find(device.id)?.verifiedAt).toBe(h.now());
      expect(h.last()?.devices[0]?.verifiedAt).toBe(h.now());

      expect(h.store.setDevicePub(device.id, PUB_B)).toBe(true);
      expect(h.store.devicePub(device.id)).toBe(PUB_B);
      expect(h.store.find(device.id)?.verifiedAt).toBeNull();
      expect(h.last()?.devices[0]).toMatchObject({
        devicePub: PUB_B,
        verifiedAt: null,
      });
    });

    it('clears every verification at once', () => {
      const h = harness();
      const a = h.store.add({ name: 'A', client: 'c', devicePub: PUB_A });
      const b = h.store.add({ name: 'B', client: 'c', devicePub: PUB_B });
      h.store.markVerified(a.id);
      h.store.markVerified(b.id);

      h.store.clearVerified();

      expect(h.store.list().map((d) => d.verifiedAt)).toEqual([null, null]);
      expect(h.last()?.devices.map((d) => d.verifiedAt)).toEqual([null, null]);
    });

    it('ignores an unknown device', () => {
      const h = harness();

      expect(h.store.markVerified('ghost')).toBe(false);
      expect(h.store.setDevicePub('ghost', PUB_A)).toBe(false);
    });
  });

  describe('identity', () => {
    it('keeps the identity record next to the devices', () => {
      const h = harness();
      expect(h.store.identity()).toBeNull();

      h.store.saveIdentity(IDENTITY);

      expect(h.store.identity()).toEqual(IDENTITY);
      expect(h.last()?.identity).toEqual(IDENTITY);
    });
  });

  describe('rename', () => {
    it('saves a trimmed valid name', () => {
      const h = harness();
      const device = h.store.add({ name: 'A', client: 'c', devicePub: PUB_A });

      expect(h.store.rename(device.id, '  Tablet  ')).toBe('ok');
      expect(h.store.list()[0]?.name).toBe('Tablet');
      expect(h.last()?.devices[0]?.name).toBe('Tablet');
    });

    it('refuses an invalid name or an unknown device without writing', () => {
      const h = harness();
      const device = h.store.add({ name: 'A', client: 'c', devicePub: PUB_A });
      const writes = h.writes.length;

      expect(h.store.rename(device.id, '')).toBe('invalid-name');
      expect(h.store.rename('nope', 'Tablet')).toBe('not-found');
      expect(h.writes).toHaveLength(writes);
    });
  });

  describe('touch', () => {
    it('persists the last connection at most once a minute per device', () => {
      const h = harness();
      const device = h.store.add({ name: 'A', client: 'c', devicePub: PUB_A });
      const writes = h.writes.length;

      h.advance(10_000);
      expect(h.store.touch(device.id)).toBe(false);
      expect(h.writes).toHaveLength(writes);
      expect(h.store.list()[0]?.lastSeenAt).toBe(h.now());

      h.advance(MINUTE);
      expect(h.store.touch(device.id)).toBe(true);
      expect(h.last()?.devices[0]?.lastSeenAt).toBe(h.now());
    });

    it('ignores an unknown device', () => {
      const h = harness();

      expect(h.store.touch('ghost')).toBe(false);
    });
  });

  describe('pruneStale', () => {
    it('removes devices unseen for over 30 days while auto-unlink is on', () => {
      const h = harness();
      h.store.add({ name: 'Old', client: 'c', devicePub: PUB_A });
      h.advance(31 * DAY);
      const fresh = h.store.add({ name: 'New', client: 'c', devicePub: PUB_B });

      expect(h.store.pruneStale()).toBe(1);
      expect(h.store.list().map((d) => d.id)).toEqual([fresh.id]);
    });

    it('keeps every device when auto-unlink is off', () => {
      const h = harness();
      h.store.add({ name: 'Old', client: 'c', devicePub: PUB_A });
      h.store.setAutoUnlink(false);
      h.advance(31 * DAY);

      expect(h.store.pruneStale()).toBe(0);
      expect(h.store.list()).toHaveLength(1);
    });
  });

  describe('settings', () => {
    it('persists the switches next to the devices', () => {
      const h = harness();

      h.store.setEnabled(true);
      h.store.setAutoUnlink(false);
      h.store.setNotifyConnections(false);

      expect(h.store.settings()).toEqual({
        enabled: true,
        autoUnlink: false,
        notifyConnections: false,
        port: 47821,
      });
      expect(h.last()).toMatchObject({
        enabled: true,
        autoUnlink: false,
        notifyConnections: false,
      });
    });

    it('persists a new port and keeps the linked devices', () => {
      const h = harness();
      h.store.add({ name: 'iPhone', client: 'Safari · iOS', devicePub: PUB_A });

      h.store.setPort(50123);

      expect(h.store.settings().port).toBe(50123);
      expect(h.last()).toMatchObject({ port: 50123 });
      expect(h.last()?.devices).toHaveLength(1);
    });
  });
});
