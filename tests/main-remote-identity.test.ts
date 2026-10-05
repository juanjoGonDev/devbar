import { describe, expect, it } from 'vitest';
import type { StoredIdentity } from '../src/main/remote/device-store.js';
import {
  createIdentityKeys,
  type SecretBox,
} from '../src/main/remote/identity.js';
import {
  fromB64,
  generateIdentity,
  toB64,
  verifySignature,
} from '../src/main/remote/rc-protocol.js';
import { fakeKeychain, settle } from './helpers/fake-keychain.js';

/**
 * This computer's long-term Ed25519 identity for devbar-rc/1: created the
 * first time something needs it, kept in the `remoteControl` store record,
 * its seed sealed by Electron's safeStorage (the OS keychain) whenever that
 * is available — and readable as-is only where it is not. One that cannot be
 * read back is never silently replaced: every phone pinned it.
 *
 * Every keychain call is asynchronous: on macOS one can wait on a permission
 * prompt for as long as the user leaves it open, and the main process must
 * keep running meanwhile.
 */

function harness(
  stored: StoredIdentity | null = null,
  box: SecretBox | null = fakeKeychain(),
) {
  let record = stored;
  const writes: StoredIdentity[] = [];
  const warnings: string[] = [];
  const keys = createIdentityKeys({
    read: () => record,
    write: (identity) => {
      record = identity;
      writes.push(identity);
    },
    secretBox: box,
    warn: (message) => warnings.push(message),
  });
  return { keys, writes, warnings, record: () => record };
}

/** A sealed identity from an earlier run, and the keychain that sealed it. */
async function sealedEarlier() {
  const box = fakeKeychain();
  const first = harness(null, box);
  await first.keys.load();
  const publicKey = first.keys.publicKey();
  const record = first.record();
  if (!record) throw new Error('nothing stored');
  box.calls.length = 0;
  return { box, publicKey, record };
}

