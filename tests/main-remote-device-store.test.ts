import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDeviceStore,
  hashToken,
  normalizeDeviceName,
  normalizeRemoteState,
  type RemoteControlState,
} from '../src/main/remote/device-store.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

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
        port: 47821,
        devices: [],
      });
    });

    it('drops hand-edited devices that miss a field instead of trusting them', () => {
      const good = {
        id: 'a',
        name: 'iPhone',
        tokenHash: 'f'.repeat(64),
        client: 'Safari · iOS',
        createdAt: 1,
        lastSeenAt: 2,
      };
      const state = normalizeRemoteState({
        enabled: true,
        autoUnlink: false,
        port: 50000,
        devices: [good, { ...good, id: 'b', tokenHash: 'short' }, 'junk'],
      });

      expect(state).toEqual({
        enabled: true,
        autoUnlink: false,
        port: 50000,
        devices: [good],
      });
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
    it('returns a fresh token once and persists only its sha256 hash', () => {
      const h = harness();

      const { device, token } = h.store.add({
        name: 'iPhone',
        client: 'Safari · iOS',
      });

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(device).toEqual({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'iPhone',
        client: 'Safari · iOS',
        createdAt: h.now(),
        lastSeenAt: h.now(),
      });
      const stored = h.last()?.devices[0];
      expect(stored?.tokenHash).toBe(
        crypto.createHash('sha256').update(token).digest('hex'),
      );
      expect(JSON.stringify(h.writes)).not.toContain(token);
    });

    it('never lists the token hash', () => {
      const h = harness();
      h.store.add({ name: 'iPhone', client: 'Safari · iOS' });

      expect(h.store.list()[0]).not.toHaveProperty('tokenHash');
    });
  });

  describe('findByToken', () => {
    it('finds the device a token belongs to and nothing for another token', () => {
      const h = harness();
      const first = h.store.add({ name: 'A', client: 'c' });
      const second = h.store.add({ name: 'B', client: 'c' });

      expect(h.store.findByToken(second.token)?.name).toBe('B');
      expect(h.store.findByToken(first.token)?.name).toBe('A');
      expect(h.store.findByToken('not-a-real-token')).toBeNull();
      expect(h.store.findByToken('')).toBeNull();
    });

    it('stops recognising a token once its device is removed', () => {
      const h = harness();
      const { device, token } = h.store.add({ name: 'A', client: 'c' });

      expect(h.store.remove(device.id)).toBe(true);
      expect(h.store.findByToken(token)).toBeNull();
      expect(h.store.remove(device.id)).toBe(false);
    });

    it('matches a device that was persisted in an earlier session', () => {
      const token = 'persisted-token';
      const h = harness({
        devices: [
          {
            id: 'a',
            name: 'Old',
            tokenHash: hashToken(token),
            client: 'c',
            createdAt: 1,
            lastSeenAt: 1,
          },
        ],
      });

      expect(h.store.findByToken(token)?.id).toBe('a');
    });
  });

  describe('rename', () => {
    it('saves a trimmed valid name', () => {
      const h = harness();
      const { device } = h.store.add({ name: 'A', client: 'c' });

      expect(h.store.rename(device.id, '  Tablet  ')).toBe('ok');
      expect(h.store.list()[0]?.name).toBe('Tablet');
      expect(h.last()?.devices[0]?.name).toBe('Tablet');
    });

    it('refuses an invalid name or an unknown device without writing', () => {
      const h = harness();
      const { device } = h.store.add({ name: 'A', client: 'c' });
      const writes = h.writes.length;

      expect(h.store.rename(device.id, '')).toBe('invalid-name');
      expect(h.store.rename('nope', 'Tablet')).toBe('not-found');
      expect(h.writes).toHaveLength(writes);
    });
  });

  describe('touch', () => {
    it('persists the last connection at most once a minute per device', () => {
      const h = harness();
      const { device } = h.store.add({ name: 'A', client: 'c' });
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
      h.store.add({ name: 'Old', client: 'c' });
      h.advance(31 * DAY);
      const fresh = h.store.add({ name: 'New', client: 'c' });

      expect(h.store.pruneStale()).toBe(1);
      expect(h.store.list().map((d) => d.id)).toEqual([fresh.device.id]);
    });

    it('keeps every device when auto-unlink is off', () => {
      const h = harness();
      h.store.add({ name: 'Old', client: 'c' });
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

      expect(h.store.settings()).toEqual({
        enabled: true,
        autoUnlink: false,
        port: 47821,
      });
      expect(h.last()).toMatchObject({ enabled: true, autoUnlink: false });
    });
  });
});
