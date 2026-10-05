import crypto from 'node:crypto';

/**
 * devbar-rc/1, the application-level encryption of «Control remoto», on the
 * desktop side (node:crypto only). The phone's half is
 * renderer/remote/rc-protocol.ts (pure-JS @noble, because a page served over
 * http://<LAN IP> gets no `crypto.subtle`); tests/remote-rc-cross.test.ts
 * runs each against the other, and checks that the constants below match.
 *
 *   Handshake  phone ephemeral X25519 C, desktop ephemeral X25519 S, a random
 *              16-byte sid; T = "devbar-rc/1" ‖ C ‖ S ‖ sid is signed with
 *              the desktop's long-term Ed25519 identity. Fresh keys on every
 *              handshake: a key stolen later decrypts nothing recorded before.
 *   Keys       HKDF-SHA256(X25519(C, S), salt = SHA-256(T),
 *              info = "devbar-rc/1 keys") → 64 bytes: phone→desktop, then
 *              desktop→phone.
 *   Messages   ChaCha20-Poly1305, nonce = 4 zero bytes ‖ uint64-BE(counter),
 *              AAD = "c2s <sid>" or "s2c <sid>", one counter per direction.
 *
 * What this buys over plain HTTP: a passive listener on the network sees
 * only ciphertext, and — because the phone pins the identity key it got from
 * a QR on this screen — nobody can sit in the middle of the key exchange.
 * The page's own JavaScript still travels over HTTP, so an active attacker
 * who rewrites that script is out of scope.
 */

export const PROTOCOL = 'devbar-rc/1';
export const PROTOCOL_VERSION = 1;
export const KEYS_LABEL = 'devbar-rc/1 keys';
export const AUTH_LABEL = 'devbar-rc/1 auth';
export const SAFETY_LABEL = 'devbar-rc/1 safety';
export const KEY_BYTES = 32;
export const SID_BYTES = 16;
export const SIGNATURE_BYTES = 64;
/** How far behind the newest counter a message may still arrive. */
export const REPLAY_WINDOW = 1024;

const B64URL = /^[A-Za-z0-9_-]*$/;
const TAG_BYTES = 16;
/** DER headers that turn a raw 32-byte key into what node:crypto imports. */
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export type Direction = 'c2s' | 's2c';

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Canonical unpadded base64url only (one encoding per value), else null. */
export function fromB64(value: unknown, length?: number): Buffer | null {
  if (typeof value !== 'string' || !B64URL.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) return null;
  if (length !== undefined && decoded.length !== length) return null;
  return decoded;
}

/** Constant-time equality; different lengths are simply unequal. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function transcript(
  clientPub: Uint8Array,
  serverPub: Uint8Array,
  sid: Uint8Array,
): Buffer {
  return Buffer.concat([Buffer.from(PROTOCOL), clientPub, serverPub, sid]);
}

export function sessionKeys(
  shared: Uint8Array,
  handshake: Uint8Array,
): { c2s: Buffer; s2c: Buffer } {
  const salt = crypto.createHash('sha256').update(handshake).digest();
  const okm = Buffer.from(
    crypto.hkdfSync('sha256', shared, salt, KEYS_LABEL, 2 * KEY_BYTES),
  );
  return { c2s: okm.subarray(0, KEY_BYTES), s2c: okm.subarray(KEY_BYTES) };
}

/** An ephemeral X25519 key pair; `agree` is null for a bad peer key. */
export function ephemeralKeyPair(): {
  publicKey: Buffer;
  agree(peer: Uint8Array): Buffer | null;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(X25519_SPKI.length),
    agree: (peer) => {
      if (peer.length !== KEY_BYTES) return null;
      try {
        const shared = crypto.diffieHellman({
          privateKey,
          publicKey: crypto.createPublicKey({
            key: Buffer.concat([X25519_SPKI, peer]),
            format: 'der',
            type: 'spki',
          }),
        });
        // A low-order peer point yields all zeros: never a key.
        return shared.some((byte) => byte !== 0) ? shared : null;
      } catch {
        return null;
      }
    },
  };
}

