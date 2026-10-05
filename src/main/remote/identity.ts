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
import { createSerial } from './serial.js';

/**
 * This computer's long-term Ed25519 identity for devbar-rc/1 — the key every
 * handshake is signed with and the one each phone pins.
 *
 * It is created the first time it is loaded and kept in the `remoteControl`
 * store record. The 32-byte seed is sealed with Electron's safeStorage (the
 * OS keychain) whenever that is available, and stored as-is only where it
 * is not (`unsealed()` says so, for the Seguridad card).
 *
 * Every keychain call is asynchronous: on macOS a build the keychain does not
 * know yet asks the user first («DevBar quiere usar información confidencial
 * guardada en "DevBar Safe Storage"»), and the main process must keep
 * running while that prompt is open. So `load()` is a promise, and
 * `publicKey()` / `sign()` answer only once it has resolved true. Loads and
 * renewals wait for one another, so an overlap never creates two identities
 * nor lets an old key come back after a renewal.
 *
 * A record that cannot be read back — a keychain that is locked, denies
 * access or is missing for now, a hand-edited file — FAILS CLOSED: nothing is
 * replaced or rewritten, `load()` answers false and the server does not
 * start, until a retry reads it or the user renews the key on purpose
 * («Renovar clave del equipo»). Replacing it silently would make every
 * linked phone see a changed key.
 */

/** The slice of Electron's `safeStorage` used here: its asynchronous half. */
export interface SecretBox {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Buffer>;
  /** `shouldReEncrypt`: the keychain key rotated; seal the result again. */
  decryptStringAsync(
    sealed: Buffer,
  ): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

export interface IdentityKeysDeps {
  read(): StoredIdentity | null;
  write(identity: StoredIdentity): void;
  /** Null where the platform has no keychain to offer. */
  secretBox: SecretBox | null;
  warn?: (message: string) => void;
}

export interface IdentityKeys {
  /**
   * Loads the identity (creating the first one); false while the stored one
   * cannot be read. A load still waiting on the keychain is shared.
   */
  load(): Promise<boolean>;
  /** It is in memory: `load()` answers without asking the keychain. */
  loaded(): boolean;
  /** The raw 32-byte public key; throws until `load()` resolved true. */
  publicKey(): Buffer;
  sign(data: Uint8Array): Buffer;
  /** A brand-new identity, replacing the old one for good; its public key. */
  renew(): Promise<Buffer>;
  /** The stored identity is kept without the OS keychain. */
  unsealed(): boolean;
}

/** What a stored record yields: its seed, and whether to seal it again. */
interface Unsealed {
  seed: Buffer;
  reseal: boolean;
}

export function createIdentityKeys(deps: IdentityKeysDeps): IdentityKeys {
  const warn = deps.warn ?? ((message) => console.warn(message));
  const box = deps.secretBox;
  const serial = createSerial();
  let current: Identity | null = null;
  let loading: Promise<boolean> | null = null;
  /** Said once: a locked keychain is retried, not reported on every read. */
  let warned = false;

  const canSeal = async (): Promise<boolean> => {
    try {
      return (await box?.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  };

  /** The seed sealed by the keychain (base64), or null where it cannot. */
  async function seal(seed: Buffer): Promise<string | null> {
    if (!box || !(await canSeal())) return null;
    try {
      return (await box.encryptStringAsync(toB64(seed))).toString('base64');
    } catch {
      return null;
    }
  }

  const record = (
    publicKey: Buffer,
    secret: string,
    sealed: boolean,
  ): StoredIdentity => ({ publicKey: toB64(publicKey), secret, sealed });

  async function create(): Promise<Identity> {
    const { seed, publicKey } = generateIdentity();
    // A keychain that is missing or refuses: the seed is stored as-is.
    const sealed = await seal(seed);
    deps.write(record(publicKey, sealed ?? toB64(seed), sealed !== null));
    return identityFromSeed(seed);
  }

  /** The seed of a stored record, or null when it cannot be recovered. */
  async function unseal(stored: StoredIdentity): Promise<Unsealed | null> {
    if (!stored.sealed) {
      const seed = fromB64(stored.secret, KEY_BYTES);
      // Stored as-is: sealed as soon as there is a keychain to do it.
      return seed && { seed, reseal: true };
    }
    if (!box || !(await canSeal())) return null;
    try {
      const opened = await box.decryptStringAsync(
        Buffer.from(stored.secret, 'base64'),
      );
      const seed = fromB64(opened.result, KEY_BYTES);
      return seed && { seed, reseal: opened.shouldReEncrypt };
    } catch {
      return null;
    }
  }

  /** The identity, or null when the stored one cannot be read right now. */
  async function read(): Promise<Identity | null> {
    if (current) return current;
    const stored = deps.read();
    if (!stored) return (current = await create());
    const unsealed = await unseal(stored);
    const identity = unsealed ? identityFromSeed(unsealed.seed) : null;
    const expected = fromB64(stored.publicKey, KEY_BYTES);
    if (
      !unsealed ||
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
    // Only ever upgraded: a seal that fails leaves the record as it was.
    const resealed = unsealed.reseal ? await seal(unsealed.seed) : null;
    if (resealed !== null)
      deps.write(record(identity.publicKey, resealed, true));
    return (current = identity);
  }

  const ready = (): Identity => {
    if (!current) throw new Error('the remote-control identity is not loaded');
    return current;
  };

  return {
    load: () => {
      if (current) return Promise.resolve(true);
      loading ??= serial(async () => (await read()) !== null).finally(() => {
        loading = null;
      });
      return loading;
    },
    loaded: () => current !== null,
    publicKey: () => ready().publicKey,
    sign: (data) => ready().sign(data),
    renew: () =>
      serial(async () => {
        current = await create();
        return current.publicKey;
      }),
    unsealed: () => deps.read()?.sealed === false,
  };
}
