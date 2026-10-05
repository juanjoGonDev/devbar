import crypto from 'node:crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

/**
 * devbar-rc/1, the application-level encryption of «Control remoto», on the
 * desktop side (node:crypto only). The phone's half is
 * renderer/remote/rc-protocol.ts (pure-JS @noble, because a page served over
 * http://<LAN IP> gets no `crypto.subtle`); tests/remote-rc-cross.test.ts
 * runs each against the other, and checks that the constants below match.
 *
 *   Handshake  phone ephemeral X25519 C, desktop ephemeral X25519 S, a random
 *              16-byte sid; T = "devbar-rc/1" ‖ I ‖ C ‖ S ‖ sid, where I is
 *              the desktop's long-term Ed25519 identity key, is signed with
 *              that identity. Fresh keys on every handshake: a key stolen
 *              later decrypts nothing recorded before.
 *   Keys       HKDF-SHA256(X25519(C, S), salt = SHA-256(T),
 *              info = "devbar-rc/1 keys") → 64 bytes: phone→desktop, then
 *              desktop→phone.
 *   Devices    an Ed25519 key per phone. It signs "devbar-rc/1 auth" ‖ id ‖ T
 *              to sign in, and a NEW key signs "devbar-rc/1 pair" ‖ T or
 *              "devbar-rc/1 rotate" ‖ T to prove it is held before the desktop
 *              stores it; small-order and non-canonical keys are refused.
 *              T has a fixed length, so each concatenation reads one way only.
 *   Messages   ChaCha20-Poly1305, nonce = 4 zero bytes ‖ uint64-BE(counter),
 *              one counter per direction, AAD = "<purpose> <sid>": c2s-rpc
 *              (a call), c2s-events (the proof that opens an event stream),
 *              s2c-rpc (a reply, which names the call it answers) and s2c-evt
 *              (an event frame) — no message passes for another kind.
 *
 * What this buys over plain HTTP: a passive listener on the network sees
 * only ciphertext, and — because the phone pins the identity key it got from
 * a QR on this screen — nobody can sit in the middle of the key exchange.
 *
 * What it cannot buy: the page itself. It is not a secure context, so the
 * phone keeps its device key in localStorage, and it fetches the page's
 * JavaScript over plain HTTP on every load. Anyone who can answer on this
 * computer's IP:port — the laptop asleep or off, the DHCP lease handed to
 * another machine, an ARP spoof — serves that origin's script, which reads
 * the device key and can later sign in as that phone from anywhere on the
 * LAN. The desktop's answer is detection, not prevention: a device that
 * signs in from an IP it has not used before raises a security banner here
 * (src/main/remote/remote-control.ts), whatever the notification settings,
 * so the user can unlink it. Closing this for good needs a secure context
 * (HTTPS with a certificate the phone trusts), which a LAN address cannot
 * get.
 *
 * The desktop's half: the seed of its identity key is stored as it is, in
 * the config file, which only this user can read and write (0600, like a
 * key in ~/.ssh — src/main/remote/identity.ts). Other accounts on this
 * computer cannot read it; a program running as this user can, and with it
 * pose as this computer to the linked phones. It is not kept in the OS
 * keychain: DevBar releases are ad-hoc signed, so to macOS every update is a
 * different app that may not open the keychain item the last one sealed the
 * seed with — the identity would be lost, and every phone verified again,
 * on each update.
 */

export const PROTOCOL = 'devbar-rc/1';
export const PROTOCOL_VERSION = 1;
export const KEYS_LABEL = 'devbar-rc/1 keys';
export const AUTH_LABEL = 'devbar-rc/1 auth';
export const PAIR_LABEL = 'devbar-rc/1 pair';
export const ROTATE_LABEL = 'devbar-rc/1 rotate';
export const SAFETY_LABEL = 'devbar-rc/1 safety';
/** The plaintext of the sealed proof that opens an event stream. */
export const EVENTS_PROOF = 'events';
/** What each sealed message is for, bound in as associated data. */
export const AAD_LABELS = [
  'c2s-rpc',
  'c2s-events',
  's2c-rpc',
  's2c-evt',
] as const;
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

