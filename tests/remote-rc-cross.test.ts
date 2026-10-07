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
  'PAIR_LABEL',
  'ROTATE_LABEL',
  'REPLACE_LABEL',
  'SAFETY_LABEL',
  'EVENTS_PROOF',
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
  const serverT = desk.transcript(
    identity.publicKey,
    client.publicKey,
    server.publicKey,
    sidBytes,
  );
  const signature = signer.sign(serverT);
  const serverShared = server.agree(client.publicKey);
  if (!serverShared) throw new Error('server agreement failed');
  const serverKeys = desk.sessionKeys(serverShared, serverT);

  // The phone rebuilds T from what crossed the wire.
  const phoneT = phone.transcript(
    identity.publicKey,
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

  it('labels the associated data of each purpose the same way', () => {
    expect(phone.AAD_LABELS).toEqual(desk.AAD_LABELS);
    expect(new Set(desk.AAD_LABELS).size).toBe(4);
    for (const label of desk.AAD_LABELS)
      expect(Buffer.from(phone.aad(label, 'sid'))).toEqual(
        desk.aad(label, 'sid'),
      );
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

    it('binds the identity key into the transcript the desktop signs', () => {
      const h = handshake();
      const other = desk.generateIdentity().publicKey;
      const swapped = Uint8Array.from(h.phoneT);
      swapped.set(other, desk.PROTOCOL.length);
      expect(
        phone.verifySignature(h.identity.publicKey, swapped, h.signature),
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
      const proof = phone.sign(
        device.secretKey,
        phone.authMessage('d1', h.phoneT),
      );
      const key = Buffer.from(device.publicKey);
      expect(
        desk.verifySignature(
          key,
          desk.authMessage('d1', h.serverT),
          Buffer.from(proof),
        ),
      ).toBe(true);
      // Bound to this handshake and this device id: anywhere else it fails.
      expect(
        desk.verifySignature(
          key,
          desk.authMessage('d1', handshake().serverT),
          Buffer.from(proof),
        ),
      ).toBe(false);
      expect(
        desk.verifySignature(
          key,
          desk.authMessage('d2', h.serverT),
          Buffer.from(proof),
        ),
      ).toBe(false);
    });

    it("lets the desktop check a new key's pairing and rotation proofs", () => {
      const h = handshake();
      const device = phone.generateSigningKey();
      const key = Buffer.from(device.publicKey);
      const pair = phone.sign(device.secretKey, phone.pairMessage(h.phoneT));
      const rotate = phone.sign(
        device.secretKey,
        phone.rotateMessage(h.phoneT),
      );
      expect(
        desk.verifySignature(
          key,
          desk.pairMessage(h.serverT),
          Buffer.from(pair),
        ),
      ).toBe(true);
      expect(
        desk.verifySignature(
          key,
          desk.rotateMessage(h.serverT),
          Buffer.from(rotate),
        ),
      ).toBe(true);
      // Neither proof stands in for the other, or for an auth.
      expect(
        desk.verifySignature(
          key,
          desk.rotateMessage(h.serverT),
          Buffer.from(pair),
        ),
      ).toBe(false);
      expect(desk.isStrongPublicKey(key)).toBe(true);
    });

    it("lets the desktop check an old key's proof that a re-pairing replaces it", () => {
      const h = handshake();
      const old = phone.generateSigningKey();
      const key = Buffer.from(old.publicKey);
      const replace = phone.sign(old.secretKey, phone.replaceMessage(h.phoneT));
      expect(
        desk.verifySignature(
          key,
          desk.replaceMessage(h.serverT),
          Buffer.from(replace),
        ),
      ).toBe(true);
      // Bound to this handshake, and no stand-in for a pairing proof.
      expect(
        desk.verifySignature(
          key,
          desk.replaceMessage(handshake().serverT),
          Buffer.from(replace),
        ),
      ).toBe(false);
      expect(
        desk.verifySignature(
          key,
          desk.pairMessage(h.serverT),
          Buffer.from(replace),
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
        phone.aad('c2s-rpc', h.sid),
        phone.utf8('{"op":"state","args":{}}'),
      );
      const opened = desk.open(
        h.serverKeys.c2s,
        1,
        desk.aad('c2s-rpc', h.sid),
        Buffer.from(request),
      );
      expect(text(opened)).toBe('{"op":"state","args":{}}');

      const response = desk.seal(
        h.serverKeys.s2c,
        1,
        desk.aad('s2c-rpc', h.sid),
        Buffer.from('{"re":1,"status":200,"body":{}}'),
      );
      expect(
        text(
          phone.open(h.phoneKeys.s2c, 1, phone.aad('s2c-rpc', h.sid), response),
        ),
      ).toBe('{"re":1,"status":200,"body":{}}');
    });

    it("opens the phone's event-stream proof on the desktop, and only as one", () => {
      const h = handshake();
      const proof = phone.seal(
        h.phoneKeys.c2s,
        4,
        phone.aad('c2s-events', h.sid),
        phone.utf8(phone.EVENTS_PROOF),
      );
      const key = h.serverKeys.c2s;
      expect(
        text(
          desk.open(key, 4, desk.aad('c2s-events', h.sid), Buffer.from(proof)),
        ),
      ).toBe(desk.EVENTS_PROOF);
      expect(
        desk.open(key, 4, desk.aad('c2s-rpc', h.sid), Buffer.from(proof)),
      ).toBeNull();
    });

    it('opens an SSE frame sealed by the desktop', () => {
      const h = handshake();
      const frame = desk.sealEvent(
        h.serverKeys.s2c,
        7,
        desk.aad('s2c-evt', h.sid),
        Buffer.from('{"type":"state","data":{}}'),
      );
      const event = phone.openEvent(
        h.phoneKeys.s2c,
        phone.aad('s2c-evt', h.sid),
        frame,
      );
      expect(event?.counter).toBe(7);
      expect(text(event?.plaintext ?? null)).toBe('{"type":"state","data":{}}');
      // A frame never reads as an RPC reply.
      expect(
        phone.openEvent(h.phoneKeys.s2c, phone.aad('s2c-rpc', h.sid), frame),
      ).toBeNull();
    });

    it('refuses tampered ciphertext, a different AAD and a different sid', () => {
      const h = handshake();
      const sealed = Buffer.from(
        phone.seal(
          h.phoneKeys.c2s,
          2,
          phone.aad('c2s-rpc', h.sid),
          phone.utf8('x'),
        ),
      );
      const flipped = Buffer.from(sealed);
      flipped[0] = (flipped[0] ?? 0) ^ 0x80;
      const key = h.serverKeys.c2s;
      const rpc = desk.aad('c2s-rpc', h.sid);
      expect(desk.open(key, 2, rpc, flipped)).toBeNull();
      expect(desk.open(key, 2, desk.aad('s2c-rpc', h.sid), sealed)).toBeNull();
      expect(
        desk.open(key, 2, desk.aad('c2s-rpc', 'other'), sealed),
      ).toBeNull();
      expect(desk.open(key, 3, rpc, sealed)).toBeNull();
      // And the keys of another session open nothing.
      const other = handshake();
      expect(desk.open(other.serverKeys.c2s, 2, rpc, sealed)).toBeNull();
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
