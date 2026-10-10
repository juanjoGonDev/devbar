import { describe, expect, it } from 'vitest';
import type { StoredIdentity } from '../src/main/remote/device-store.js';
import { createIdentityKeys } from '../src/main/remote/identity.js';
import {
  fromB64,
  generateIdentity,
  identityFromSeed,
  toB64,
  verifySignature,
} from '../src/main/remote/rc-protocol.js';

/**
 * This computer's long-term Ed25519 identity for devbar-rc/1: created the
 * first time something needs it and kept in the `remoteControl` store record
 * — the seed as it is, in a file only this user can read, the way an SSH key
 * lives in ~/.ssh; never through the OS keychain. One that cannot be read
 * back is never silently replaced: every phone pinned it.
 */

function harness(stored: StoredIdentity | null = null) {
  let record = stored;
  let reads = 0;
  const writes: StoredIdentity[] = [];
  const warnings: string[] = [];
  const keys = createIdentityKeys({
    read: () => {
      reads += 1;
      return record;
    },
    write: (identity) => {
      record = identity;
      writes.push(identity);
    },
    warn: (message) => warnings.push(message),
  });
  return { keys, writes, warnings, record: () => record, reads: () => reads };
}

/** An identity an earlier run stored, and its public key. */
function storedEarlier() {
  const { seed, publicKey } = generateIdentity();
  const record: StoredIdentity = {
    publicKey: toB64(publicKey),
    secret: toB64(seed),
    sealed: false,
  };
  return { publicKey, record };
}

/** What a pre-release build left: the seed sealed with the OS keychain. */
function sealedByKeychain(): StoredIdentity {
  return {
    publicKey: toB64(generateIdentity().publicKey),
    secret: Buffer.from(`v10${'x'.repeat(45)}`).toString('base64'),
    sealed: true,
  };
}

describe('src/main/remote/identity.ts', () => {
  describe('creating it', () => {
    it('creates nothing until it is first loaded', () => {
      const h = harness();

      expect(h.writes).toHaveLength(0);
      expect(() => h.keys.publicKey()).toThrow();

      expect(h.keys.load()).toBe(true);

      expect(h.keys.publicKey()).toHaveLength(32);
      expect(h.writes).toHaveLength(1);
      expect(h.record()?.publicKey).toBe(toB64(h.keys.publicKey()));
    });

    it('stores the seed as it is, in base64url, never sealed by the keychain', () => {
      const h = harness();
      h.keys.load();

      const record = h.record();
      expect(record?.sealed).toBe(false);
      const seed = fromB64(record?.secret, 32);
      if (!seed) throw new Error('the seed is not stored as-is');
      expect(identityFromSeed(seed).publicKey).toEqual(h.keys.publicKey());
    });

    it('creates one identity, however often it is loaded', () => {
      const h = harness();

      h.keys.load();
      h.keys.load();

      expect(h.writes).toHaveLength(1);
    });

    it('signs with the identity it created, verifiable with its public key', () => {
      const h = harness();
      h.keys.load();
      const signature = h.keys.sign(Buffer.from('T'));

      expect(
        verifySignature(h.keys.publicKey(), Buffer.from('T'), signature),
      ).toBe(true);
    });
  });

  describe('reading it back', () => {
    it('reads back the identity an earlier run stored, rewriting nothing', () => {
      const { publicKey, record } = storedEarlier();
      const h = harness(record);

      expect(h.keys.load()).toBe(true);

      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(h.writes).toHaveLength(0);
      expect(h.record()).toEqual(record);
    });

    it('reads the store once, then answers from memory', () => {
      const { record } = storedEarlier();
      const h = harness(record);

      h.keys.load();
      h.keys.load();
      h.keys.sign(Buffer.from('a'));

      expect(h.reads()).toBe(1);
    });
  });

  describe('failing closed', () => {
    it('fails closed on a seed a pre-release build sealed with the keychain: nothing replaced, nothing written', () => {
      const record = sealedByKeychain();
      const h = harness(record);

      expect(h.keys.load()).toBe(false);

      expect(() => h.keys.publicKey()).toThrow();
      expect(() => h.keys.sign(Buffer.from('T'))).toThrow();
      expect(h.writes).toHaveLength(0);
      expect(h.record()).toEqual(record);
    });

    it('says why in the log, never the secret itself', () => {
      const record = sealedByKeychain();
      const h = harness(record);

      h.keys.load();

      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toContain('OS keychain');
      expect(h.warnings[0]).not.toContain(record.secret);
    });

    it('fails closed on a seed that is not one', () => {
      const { record } = storedEarlier();
      const h = harness({ ...record, secret: 'not-a-seed' });

      expect(h.keys.load()).toBe(false);
      expect(h.writes).toHaveLength(0);
      expect(h.warnings[0]).toContain('malformed seed');
    });

    it('fails closed when the seed does not match its public key', () => {
      const one = generateIdentity();
      const other = generateIdentity();
      const h = harness({
        publicKey: toB64(one.publicKey),
        secret: toB64(other.seed),
        sealed: false,
      });

      expect(h.keys.load()).toBe(false);
      expect(h.writes).toHaveLength(0);
      expect(h.warnings[0]).toContain('does not match');
    });

    it('says it once, however many times it is asked again', () => {
      const h = harness(sealedByKeychain());

      h.keys.load();
      h.keys.load();

      expect(h.warnings).toHaveLength(1);
    });

    it('replaces an unreadable identity only when asked to renew it', () => {
      const record = sealedByKeychain();
      const h = harness(record);
      h.keys.load();

      const fresh = h.keys.renew();

      expect(h.keys.load()).toBe(true);
      expect(h.keys.publicKey()).toEqual(fresh);
      expect(h.record()).toMatchObject({
        publicKey: toB64(fresh),
        sealed: false,
      });
      expect(h.record()?.publicKey).not.toBe(record.publicKey);
    });
  });

  describe('renewing it', () => {
    it('renews: a new key pair replaces the old one for good', () => {
      const h = harness();
      h.keys.load();
      const before = h.keys.publicKey();

      const after = h.keys.renew();

      expect(after).not.toEqual(before);
      expect(h.keys.publicKey()).toEqual(after);
      expect(h.record()?.publicKey).toBe(toB64(after));
      const signature = h.keys.sign(Buffer.from('T'));
      expect(verifySignature(before, Buffer.from('T'), signature)).toBe(false);
    });
  });
});