export interface Identity {
  publicKey: Buffer;
  sign(data: Uint8Array): Buffer;
}

/** A new Ed25519 identity: the 32-byte seed and the raw public key. */
export function generateIdentity(): { seed: Buffer; publicKey: Buffer } {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(ED25519_PKCS8.length);
  return { seed, publicKey: identityFromSeed(seed).publicKey };
}

export function identityFromSeed(seed: Uint8Array): Identity {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(ED25519_SPKI.length);
  return {
    publicKey,
    sign: (data) => crypto.sign(null, data, privateKey),
  };
}

/** Ed25519 verification that answers false, never throws, on bad input. */
export function verifySignature(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== KEY_BYTES || signature.length !== SIGNATURE_BYTES)
    return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI, publicKey]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, data, key, signature);
  } catch {
    return false;
  }
}

/** What a device signs to prove it holds its key, bound to one handshake. */
export function authMessage(handshake: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(AUTH_LABEL), handshake]);
}

export function aad(direction: Direction, sid: string): Buffer {
  return Buffer.from(`${direction} ${sid}`);
}

export function nonce(counter: number): Buffer {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(Math.floor(counter / 2 ** 32), 4);
  value.writeUInt32BE(counter >>> 0, 8);
  return value;
}

/** ChaCha20-Poly1305: ciphertext ‖ 16-byte tag. */
export function seal(
  key: Uint8Array,
  counter: number,
  associated: Uint8Array,
  plaintext: Uint8Array,
): Buffer {
  const cipher = crypto.createCipheriv(
    'chacha20-poly1305',
    key,
    nonce(counter),
    {
      authTagLength: TAG_BYTES,
    },
  );
  cipher.setAAD(associated, { plaintextLength: plaintext.length });
  return Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

/** The plaintext, or null when anything about the message is off. */
export function open(
  key: Uint8Array,
  counter: number,
  associated: Uint8Array,
  sealed: Uint8Array,
): Buffer | null {
  if (sealed.length < TAG_BYTES) return null;
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv(
      'chacha20-poly1305',
      key,
      nonce(counter),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(associated, { plaintextLength: body.length });
    decipher.setAuthTag(sealed.subarray(body.length));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

/** One SSE `data:` payload: base64url(uint64-BE(counter) ‖ ciphertext). */
export function sealEvent(
  key: Uint8Array,
  counter: number,
  associated: Uint8Array,
  plaintext: Uint8Array,
): string {
  const head = nonce(counter).subarray(4);
  return toB64(
    Buffer.concat([head, seal(key, counter, associated, plaintext)]),
  );
}

export interface ReplayWindow {
  /** Not seen yet, and not older than the window. */
  fresh(counter: number): boolean;
  /** Records a counter whose message authenticated. */
  mark(counter: number): void;
}

/** WireGuard-style sliding window over one direction's counters. */
export function createReplayWindow(size = REPLAY_WINDOW): ReplayWindow {
  let highest = 0;
  const seen = new Set<number>();
  return {
    fresh: (counter) =>
      Number.isSafeInteger(counter) &&
      counter >= 1 &&
      counter > highest - size &&
      !seen.has(counter),
    mark: (counter) => {
      seen.add(counter);
      if (counter <= highest) return;
      highest = counter;
      for (const old of seen) if (old <= highest - size) seen.delete(old);
    },
  };
}

/**
 * The code both screens show for one device: SHA-256 over the label and the
 * two public keys, read as six 5-byte big-endian numbers, each mod 100000.
 */
export function safetyCode(
  serverIdPub: Uint8Array,
  devicePub: Uint8Array,
): string[] {
  const digest = crypto
    .createHash('sha256')
    .update(SAFETY_LABEL)
    .update(serverIdPub)
    .update(devicePub)
    .digest();
  return Array.from({ length: 6 }, (_, i) =>
    String(digest.readUIntBE(i * 5, 5) % 100_000).padStart(5, '0'),
  );
}
