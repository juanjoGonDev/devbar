import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTH_LABEL,
  aad,
  authMessage,
  createReplayWindow,
  ephemeralKeyPair,
  fromB64,
  generateIdentity,
  identityFromSeed,
  nonce,
  open,
  REPLAY_WINDOW,
  safetyCode,
  seal,
  sealEvent,
  sameBytes,
  sessionKeys,
  toB64,
  transcript,
  verifySignature,
} from '../src/main/remote/rc-protocol.js';

/**
 * devbar-rc/1 on the desktop side (node:crypto). The phone's half is
 * renderer/remote/rc-protocol.ts; tests/remote-rc-cross.test.ts runs one
 * against the other.
 */

const bytes = (from: number, length = 32): Buffer =>
  Buffer.from(Array.from({ length }, (_, i) => (from + i) % 256));

describe('src/main/remote/rc-protocol.ts', () => {
  describe('base64url', () => {
    it('encodes without padding and decodes back', () => {
      const raw = bytes(250, 5);
      expect(toB64(raw)).toBe('-vv8_f4');
      expect(fromB64('-vv8_f4')).toEqual(raw);
    });

    it('refuses anything that is not canonical base64url', () => {
      for (const value of ['a+b', 'ab==', 'a b', 'ab/c', 42, null, 'AB'])
        expect(fromB64(value), String(value)).toBeNull();
    });

    it('holds a value to the expected length', () => {
      expect(fromB64(toB64(bytes(0)), 32)).toEqual(bytes(0));
      expect(fromB64(toB64(bytes(0, 31)), 32)).toBeNull();
    });
  });

  describe('the handshake', () => {
    it('builds the transcript as label ‖ C ‖ S ‖ sid', () => {
      const t = transcript(bytes(0), bytes(32), bytes(64, 16));
      expect(t.subarray(0, 11).toString('utf8')).toBe('devbar-rc/1');
      expect(t.subarray(11, 43)).toEqual(bytes(0));
      expect(t.subarray(43, 75)).toEqual(bytes(32));
      expect(t.subarray(75)).toEqual(bytes(64, 16));
    });

    it('agrees on the same secret from both ends of an X25519 exchange', () => {
      const client = ephemeralKeyPair();
      const server = ephemeralKeyPair();
      const one = client.agree(server.publicKey);
      expect(one).toHaveLength(32);
      expect(one).toEqual(server.agree(client.publicKey));
    });

    it('refuses a low-order or malformed peer key', () => {
      const pair = ephemeralKeyPair();
      expect(pair.agree(Buffer.alloc(32))).toBeNull();
      expect(pair.agree(bytes(0, 31))).toBeNull();
    });

    it('derives two different 32-byte keys, one per direction', () => {
      const t = transcript(bytes(0), bytes(32), bytes(64, 16));
      const keys = sessionKeys(bytes(100), t);
      const okm = Buffer.from(
        crypto.hkdfSync(
          'sha256',
          bytes(100),
          crypto.createHash('sha256').update(t).digest(),
          'devbar-rc/1 keys',
          64,
        ),
      );
      expect(keys.c2s).toEqual(okm.subarray(0, 32));
      expect(keys.s2c).toEqual(okm.subarray(32, 64));
    });
  });

  describe('signatures', () => {
    it('signs with an identity rebuilt from its seed and verifies with the raw key', () => {
      const { seed, publicKey } = generateIdentity();
      const identity = identityFromSeed(seed);
      expect(identity.publicKey).toEqual(publicKey);
      const signature = identity.sign(Buffer.from('hola'));
      expect(signature).toHaveLength(64);
      expect(verifySignature(publicKey, Buffer.from('hola'), signature)).toBe(
        true,
      );
      expect(verifySignature(publicKey, Buffer.from('adiós'), signature)).toBe(
        false,
      );
    });

    it('never throws on garbage keys or signatures', () => {
      expect(verifySignature(bytes(0, 3), Buffer.from('x'), bytes(0, 64))).toBe(
        false,
      );
      const { publicKey } = generateIdentity();
      expect(verifySignature(publicKey, Buffer.from('x'), bytes(0, 10))).toBe(
        false,
      );
    });

    it('prefixes the auth proof with its own label', () => {
      const t = Buffer.from('T');
      expect(authMessage(t).toString('utf8')).toBe(`${AUTH_LABEL}T`);
    });
  });

  describe('sealing', () => {
    const key = bytes(7);

    it('puts the counter big-endian after four zero bytes', () => {
      expect(nonce(1)).toEqual(Buffer.from('000000000000000000000001', 'hex'));
      expect(nonce(2 ** 40 + 5)).toEqual(
        Buffer.from('000000000000010000000005', 'hex'),
      );
    });

    it('binds the direction and the session id as associated data', () => {
      expect(aad('c2s', 'abc').toString('utf8')).toBe('c2s abc');
      expect(aad('s2c', 'abc').toString('utf8')).toBe('s2c abc');
    });

    it('opens what it sealed, and nothing that was touched', () => {
      const sealed = seal(key, 3, aad('c2s', 's'), Buffer.from('{"op":1}'));
      expect(sealed).toHaveLength(8 + 16);
      expect(open(key, 3, aad('c2s', 's'), sealed)?.toString()).toBe(
        '{"op":1}',
      );
      expect(open(key, 4, aad('c2s', 's'), sealed)).toBeNull();
      expect(open(key, 3, aad('s2c', 's'), sealed)).toBeNull();
      expect(open(key, 3, aad('c2s', 't'), sealed)).toBeNull();
      expect(open(bytes(8), 3, aad('c2s', 's'), sealed)).toBeNull();
      const flipped = Buffer.from(sealed);
      flipped[0] = (flipped[0] ?? 0) ^ 1;
      expect(open(key, 3, aad('c2s', 's'), flipped)).toBeNull();
      expect(open(key, 3, aad('c2s', 's'), sealed.subarray(0, 10))).toBeNull();
    });

    it('frames an event as base64url of counter ‖ ciphertext', () => {
      const frame = Buffer.from(
        sealEvent(key, 9, aad('s2c', 's'), Buffer.from('ev')),
        'base64url',
      );
      expect(frame.readUInt32BE(0)).toBe(0);
      expect(frame.readUInt32BE(4)).toBe(9);
      expect(open(key, 9, aad('s2c', 's'), frame.subarray(8))?.toString()).toBe(
        'ev',
      );
    });
  });

  describe('createReplayWindow', () => {
    it('accepts each counter once, in any order inside the window', () => {
      const window = createReplayWindow();
      for (const n of [1, 3, 2]) {
        expect(window.fresh(n), String(n)).toBe(true);
        window.mark(n);
      }
      expect(window.fresh(2)).toBe(false);
      expect(window.fresh(4)).toBe(true);
    });

    it('refuses counters that fell behind the window', () => {
      const window = createReplayWindow();
      window.mark(REPLAY_WINDOW + 10);
      expect(window.fresh(10)).toBe(false);
      expect(window.fresh(11)).toBe(true);
    });

    it('refuses zero, negatives, fractions and unsafe integers', () => {
      const window = createReplayWindow();
      for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
        expect(window.fresh(n), String(n)).toBe(false);
    });
  });

  describe('safetyCode', () => {
    it('matches the published test vector', () => {
      // Computed independently (Python hashlib) for these exact inputs.
      expect(safetyCode(bytes(0), bytes(32))).toEqual([
        '96393',
        '02204',
        '00566',
        '61643',
        '68075',
        '55480',
      ]);
    });

    it('changes when either key changes', () => {
      const base = safetyCode(bytes(0), bytes(32)).join(' ');
      expect(safetyCode(bytes(1), bytes(32)).join(' ')).not.toBe(base);
      expect(safetyCode(bytes(0), bytes(33)).join(' ')).not.toBe(base);
    });
  });

  describe('sameBytes', () => {
    it('compares in constant time, lengths included', () => {
      expect(sameBytes(bytes(0), bytes(0))).toBe(true);
      expect(sameBytes(bytes(0), bytes(1))).toBe(false);
      expect(sameBytes(bytes(0, 3), bytes(0, 4))).toBe(false);
    });
  });
});