describe('src/main/remote/identity.ts', () => {
  describe('creating it', () => {
    it('creates nothing until it is first loaded', async () => {
      const h = harness();

      expect(h.writes).toHaveLength(0);
      expect(h.keys.loaded()).toBe(false);
      expect(() => h.keys.publicKey()).toThrow();

      await expect(h.keys.load()).resolves.toBe(true);

      expect(h.keys.loaded()).toBe(true);
      expect(h.keys.publicKey()).toHaveLength(32);
      expect(h.writes).toHaveLength(1);
      expect(h.record()?.publicKey).toBe(toB64(h.keys.publicKey()));
    });

    it('seals the seed with the keychain and never stores it readable', async () => {
      const h = harness();
      await h.keys.load();

      const record = h.record();
      expect(record?.sealed).toBe(true);
      expect(fromB64(record?.secret, 32)).toBeNull();
      expect(Buffer.from(record?.secret ?? '', 'base64').toString()).toMatch(
        /^box:/,
      );
    });

    it('stores the seed as-is when the keychain is not available', async () => {
      const box = fakeKeychain();
      box.setAvailable(false);
      const h = harness(null, box);
      await h.keys.load();

      expect(h.record()?.sealed).toBe(false);
      expect(fromB64(h.record()?.secret, 32)).toHaveLength(32);
      expect(box.calls).not.toContain('encrypt');
    });

    it('stores the seed as-is when the keychain refuses to seal it', async () => {
      const box = fakeKeychain();
      box.setLocked(true);
      const h = harness(null, box);
      await h.keys.load();

      expect(h.record()?.sealed).toBe(false);
      expect(fromB64(h.record()?.secret, 32)).toHaveLength(32);
    });

    it('stores the seed as-is when there is no keychain at all', async () => {
      const h = harness(null, null);
      await h.keys.load();

      expect(h.record()?.sealed).toBe(false);
    });

    it('signs with the identity it created, verifiable with its public key', async () => {
      const h = harness();
      await h.keys.load();
      const signature = h.keys.sign(Buffer.from('T'));

      expect(
        verifySignature(h.keys.publicKey(), Buffer.from('T'), signature),
      ).toBe(true);
      expect(h.writes).toHaveLength(1);
    });
  });

  describe('reading it back', () => {
    it('reads back a sealed identity from an earlier run, unsealing it once', async () => {
      const { box, publicKey, record } = await sealedEarlier();
      const h = harness(record, box);

      await expect(h.keys.load()).resolves.toBe(true);
      await h.keys.load();
      h.keys.sign(Buffer.from('a'));

      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(box.calls.filter((call) => call === 'decrypt')).toHaveLength(1);
      expect(h.writes).toHaveLength(0);
    });

    it('seals it again when the keychain asks to (a rotated key), keeping the same identity', async () => {
      const { box, publicKey, record } = await sealedEarlier();
      box.setReEncrypt(true);
      const h = harness(record, box);

      await expect(h.keys.load()).resolves.toBe(true);

      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(box.calls).toContain('encrypt');
      expect(h.writes).toHaveLength(1);
      expect(h.record()).toMatchObject({
        publicKey: toB64(publicKey),
        sealed: true,
      });
    });

    it('leaves the record alone when sealing it again fails, never storing it readable', async () => {
      const { publicKey, record } = await sealedEarlier();
      const box = fakeKeychain();
      box.setReEncrypt(true);
      const sealing: SecretBox = {
        ...box,
        encryptStringAsync: () => Promise.reject(new Error('busy')),
      };
      const h = harness(record, sealing);

      await expect(h.keys.load()).resolves.toBe(true);

      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(h.writes).toHaveLength(0);
      expect(h.record()).toEqual(record);
    });

    it('seals an identity stored as-is once the keychain becomes available', async () => {
      const { seed, publicKey } = generateIdentity();
      const h = harness({
        publicKey: toB64(publicKey),
        secret: toB64(seed),
        sealed: false,
      });

      await h.keys.load();

      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(h.record()).toMatchObject({
        publicKey: toB64(publicKey),
        sealed: true,
      });
    });

    it('keeps an identity stored as-is untouched while there is still no keychain', async () => {
      const { seed, publicKey } = generateIdentity();
      const h = harness(
        { publicKey: toB64(publicKey), secret: toB64(seed), sealed: false },
        null,
      );

      await expect(h.keys.load()).resolves.toBe(true);

      expect(h.writes).toHaveLength(0);
    });
  });

  describe('failing closed', () => {
    it('fails closed when the keychain is not there to unseal it: nothing replaced, nothing written', async () => {
      const { box, record } = await sealedEarlier();
      box.setAvailable(false);
      const h = harness(record, box);

      await expect(h.keys.load()).resolves.toBe(false);
      expect(h.keys.loaded()).toBe(false);
      expect(() => h.keys.publicKey()).toThrow();
      expect(() => h.keys.sign(Buffer.from('T'))).toThrow();
      expect(h.writes).toHaveLength(0);
      expect(h.record()).toEqual(record);
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).not.toContain(record.secret);
    });

    it('fails closed when the keychain refuses (denied, a locked keyring)', async () => {
      const { box, record } = await sealedEarlier();
      box.setLocked(true);
      const h = harness(record, box);

      await expect(h.keys.load()).resolves.toBe(false);
      expect(h.writes).toHaveLength(0);
    });

    it('fails closed when asking the keychain itself fails', async () => {
      const { record } = await sealedEarlier();
      const broken: SecretBox = {
        ...fakeKeychain(),
        isAsyncEncryptionAvailable: () => Promise.reject(new Error('no')),
      };
      const h = harness(record, broken);

      await expect(h.keys.load()).resolves.toBe(false);
      expect(h.writes).toHaveLength(0);
    });

    it('says it once, however many times it is retried', async () => {
      const { box, record } = await sealedEarlier();
      box.setLocked(true);
      const h = harness(record, box);

      await h.keys.load();
      await h.keys.load();

      expect(h.warnings).toHaveLength(1);
    });

    it('loads the same identity once the keychain is back (Reintentar)', async () => {
      const { box, publicKey, record } = await sealedEarlier();
      box.setLocked(true);
      const h = harness(record, box);
      await expect(h.keys.load()).resolves.toBe(false);

      box.setLocked(false);

      await expect(h.keys.load()).resolves.toBe(true);
      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(h.writes).toHaveLength(0);
    });

    it('fails closed when the seed does not match its public key', async () => {
      const one = generateIdentity();
      const other = generateIdentity();
      const h = harness({
        publicKey: toB64(one.publicKey),
        secret: toB64(other.seed),
        sealed: false,
      });

      await expect(h.keys.load()).resolves.toBe(false);
      expect(h.writes).toHaveLength(0);
    });

    it('replaces an unreadable identity only when asked to renew it', async () => {
      const { box, publicKey, record } = await sealedEarlier();
      box.setLocked(true);
      const h = harness(record, box);
      await h.keys.load();
      box.setLocked(false);

      const fresh = await h.keys.renew();

      expect(fresh).not.toEqual(publicKey);
      await expect(h.keys.load()).resolves.toBe(true);
      expect(h.keys.publicKey()).toEqual(fresh);
      expect(h.record()?.publicKey).toBe(toB64(fresh));
    });
  });

  describe('one keychain answer at a time', () => {
    it('shares a load that is still waiting on the keychain instead of asking twice', async () => {
      const { box, publicKey, record } = await sealedEarlier();
      box.hold();
      const h = harness(record, box);

      const first = h.keys.load();
      const second = h.keys.load();
      await settle();
      expect(box.pending()).toBe(1);
      await box.release();

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(h.keys.publicKey()).toEqual(publicKey);
      expect(box.calls.filter((call) => call === 'decrypt')).toHaveLength(1);
    });

    it('creates one identity, not two, when two first loads overlap', async () => {
      const box = fakeKeychain();
      box.hold();
      const h = harness(null, box);

      const both = Promise.all([h.keys.load(), h.keys.load()]);
      await box.release();
      await both;

      expect(h.writes).toHaveLength(1);
    });

    it('renews after a load still waiting on the keychain, which never brings the old key back', async () => {
      const { box, publicKey, record } = await sealedEarlier();
      box.hold();
      const h = harness(record, box);

      const loading = h.keys.load();
      const renewing = h.keys.renew();
      await box.release();
      const fresh = await renewing;

      await expect(loading).resolves.toBe(true);
      expect(fresh).not.toEqual(publicKey);
      expect(h.keys.publicKey()).toEqual(fresh);
      expect(h.record()?.publicKey).toBe(toB64(fresh));
    });
  });

  describe('the Seguridad card', () => {
    it('says when the identity is kept outside the keychain', async () => {
      const box = fakeKeychain();
      box.setAvailable(false);
      const plain = harness(null, box);
      const sealed = harness();
      expect(plain.keys.unsealed()).toBe(false);

      await plain.keys.load();
      await sealed.keys.load();

      expect(plain.keys.unsealed()).toBe(true);
      expect(sealed.keys.unsealed()).toBe(false);
    });

    it('renews: a new key pair replaces the old one for good', async () => {
      const h = harness();
      await h.keys.load();
      const before = h.keys.publicKey();

      const after = await h.keys.renew();

      expect(after).not.toEqual(before);
      expect(h.keys.publicKey()).toEqual(after);
      expect(h.record()?.publicKey).toBe(toB64(after));
      const signature = h.keys.sign(Buffer.from('T'));
      expect(verifySignature(before, Buffer.from('T'), signature)).toBe(false);
    });
  });
});
