import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * devbar-rc/1 on the phone: the same protocol as src/main/remote/rc-protocol.ts
 * (read that header for the whole design), built on the audited pure-JS
 * @noble libraries. A page served over http://<LAN IP> is not a secure
 * context, so the browser hides `crypto.subtle` — only
 * `crypto.getRandomValues`, which @noble draws its randomness from, is left.
 *
 * The constants are duplicated on purpose (this page imports nothing from
 * src/); tests/remote-rc-cross.test.ts fails the moment the two drift.
 */

export const PROTOCOL = 'devbar-rc/1';
export const PROTOCOL_VERSION = 1;
export const KEYS_LABEL = 'devbar-rc/1 keys';
export const AUTH_LABEL = 'devbar-rc/1 auth';
export const SAFETY_LABEL = 'devbar-rc/1 safety';
export const KEY_BYTES = 32;
export const SID_BYTES = 16;
export const SIGNATURE_BYTES = 64;
export const REPLAY_WINDOW = 1024;

type Bytes = Uint8Array;
const B64URL = /^[A-Za-z0-9_-]*$/;
const COUNTER_BYTES = 8;

export const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toB64(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Canonical unpadded base64url only, else null. */
export function fromB64(value: unknown, length?: number): Bytes | null {
  if (typeof value !== 'string' || !B64URL.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (toB64(decoded) !== value) return null;
  if (length !== undefined && decoded.length !== length) return null;
  return decoded;
}

/** Equality that looks at every byte, so timing says nothing. */
export function sameBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function transcript(
  clientPub: Bytes,
  serverPub: Bytes,
  sid: Bytes,
): Bytes {
  return concat(utf8(PROTOCOL), clientPub, serverPub, sid);
}

export function sessionKeys(
  shared: Bytes,
  handshake: Bytes,
): { c2s: Bytes; s2c: Bytes } {
  const okm = hkdf(sha256, shared, sha256(handshake), utf8(KEYS_LABEL), 64);
  return { c2s: okm.slice(0, KEY_BYTES), s2c: okm.slice(KEY_BYTES) };
}

export function ephemeralKeyPair(): {
  publicKey: Bytes;
  agree(peer: Bytes): Bytes | null;
} {
  const secretKey = x25519.utils.randomSecretKey();
  return {
    publicKey: x25519.getPublicKey(secretKey),
    agree: (peer) => {
      if (peer.length !== KEY_BYTES) return null;
      try {
        const shared = x25519.getSharedSecret(secretKey, peer);
        return shared.some((byte) => byte !== 0) ? shared : null;
      } catch {
        return null;
      }
    },
  };
}

export function generateSigningKey(): { secretKey: Bytes; publicKey: Bytes } {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export const signingPublicKey = (secretKey: Bytes): Bytes =>
  ed25519.getPublicKey(secretKey);

export const sign = (secretKey: Bytes, data: Bytes): Bytes =>
  ed25519.sign(data, secretKey);

/** Strict RFC 8032 verification; false, never a throw, on bad input. */
export function verifySignature(
  publicKey: Bytes,
  data: Bytes,
  signature: Bytes,
): boolean {
  if (publicKey.length !== KEY_BYTES || signature.length !== SIGNATURE_BYTES)
    return false;
  try {
    return ed25519.verify(signature, data, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export const authMessage = (handshake: Bytes): Bytes =>
  concat(utf8(AUTH_LABEL), handshake);

export const aad = (direction: 'c2s' | 's2c', sid: string): Bytes =>
  utf8(`${direction} ${sid}`);

export function nonce(counter: number): Bytes {
  const value = new Uint8Array(12);
  const view = new DataView(value.buffer);
  view.setUint32(4, Math.floor(counter / 2 ** 32));
  view.setUint32(8, counter >>> 0);
  return value;
}

export const seal = (
  key: Bytes,
  counter: number,
  associated: Bytes,
  plaintext: Bytes,
): Bytes =>
  chacha20poly1305(key, nonce(counter), associated).encrypt(plaintext);

export function open(
  key: Bytes,
  counter: number,
  associated: Bytes,
  sealed: Bytes,
): Bytes | null {
  try {
    return chacha20poly1305(key, nonce(counter), associated).decrypt(sealed);
  } catch {
    return null;
  }
}

/** An SSE `data:` payload: base64url(uint64-BE(counter) ‖ ciphertext). */
export function openEvent(
  key: Bytes,
  associated: Bytes,
  data: string,
): { counter: number; plaintext: Bytes } | null {
  const frame = fromB64(data);
  if (!frame || frame.length <= COUNTER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, COUNTER_BYTES);
  const counter = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
  const plaintext = open(
    key,
    counter,
    associated,
    frame.subarray(COUNTER_BYTES),
  );
  return plaintext ? { counter, plaintext } : null;
}

export interface ReplayWindow {
  fresh(counter: number): boolean;
  mark(counter: number): void;
}

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

/** The six 5-digit groups both screens show for one device. */
export function safetyCode(serverIdPub: Bytes, devicePub: Bytes): string[] {
  const digest = sha256(concat(utf8(SAFETY_LABEL), serverIdPub, devicePub));
  return Array.from({ length: 6 }, (_, group) => {
    let value = 0;
    for (let i = 0; i < 5; i++)
      value = value * 256 + (digest[group * 5 + i] ?? 0);
    return String(value % 100_000).padStart(5, '0');
  });
}
