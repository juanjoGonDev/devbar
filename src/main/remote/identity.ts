import type { StoredIdentity } from './device-store.js';
import {
  fromB64,
  generateIdentity,
  identityFromSeed,
  KEY_BYTES,
  sameBytes,
  toB64,
  type Identity,
} from './rc-protocol.js';

/**
 * This computer's long-term Ed25519 identity for devbar-rc/1 — the key every
 * handshake is signed with and the one each phone pins.
 *
 * It is created the first time it is loaded and kept in the `remoteControl`
 * store record: the public key and the 32-byte seed, both in base64url, the
 * way an SSH key lives in ~/.ssh — in a file only this user can read and
 * write (src/config-store/store.ts keeps the config file at 0600). Other
 * accounts on this computer cannot read it; a program running as this user
 * can, as it can read ~/.ssh.
 *
 * Why not the OS keychain (Electron's safeStorage): DevBar releases are
 * ad-hoc signed, with no Team ID, so to macOS every build and every update is
 * a different app. A new build may not open the keychain item an earlier one
 * sealed the seed with; Chromium then creates a new item, and the identity
 * sealed with the old key can never be decrypted again — every user would
 * lose it, and re-verify every phone, on each update.
 *
 * A record that cannot be read back — a hand-edited file, or a seed a
 * pre-release build sealed with the keychain — FAILS CLOSED: nothing is
 * replaced or rewritten, `load()` answers false and the server does not
 * start until the user renews the key on purpose («Renovar clave del
 * equipo»). Replacing it silently would make every linked phone see a
 * changed key.
 */

export interface IdentityKeysDeps {
  read(): StoredIdentity | null;
  write(identity: StoredIdentity): void;
  warn?: (message: string) => void;
}

export interface IdentityKeys {
  /**
   * Loads the identity (creating the first one); false while the stored one
   * cannot be read.
   */
  load(): boolean;
  /** The raw 32-byte public key; throws until `load()` answered true. */
  publicKey(): Buffer;
  sign(data: Uint8Array): Buffer;
  /** A brand-new identity, replacing the old one for good; its public key. */
  renew(): Buffer;
}

export function createIdentityKeys(deps: IdentityKeysDeps): IdentityKeys {
  const warn = deps.warn ?? ((message) => console.warn(message));
  let current: Identity | null = null;
  /** Said once: every start asks again, and the record stays as it is. */
  let warned = false;

  function create(): Identity {
    const { seed, publicKey } = generateIdentity();
    deps.write({
      publicKey: toB64(publicKey),
      secret: toB64(seed),
      sealed: false,
    });
    return identityFromSeed(seed);
  }

  /** The stored identity, or why it cannot be used — never the secret. */
  function restore(stored: StoredIdentity): Identity | string {
    if (stored.sealed)
      return 'its seed was sealed with the OS keychain by a pre-release build';
    const seed = fromB64(stored.secret, KEY_BYTES);
    if (!seed) return 'malformed seed';
    const identity = identityFromSeed(seed);
    const expected = fromB64(stored.publicKey, KEY_BYTES);
    return expected && sameBytes(identity.publicKey, expected)
      ? identity
      : 'the seed does not match the stored public key';
  }

  /** The identity, or null when the stored one cannot be read. */
  function read(): Identity | null {
    if (current) return current;
    const stored = deps.read();
    if (!stored) return (current = create());
    const restored = restore(stored);
    if (typeof restored !== 'string') return (current = restored);
    if (!warned)
      warn(
        `[remote] the stored identity key could not be read (${restored}); the server stays off until the key is renewed`,
      );
    warned = true;
    return null;
  }

  const ready = (): Identity => {
    if (!current) throw new Error('the remote-control identity is not loaded');
    return current;
  };

  return {
    load: () => read() !== null,
    publicKey: () => ready().publicKey,
    sign: (data) => ready().sign(data),
    renew: () => {
      current = create();
      return current.publicKey;
    },
  };
}
