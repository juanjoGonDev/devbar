import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as phone from '../renderer/remote/rc-protocol.js';
import * as desk from '../src/main/remote/rc-protocol.js';

/**
 * devbar-rc/1 across the two implementations: the phone's pure-JS @noble
 * module against the desktop's node:crypto one, byte for byte. If either
 * side drifts — a constant, the nonce layout, the KDF, the frame — a phone
 * and a computer would stop understanding each other, and this file is
 * where that shows up first.
 */

const SHARED_CONSTANTS = [
  'PROTOCOL',
  'PROTOCOL_VERSION',
  'KEYS_LABEL',
  'AUTH_LABEL',
  'SAFETY_LABEL',
  'KEY_BYTES',
  'SID_BYTES',
  'SIGNATURE_BYTES',
  'REPLAY_WINDOW',
] as const;

/** One complete handshake: the phone starts, the desktop answers. */
function handshake() {
  const identity = desk.generateIdentity();
  const signer = desk.identityFromSeed(identity.seed);
  const client = phone.ephemeralKeyPair();
  const server = desk.ephemeralKeyPair();
  const sidBytes = crypto.randomBytes(desk.SID_BYTES);
  const sid = desk.toB64(sidBytes);
  const serverT = desk.transcript(client.publicKey, server.publicKey, sidBytes);
  const signature = signer.sign(serverT);
  const serverShared = server.agree(client.publicKey);
  if (!serverShared) throw new Error('server agreement failed');
  const serverKeys = desk.sessionKeys(serverShared, serverT);

  // The phone rebuilds T from what crossed the wire.
  const phoneT = phone.transcript(
    client.publicKey,
    server.publicKey,
    phone.fromB64(sid) ?? new Uint8Array(),
  );
  const phoneShared = client.agree(server.publicKey);
  if (!phoneShared) throw new Error('phone agreement failed');
  const phoneKeys = phone.sessionKeys(phoneShared, phoneT);
  return {
    identity,
    signature,
    sid,
    serverT,
    phoneT,
    serverKeys,
    phoneKeys,
  };
}

const text = (bytes: Uint8Array | null): string =>
  bytes ? new TextDecoder().decode(bytes) : '<null>';

