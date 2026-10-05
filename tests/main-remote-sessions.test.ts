import { describe, expect, it } from 'vitest';
import {
  aad,
  nonce,
  open,
  seal,
  toB64,
} from '../src/main/remote/rc-protocol.js';
import { createSessionTable } from '../src/main/remote/sessions.js';

/**
 * The devbar-rc/1 sessions the desktop holds in memory: one per handshake,
 * each with its own pair of keys and counters. Nothing here is persisted —
 * a restart, a port change or a renewed identity drops them all and every
 * phone simply shakes hands again.
 */

const MINUTE = 60_000;
const C2S = Buffer.alloc(32, 1);
const S2C = Buffer.alloc(32, 2);

let sids = 0;
function material() {
  sids += 1;
  return {
    sid: toB64(Buffer.alloc(16, sids)),
    transcript: Buffer.from(`T${sids}`),
    keys: { c2s: C2S, s2c: S2C },
  };
}

function harness(options: { perIp?: number; total?: number } = {}) {
  let clock = 1_000_000;
  const table = createSessionTable({ now: () => clock, ...options });
  return {
    table,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('src/main/remote/sessions.ts', () => {
  describe('messages', () => {
    it('opens what the phone sealed with its counter, once', () => {
      const { table } = harness();
      const session = table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');
      const sealed = seal(C2S, 1, aad('c2s', session.id), Buffer.from('{}'));

      expect(session.open(1, sealed)?.toString()).toBe('{}');
      // The very same message again is a replay.
      expect(session.open(1, sealed)).toBeNull();
    });

    it('refuses a forged message without burning its counter', () => {
      const { table } = harness();
      const session = table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');
      const forged = seal(
        Buffer.alloc(32, 9),
        1,
        aad('c2s', session.id),
        Buffer.from('{}'),
      );
      const genuine = seal(C2S, 1, aad('c2s', session.id), Buffer.from('{}'));

      expect(session.open(1, forged)).toBeNull();
      expect(session.open(1, genuine)?.toString()).toBe('{}');
    });

    it('refuses a message sealed for another session', () => {
      const { table } = harness();
      const one = table.create('10.0.0.2', material());
      const two = table.create('10.0.0.2', material());
      if (!one || !two) throw new Error('no session');
      const sealed = seal(C2S, 1, aad('c2s', one.id), Buffer.from('{}'));

      expect(two.open(1, sealed)).toBeNull();
    });

    it('seals replies with a counter of their own, starting at 1', () => {
      const { table } = harness();
      const session = table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      const first = session.seal(Buffer.from('a'));
      const event = session.sealEvent(Buffer.from('b'));
      const second = session.seal(Buffer.from('c'));

      expect([first.n, second.n]).toEqual([1, 3]);
      const ct = Buffer.from(first.ct, 'base64url');
      expect(open(S2C, 1, aad('s2c', session.id), ct)?.toString()).toBe('a');
      const frame = Buffer.from(event, 'base64url');
      expect(frame.subarray(0, 8)).toEqual(nonce(2).subarray(4));
      expect(
        open(S2C, 2, aad('s2c', session.id), frame.subarray(8))?.toString(),
      ).toBe('b');
    });
  });

  describe('lifetime', () => {
    it('forgets a session idle for ten minutes', () => {
      const h = harness();
      const session = h.table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      h.advance(9 * MINUTE);
      expect(h.table.get(session.id)).toBe(session);
      h.advance(9 * MINUTE);
      expect(h.table.get(session.id)).toBe(session);
      h.advance(10 * MINUTE);
      expect(h.table.get(session.id)).toBeNull();
    });

    it('keeps a session alive while it holds an open stream', () => {
      const h = harness();
      const session = h.table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      h.table.streamOpened(session);
      h.advance(60 * MINUTE);
      expect(h.table.get(session.id)).toBe(session);
      h.table.streamClosed(session);
      h.advance(10 * MINUTE);
      expect(h.table.get(session.id)).toBeNull();
    });

    it('drops the sessions of one device, or every session', () => {
      const { table } = harness();
      const a = table.create('10.0.0.2', material());
      const b = table.create('10.0.0.3', material());
      const c = table.create('10.0.0.4', material());
      if (!a || !b || !c) throw new Error('no session');
      a.deviceId = 'd1';
      b.deviceId = 'd1';
      c.deviceId = 'd2';

      expect(table.dropDevice('d1').sort()).toEqual([a.id, b.id].sort());
      expect(table.get(a.id)).toBeNull();
      expect(table.get(c.id)).toBe(c);
      expect(table.dropAll()).toEqual([c.id]);
      expect(table.get(c.id)).toBeNull();
    });
  });

  describe('caps', () => {
    it('makes room per address by evicting its least recently used idle session', () => {
      const h = harness({ perIp: 2, total: 10 });
      const old = h.table.create('10.0.0.2', material());
      h.advance(1000);
      const recent = h.table.create('10.0.0.2', material());
      h.advance(1000);
      if (!old || !recent) throw new Error('no session');
      h.table.get(old.id);

      const third = h.table.create('10.0.0.2', material());

      expect(third).not.toBeNull();
      expect(h.table.get(recent.id)).toBeNull();
      expect(h.table.get(old.id)).toBe(old);
    });

    it('refuses a new session when every one at the cap is streaming', () => {
      const h = harness({ perIp: 1, total: 10 });
      const busy = h.table.create('10.0.0.2', material());
      if (!busy) throw new Error('no session');
      h.table.streamOpened(busy);

      expect(h.table.create('10.0.0.2', material())).toBeNull();
      // Another address is not affected by this one's cap.
      expect(h.table.create('10.0.0.3', material())).not.toBeNull();
    });

    it('holds the total too, evicting across addresses', () => {
      const h = harness({ perIp: 5, total: 2 });
      const first = h.table.create('10.0.0.2', material());
      h.advance(1000);
      h.table.create('10.0.0.3', material());
      h.advance(1000);

      expect(h.table.create('10.0.0.4', material())).not.toBeNull();
      expect(h.table.get(first?.id ?? '')).toBeNull();
      expect(h.table.size()).toBe(2);
    });
  });
});