export type AadLabel = (typeof AAD_LABELS)[number];

/** 2^255 − 19, the field of Curve25519. */
const FIELD_P = 2n ** 255n - 19n;
/**
 * The y coordinates of the eight points of small order (y = 0, 1, −1 and the
 * two of order 8); with the sign bit either way, they are every encoding of
 * the torsion subgroup a public key could be.
 */
const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([
  0n,
  1n,
  FIELD_P - 1n,
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  FIELD_P -
    2707385501144840649318225287225658788936804267575313519463743609750303402022n,
]);

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
  identityPub: Uint8Array,
  clientPub: Uint8Array,
  serverPub: Uint8Array,
  sid: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from(PROTOCOL),
    identityPub,
    clientPub,
    serverPub,
    sid,
  ]);
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

/**
 * A device key worth storing: a canonical encoding (y < p) of a point outside
 * the small-order subgroup. OpenSSL takes the identity point as a key and
 * then accepts R = identity, S = 0 as a signature of anything — so a weak
 * key is never stored, and never verified against.
 */
export function isStrongPublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== KEY_BYTES) return false;
  let y = 0n;
  for (let i = KEY_BYTES - 1; i >= 0; i--)
    y = (y << 8n) | BigInt(publicKey[i] ?? 0);
  y &= (1n << 255n) - 1n;
  return y < FIELD_P && !SMALL_ORDER_Y.has(y);
}

/** Ed25519 verification that answers false, never throws, on bad input. */
export function verifySignature(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!isStrongPublicKey(publicKey) || signature.length !== SIGNATURE_BYTES)
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

/** What a device signs to sign in: its id, bound to one handshake. */
export function authMessage(deviceId: string, handshake: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(AUTH_LABEL),
    Buffer.from(deviceId),
    handshake,
  ]);
}

/** What a phone's new key signs when it asks to be paired. */
export function pairMessage(handshake: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(PAIR_LABEL), handshake]);
}

/** What a device's new key signs when it replaces the old one. */
export function rotateMessage(handshake: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(ROTATE_LABEL), handshake]);
}

export function aad(label: AadLabel, sid: string): Buffer {
  return Buffer.from(`${label} ${sid}`);
}

export function nonce(counter: number): Buffer {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(Math.floor(counter / 2 ** 32), 4);
  value.writeUInt32BE(counter >>> 0, 8);
  return value;
}

/**
 * The same bytes as a plain Uint8Array: @noble/ciphers knows a byte array by
 * `instanceof` or by its class name, and a Buffer from another realm (the
 * jsdom the phone-page tests run in) passes neither.
 */
const plain = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * ChaCha20-Poly1305: ciphertext ‖ 16-byte tag. From @noble/ciphers — the
 * same code the phone runs — because Electron's crypto is BoringSSL, which
 * has no 'chacha20-poly1305' for createCipheriv (tests/main-remote-rc-
 * electron.test.ts runs this module in Electron to keep that true).
 */
export function seal(
  key: Uint8Array,
  counter: number,
  associated: Uint8Array,
  plaintext: Uint8Array,
): Buffer {
  return Buffer.from(
    chacha20poly1305(
      plain(key),
      plain(nonce(counter)),
      plain(associated),
    ).encrypt(plain(plaintext)),
  );
}

/** The plaintext, or null when anything about the message is off. */
export function open(
  key: Uint8Array,
  counter: number,
  associated: Uint8Array,
  sealed: Uint8Array,
): Buffer | null {
  if (sealed.length < TAG_BYTES) return null;
  try {
    return Buffer.from(
      chacha20poly1305(
        plain(key),
        plain(nonce(counter)),
        plain(associated),
      ).decrypt(plain(sealed)),
    );
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
