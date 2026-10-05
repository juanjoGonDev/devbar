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
 * only where it is not. A record that cannot be read back — a reset keychain,
 * a hand-edited file — is replaced by a new identity: linked phones then see
 * a changed key and refuse to connect until the user re-verifies them.
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
  /** The raw 32-byte public key; creates the identity when first needed. */
  publicKey(): Buffer;
  sign(data: Uint8Array): Buffer;
  /** A brand-new identity, replacing the old one for good; its public key. */
  renew(): Buffer;
}

export function createIdentityKeys(deps: IdentityKeysDeps): IdentityKeys {
  const warn = deps.warn ?? ((message) => console.warn(message));
  let current: Identity | null = null;

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

  function load(): Identity {
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
      warn(
        '[remote] the stored identity key could not be read; a new one was created',
      );
      return (current = create());
    }
    if (!record.sealed && canSeal()) store(seed, identity.publicKey);
    return (current = identity);
  }

  return {
    publicKey: () => load().publicKey,
    sign: (data) => load().sign(data),
    renew: () => {
      current = create();
      return current.publicKey;
    },
  };
}