describe('devbar-rc/1 across implementations', () => {
  it.each(SHARED_CONSTANTS)('agrees on %s', (name) => {
    expect(phone[name]).toBe(desk[name]);
  });

  describe('the handshake', () => {
    it('derives the same transcript and the same keys on both sides', () => {
      const h = handshake();
      expect(Buffer.from(h.phoneT)).toEqual(h.serverT);
      expect(Buffer.from(h.phoneKeys.c2s)).toEqual(h.serverKeys.c2s);
      expect(Buffer.from(h.phoneKeys.s2c)).toEqual(h.serverKeys.s2c);
      expect(Buffer.from(h.phoneKeys.c2s)).not.toEqual(h.serverKeys.s2c);
    });

    it("lets the phone verify the desktop's signature over the transcript", () => {
      const h = handshake();
      expect(
        phone.verifySignature(h.identity.publicKey, h.phoneT, h.signature),
      ).toBe(true);
    });

    it('rejects a signature from any other identity (wrong server key)', () => {
      const h = handshake();
      const other = desk.generateIdentity();
      expect(
        phone.verifySignature(other.publicKey, h.phoneT, h.signature),
      ).toBe(false);
    });

    it('rejects a signature over a different session id', () => {
      const h = handshake();
      const tampered = Uint8Array.from(h.phoneT);
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
      expect(
        phone.verifySignature(h.identity.publicKey, tampered, h.signature),
      ).toBe(false);
    });

    it("lets the desktop verify the device's auth proof", () => {
      const h = handshake();
      const device = phone.generateSigningKey();
      const proof = phone.sign(device.secretKey, phone.authMessage(h.phoneT));
      expect(
        desk.verifySignature(
          Buffer.from(device.publicKey),
          desk.authMessage(h.serverT),
          Buffer.from(proof),
        ),
      ).toBe(true);
      // The proof is bound to this handshake: replaying it elsewhere fails.
      expect(
        desk.verifySignature(
          Buffer.from(device.publicKey),
          desk.authMessage(handshake().serverT),
          Buffer.from(proof),
        ),
      ).toBe(false);
    });
  });

  describe('messages', () => {
    it('round-trips a request phone → desktop and a response back', () => {
      const h = handshake();
      const request = phone.seal(
        h.phoneKeys.c2s,
        1,
        phone.aad('c2s', h.sid),
        phone.utf8('{"op":"state","args":{}}'),
      );
      const opened = desk.open(
        h.serverKeys.c2s,
        1,
        desk.aad('c2s', h.sid),
        Buffer.from(request),
      );
      expect(text(opened)).toBe('{"op":"state","args":{}}');

      const response = desk.seal(
        h.serverKeys.s2c,
        1,
        desk.aad('s2c', h.sid),
        Buffer.from('{"status":200,"body":{}}'),
      );
      expect(
        text(phone.open(h.phoneKeys.s2c, 1, phone.aad('s2c', h.sid), response)),
      ).toBe('{"status":200,"body":{}}');
    });

    it('opens an SSE frame sealed by the desktop', () => {
      const h = handshake();
      const frame = desk.sealEvent(
        h.serverKeys.s2c,
        7,
        desk.aad('s2c', h.sid),
        Buffer.from('{"type":"state","data":{}}'),
      );
      const event = phone.openEvent(
        h.phoneKeys.s2c,
        phone.aad('s2c', h.sid),
        frame,
      );
      expect(event?.counter).toBe(7);
      expect(text(event?.plaintext ?? null)).toBe('{"type":"state","data":{}}');
    });

    it('refuses tampered ciphertext, a different AAD and a different sid', () => {
      const h = handshake();
      const sealed = Buffer.from(
        phone.seal(
          h.phoneKeys.c2s,
          2,
          phone.aad('c2s', h.sid),
          phone.utf8('x'),
        ),
      );
      const flipped = Buffer.from(sealed);
      flipped[0] = (flipped[0] ?? 0) ^ 0x80;
      const key = h.serverKeys.c2s;
      expect(desk.open(key, 2, desk.aad('c2s', h.sid), flipped)).toBeNull();
      expect(desk.open(key, 2, desk.aad('s2c', h.sid), sealed)).toBeNull();
      expect(desk.open(key, 2, desk.aad('c2s', 'other'), sealed)).toBeNull();
      expect(desk.open(key, 3, desk.aad('c2s', h.sid), sealed)).toBeNull();
      // And the keys of another session open nothing.
      const other = handshake();
      expect(
        desk.open(other.serverKeys.c2s, 2, desk.aad('c2s', h.sid), sealed),
      ).toBeNull();
    });

    it('applies the same replay window on both sides', () => {
      const desktop = desk.createReplayWindow();
      const handset = phone.createReplayWindow();
      for (const n of [5, 1, 1030, 4]) {
        expect(handset.fresh(n)).toBe(desktop.fresh(n));
        desktop.mark(n);
        handset.mark(n);
      }
      for (const n of [1, 5, 6, 7, 1031])
        expect(handset.fresh(n), String(n)).toBe(desktop.fresh(n));
    });
  });

  it('computes the same safety code for random keys', () => {
    for (let i = 0; i < 5; i++) {
      const server = crypto.randomBytes(32);
      const device = crypto.randomBytes(32);
      expect(phone.safetyCode(server, device)).toEqual(
        desk.safetyCode(server, device),
      );
    }
  });

  it('encodes base64url identically', () => {
    for (const length of [0, 1, 2, 3, 16, 31, 32, 64]) {
      const raw = crypto.randomBytes(length);
      expect(phone.toB64(raw)).toBe(desk.toB64(raw));
      expect(Buffer.from(phone.fromB64(desk.toB64(raw)) ?? [])).toEqual(raw);
    }
  });
});
