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
      const sealed = seal(
        C2S,
        1,
        aad('c2s-rpc', session.id),
        Buffer.from('{}'),
      );

      expect(session.open('rpc', 1, sealed)?.toString()).toBe('{}');
      // The very same message again is a replay.
      expect(session.open('rpc', 1, sealed)).toBeNull();
    });

    it('opens an event-stream proof through the same replay window as calls', () => {
      const { table } = harness();
      const session = table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');
      const proof = seal(
        C2S,
        1,
        aad('c2s-events', session.id),
        Buffer.from('events'),
      );
      const call = seal(C2S, 2, aad('c2s-rpc', session.id), Buffer.from('{}'));

      // A message never opens as the other kind…
      expect(session.open('rpc', 1, proof)).toBeNull();
      expect(session.open('events', 2, call)).toBeNull();
      expect(session.open('events', 1, proof)?.toString()).toBe('events');
      // …and one counter, once, whatever it carried.
      const reused = seal(
        C2S,
        1,
        aad('c2s-rpc', session.id),
        Buffer.from('{}'),
      );
      expect(session.open('rpc', 1, reused)).toBeNull();
      expect(session.open('rpc', 2, call)?.toString()).toBe('{}');
    });

    it('refuses a forged message without burning its counter', () => {
      const { table } = harness();
      const session = table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');
      const forged = seal(
        Buffer.alloc(32, 9),
        1,
        aad('c2s-rpc', session.id),
        Buffer.from('{}'),
      );
      const genuine = seal(
        C2S,
        1,
        aad('c2s-rpc', session.id),
        Buffer.from('{}'),
      );

      expect(session.open('rpc', 1, forged)).toBeNull();
      expect(session.open('rpc', 1, genuine)?.toString()).toBe('{}');
    });

    it('refuses a message sealed for another session', () => {
      const { table } = harness();
      const one = table.create('10.0.0.2', material());
      const two = table.create('10.0.0.2', material());
      if (!one || !two) throw new Error('no session');
      const sealed = seal(C2S, 1, aad('c2s-rpc', one.id), Buffer.from('{}'));

      expect(two.open('rpc', 1, sealed)).toBeNull();
    });

    it('seals replies and events apart, on one counter of their own from 1', () => {
      const { table } = harness();
      const session = table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      const first = session.seal(Buffer.from('a'));
      const event = session.sealEvent(Buffer.from('b'));
      const second = session.seal(Buffer.from('c'));

      expect([first.n, second.n]).toEqual([1, 3]);
      const ct = Buffer.from(first.ct, 'base64url');
      expect(open(S2C, 1, aad('s2c-rpc', session.id), ct)?.toString()).toBe(
        'a',
      );
      expect(open(S2C, 1, aad('s2c-evt', session.id), ct)).toBeNull();
      const frame = Buffer.from(event, 'base64url');
      expect(frame.subarray(0, 8)).toEqual(nonce(2).subarray(4));
      const body = frame.subarray(8);
      expect(open(S2C, 2, aad('s2c-evt', session.id), body)?.toString()).toBe(
        'b',
      );
      expect(open(S2C, 2, aad('s2c-rpc', session.id), body)).toBeNull();
    });
  });

  describe('lifetime', () => {
    it('forgets a session idle for ten minutes', () => {
      const h = harness();
      const session = h.table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      h.advance(9 * MINUTE);
      expect(h.table.get(session.id, '10.0.0.2')).toBe(session);
      h.table.touch(session);
      h.advance(9 * MINUTE);
      expect(h.table.get(session.id, '10.0.0.2')).toBe(session);
      h.advance(10 * MINUTE);
      expect(h.table.get(session.id, '10.0.0.2')).toBeNull();
    });

    it('counts only what the caller vouches for as activity, not a lookup', () => {
      const h = harness();
      const session = h.table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      // Anyone who saw the sid can look it up; that keeps nothing alive.
      h.advance(9 * MINUTE);
      h.table.get(session.id, '10.0.0.2');
      h.advance(2 * MINUTE);
      expect(h.table.get(session.id, '10.0.0.2')).toBeNull();
    });

    it('binds a session to the address that shook hands', () => {
      const h = harness();
      const session = h.table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      expect(h.table.get(session.id, '10.0.0.9')).toBeNull();
      expect(h.table.get(session.id, '10.0.0.2')).toBe(session);
    });

    it('keeps a session alive while it holds an open stream', () => {
      const h = harness();
      const session = h.table.create('10.0.0.2', material());
      if (!session) throw new Error('no session');

      h.table.streamOpened(session);
      h.advance(60 * MINUTE);
      expect(h.table.get(session.id, '10.0.0.2')).toBe(session);
      h.table.streamClosed(session);
      h.advance(10 * MINUTE);
      expect(h.table.get(session.id, '10.0.0.2')).toBeNull();
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
      expect(table.get(a.id, '10.0.0.2')).toBeNull();
      expect(table.get(c.id, '10.0.0.4')).toBe(c);
      expect(table.dropAll()).toEqual([c.id]);
      expect(table.get(c.id, '10.0.0.4')).toBeNull();
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
      h.table.touch(old);

      const third = h.table.create('10.0.0.2', material());

      expect(third).not.toBeNull();
      expect(h.table.get(recent.id, '10.0.0.2')).toBeNull();
      expect(h.table.get(old.id, '10.0.0.2')).toBe(old);
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
      expect(h.table.get(first?.id ?? '', '10.0.0.2')).toBeNull();
      expect(h.table.size()).toBe(2);
    });
  });
});
