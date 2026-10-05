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
 * It is created the first time something needs it and kept in the
 * `remoteControl` store record. The 32-byte seed is sealed with Electron's
 * safeStorage (the OS keychain) whenever that is available, and stored as-is
 * only where it is not (`unsealed()` says so, for the Seguridad card).
 *
 * A record that cannot be read back — a keychain that is locked, denies
 * access or is missing for now, a hand-edited file — FAILS CLOSED: nothing is
 * replaced or rewritten, `available()` answers false and the server does not
 * start, until a retry reads it or the user renews the key on purpose
 * («Renovar clave del equipo»). Replacing it silently would make every
 * linked phone see a changed key.
 */

/** The slice of Electron's `safeStorage` used here. */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}

export interface IdentityKeysDeps {
  read(): StoredIdentity | null;
  write(identity: StoredIdentity): void;
  /** Null where the platform has no keychain to offer. */
  secretBox: SecretBox | null;
  warn?: (message: string) => void;
}

export interface IdentityKeys {
  /** Loads the identity (creating the first one); false when unreadable. */
  available(): boolean;
  /** The raw 32-byte public key; throws while the identity is unreadable. */
  publicKey(): Buffer;
  sign(data: Uint8Array): Buffer;
  /** A brand-new identity, replacing the old one for good; its public key. */
  renew(): Buffer;
  /** The stored identity is kept without the OS keychain. */
  unsealed(): boolean;
}

export function createIdentityKeys(deps: IdentityKeysDeps): IdentityKeys {
  const warn = deps.warn ?? ((message) => console.warn(message));
  let current: Identity | null = null;
  /** Said once: a locked keychain is retried, not reported on every read. */
  let warned = false;

  const canSeal = (): boolean => {
    try {
      return deps.secretBox?.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };

  function store(seed: Buffer, publicKey: Buffer): void {
    let record: StoredIdentity = {
      publicKey: toB64(publicKey),
      secret: toB64(seed),
      sealed: false,
    };
    if (canSeal()) {
      try {
        const sealed = deps.secretBox?.encryptString(toB64(seed));
        if (sealed)
          record = {
            ...record,
            secret: sealed.toString('base64'),
            sealed: true,
          };
      } catch {
        // The keychain refused: the seed is stored as-is, like where there
        // is no keychain at all.
      }
    }
    deps.write(record);
  }

  function create(): Identity {
    const { seed, publicKey } = generateIdentity();
    store(seed, publicKey);
    return identityFromSeed(seed);
  }

  /** The seed of a stored record, or null when it cannot be recovered. */
  function unseal(record: StoredIdentity): Buffer | null {
    if (!record.sealed) return fromB64(record.secret, KEY_BYTES);
    if (!canSeal()) return null;
    try {
      const plain = deps.secretBox?.decryptString(
        Buffer.from(record.secret, 'base64'),
      );
      return fromB64(plain, KEY_BYTES);
    } catch {
      return null;
    }
  }

  /** The identity, or null when the stored one cannot be read right now. */
  function load(): Identity | null {
    if (current) return current;
    const record = deps.read();
    if (!record) return (current = create());
    const seed = unseal(record);
    const identity = seed ? identityFromSeed(seed) : null;
    const expected = fromB64(record.publicKey, KEY_BYTES);
    if (
      !seed ||
      !identity ||
      !expected ||
      !sameBytes(identity.publicKey, expected)
    ) {
      if (!warned)
        warn(
          '[remote] the stored identity key could not be read; the server stays off until it can',
        );
      warned = true;
      return null;
    }
    if (!record.sealed && canSeal()) store(seed, identity.publicKey);
    return (current = identity);
  }

  const loaded = (): Identity => {
    const identity = load();
    if (!identity) throw new Error('the remote-control identity is unreadable');
    return identity;
  };

  return {
    available: () => load() !== null,
    publicKey: () => loaded().publicKey,
    sign: (data) => loaded().sign(data),
    renew: () => {
      current = create();
      return current.publicKey;
    },
    unsealed: () => deps.read()?.sealed === false,
  };
}
