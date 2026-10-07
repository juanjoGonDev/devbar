import { describe, expect, it } from 'vitest';
import {
  aad,
  authMessage,
  AUTH_LABEL,
  concat,
  createReplayWindow,
  ephemeralKeyPair,
  fromB64,
  generateSigningKey,
  nonce,
  open,
  openEvent,
  PAIR_LABEL,
  pairMessage,
  REPLACE_LABEL,
  replaceMessage,
  REPLAY_WINDOW,
  ROTATE_LABEL,
  rotateMessage,
  safetyCode,
  sameBytes,
  seal,
  sign,
  signingPublicKey,
  toB64,
  transcript,
  utf8,
  verifySignature,
} from '../renderer/remote/rc-protocol.js';

/**
 * devbar-rc/1 on the phone (pure-JS @noble). Interoperability with the
 * desktop's node:crypto half is tests/remote-rc-cross.test.ts; this file pins
 * the phone module's own edges.
 */

const bytes = (from: number, length = 32): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (from + i) % 256);

describe('renderer/remote/rc-protocol.ts', () => {
  describe('base64url', () => {
    it('encodes without padding and decodes back', () => {
      expect(toB64(bytes(250, 5))).toBe('-vv8_f4');
      expect(fromB64('-vv8_f4')).toEqual(bytes(250, 5));
      expect(toB64(new Uint8Array())).toBe('');
    });

    it('refuses anything that is not canonical base64url', () => {
      for (const value of ['a+b', 'ab==', 'a b', 'ab/c', 42, null, 'AB', 'A'])
        expect(fromB64(value), String(value)).toBeNull();
    });

    it('holds a value to the expected length', () => {
      expect(fromB64(toB64(bytes(0)), 32)).toEqual(bytes(0));
      expect(fromB64(toB64(bytes(0, 31)), 32)).toBeNull();
    });
  });

  it('concatenates byte arrays in order', () => {
    expect(concat(bytes(1, 2), utf8('A'), bytes(9, 1))).toEqual(
      Uint8Array.from([1, 2, 65, 9]),
    );
  });

  it('builds the transcript as label ‖ identity ‖ C ‖ S ‖ sid', () => {
    const t = transcript(bytes(200), bytes(0), bytes(32), bytes(64, 16));
    expect(new TextDecoder().decode(t.subarray(0, 11))).toBe('devbar-rc/1');
    expect(t.subarray(11, 43)).toEqual(bytes(200));
    expect(t.subarray(43, 75)).toEqual(bytes(0));
    expect(t).toHaveLength(11 + 32 + 32 + 32 + 16);
  });

  it('refuses a low-order or malformed peer key', () => {
    const pair = ephemeralKeyPair();
    expect(pair.agree(new Uint8Array(32))).toBeNull();
    expect(pair.agree(bytes(0, 31))).toBeNull();
    expect(pair.agree(ephemeralKeyPair().publicKey)).toHaveLength(32);
  });

  it('signs and verifies, and never throws on garbage', () => {
    const { secretKey, publicKey } = generateSigningKey();
    expect(signingPublicKey(secretKey)).toEqual(publicKey);
    const signature = sign(secretKey, utf8('hola'));
    expect(verifySignature(publicKey, utf8('hola'), signature)).toBe(true);
    expect(verifySignature(publicKey, utf8('hola!'), signature)).toBe(false);
    expect(verifySignature(bytes(0, 3), utf8('x'), signature)).toBe(false);
    expect(verifySignature(publicKey, utf8('x'), bytes(0, 10))).toBe(false);
    expect(verifySignature(new Uint8Array(32), utf8('x'), signature)).toBe(
      false,
    );
  });

  it('binds the auth proof to the device id and the handshake', () => {
    expect(new TextDecoder().decode(authMessage('d1', utf8('T')))).toBe(
      'devbar-rc/1 authd1T',
    );
  });

  it('gives pairing and key rotation proofs labels of their own', () => {
    const decode = (value: Uint8Array) => new TextDecoder().decode(value);
    expect(decode(pairMessage(utf8('T')))).toBe(`${PAIR_LABEL}T`);
    expect(decode(rotateMessage(utf8('T')))).toBe(`${ROTATE_LABEL}T`);
    expect(new Set([AUTH_LABEL, PAIR_LABEL, ROTATE_LABEL]).size).toBe(3);
  });

  it('gives the proof that a re-pairing replaces an old device a label of its own', () => {
    const decode = (value: Uint8Array) => new TextDecoder().decode(value);
    expect(decode(replaceMessage(utf8('T')))).toBe(`${REPLACE_LABEL}T`);
    expect(
      new Set([AUTH_LABEL, PAIR_LABEL, ROTATE_LABEL, REPLACE_LABEL]).size,
    ).toBe(4);
  });

  it('puts the counter big-endian after four zero bytes', () => {
    expect(toB64(nonce(1))).toBe(
      toB64(Uint8Array.from([...new Array<number>(11).fill(0), 1])),
    );
    expect(nonce(2 ** 40 + 5)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5]),
    );
  });

  describe('sealing', () => {
    const key = bytes(7);

    it('opens what it sealed, and nothing that was touched', () => {
      const sealed = seal(key, 3, aad('c2s-rpc', 's'), utf8('{"op":1}'));
      expect(
        new TextDecoder().decode(
          open(key, 3, aad('c2s-rpc', 's'), sealed) ?? undefined,
        ),
      ).toBe('{"op":1}');
      expect(open(key, 4, aad('c2s-rpc', 's'), sealed)).toBeNull();
      expect(open(key, 3, aad('c2s-events', 's'), sealed)).toBeNull();
      expect(open(key, 3, aad('s2c-rpc', 's'), sealed)).toBeNull();
      expect(
        open(key, 3, aad('c2s-rpc', 's'), sealed.subarray(0, 5)),
      ).toBeNull();
    });

    it('reads an event frame back into its counter and plaintext', () => {
      const frame = toB64(
        concat(
          nonce(9).subarray(4),
          seal(key, 9, aad('s2c-evt', 's'), utf8('ev')),
        ),
      );
      const event = openEvent(key, aad('s2c-evt', 's'), frame);
      expect(event?.counter).toBe(9);
      expect(new TextDecoder().decode(event?.plaintext)).toBe('ev');
      expect(openEvent(key, aad('s2c-rpc', 's'), frame)).toBeNull();
      expect(openEvent(key, aad('s2c-evt', 't'), frame)).toBeNull();
      expect(openEvent(key, aad('s2c-evt', 's'), 'AAAA')).toBeNull();
      expect(openEvent(key, aad('s2c-evt', 's'), '%%%')).toBeNull();
    });
  });

  describe('createReplayWindow', () => {
    it('accepts each counter once and drops what fell behind', () => {
      const window = createReplayWindow();
      window.mark(2);
      expect(window.fresh(2)).toBe(false);
      expect(window.fresh(1)).toBe(true);
      window.mark(REPLAY_WINDOW + 5);
      expect(window.fresh(5)).toBe(false);
      expect(window.fresh(6)).toBe(true);
      expect(window.fresh(0)).toBe(false);
    });
  });

  it('matches the safety-code test vector', () => {
    expect(safetyCode(bytes(0), bytes(32))).toEqual([
      '96393',
      '02204',
      '00566',
      '61643',
      '68075',
      '55480',
    ]);
  });

  it('compares bytes without an early exit, lengths included', () => {
    expect(sameBytes(bytes(0), bytes(0))).toBe(true);
    expect(sameBytes(bytes(0), bytes(1))).toBe(false);
    expect(sameBytes(bytes(0, 2), bytes(0, 3))).toBe(false);
  });
});
