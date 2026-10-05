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

/**
 * This computer's long-term Ed25519 identity for devbar-rc/1: created the
 * first time something needs it, kept in the `remoteControl` store record,
 * its seed sealed by Electron's safeStorage (the OS keychain) whenever that
 * is available — and readable as-is only where it is not.
 */

/** A reversible stand-in for safeStorage: base64 of the reversed text. */
function fakeBox(available = true): SecretBox & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString: (plain) => {
      calls.push('encrypt');
      return Buffer.from(`box:${[...plain].reverse().join('')}`);
    },
    decryptString: (sealed) => {
      calls.push('decrypt');
      const text = sealed.toString();
      if (!text.startsWith('box:')) throw new Error('not ours');
      return [...text.slice(4)].reverse().join('');
    },
  };
}

function harness(
  stored: StoredIdentity | null = null,
  box: SecretBox | null = fakeBox(),
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

describe('src/main/remote/identity.ts', () => {
  it('creates nothing until a key is first needed', () => {
    const h = harness();

    expect(h.writes).toHaveLength(0);
    const publicKey = h.keys.publicKey();

    expect(publicKey).toHaveLength(32);
    expect(h.writes).toHaveLength(1);
    expect(h.record()?.publicKey).toBe(toB64(publicKey));
  });

  it('seals the seed with the keychain and never stores it readable', () => {
    const h = harness();
    h.keys.publicKey();

    const record = h.record();
    expect(record?.sealed).toBe(true);
    expect(fromB64(record?.secret, 32)).toBeNull();
    expect(Buffer.from(record?.secret ?? '', 'base64').toString()).toMatch(
      /^box:/,
    );
  });

  it('stores the seed as-is when the keychain is not available', () => {
    const h = harness(null, fakeBox(false));
    h.keys.publicKey();

    expect(h.record()?.sealed).toBe(false);
    expect(fromB64(h.record()?.secret, 32)).toHaveLength(32);
  });

  it('stores the seed as-is when there is no keychain at all', () => {
    const h = harness(null, null);
    h.keys.publicKey();

    expect(h.record()?.sealed).toBe(false);
  });

  it('signs with the identity it created, verifiable with its public key', () => {
    const h = harness();
    const signature = h.keys.sign(Buffer.from('T'));

    expect(
      verifySignature(h.keys.publicKey(), Buffer.from('T'), signature),
    ).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('reads back a sealed identity from an earlier run, unsealing it once', () => {
    const first = harness();
    const publicKey = first.keys.publicKey();
    const box = fakeBox();
    const second = harness(first.record(), box);

    expect(second.keys.publicKey()).toEqual(publicKey);
    second.keys.sign(Buffer.from('a'));
    second.keys.sign(Buffer.from('b'));
    expect(box.calls).toEqual(['decrypt']);
    expect(second.writes).toHaveLength(0);
  });

  it('seals an identity stored as-is once the keychain becomes available', () => {
    const { seed, publicKey } = generateIdentity();
    const h = harness({
      publicKey: toB64(publicKey),
      secret: toB64(seed),
      sealed: false,
    });

    expect(h.keys.publicKey()).toEqual(publicKey);
    expect(h.record()).toMatchObject({
      publicKey: toB64(publicKey),
      sealed: true,
    });
  });

  it('starts a new identity when the stored one cannot be read', () => {
    const { publicKey } = generateIdentity();
    const h = harness({
      publicKey: toB64(publicKey),
      secret: Buffer.from('someone else').toString('base64'),
      sealed: true,
    });

    const fresh = h.keys.publicKey();

    expect(fresh).not.toEqual(publicKey);
    expect(h.record()?.publicKey).toBe(toB64(fresh));
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).not.toContain(h.record()?.secret ?? '-');
  });

  it('starts a new identity when the seed does not match its public key', () => {
    const one = generateIdentity();
    const other = generateIdentity();
    const h = harness({
      publicKey: toB64(one.publicKey),
      secret: toB64(other.seed),
      sealed: false,
    });

    expect(h.keys.publicKey()).not.toEqual(one.publicKey);
    expect(h.warnings).toHaveLength(1);
  });

  it('renews: a new key pair replaces the old one for good', () => {
    const h = harness();
    const before = h.keys.publicKey();

    const after = h.keys.renew();

    expect(after).not.toEqual(before);
    expect(h.keys.publicKey()).toEqual(after);
    expect(h.record()?.publicKey).toBe(toB64(after));
    const signature = h.keys.sign(Buffer.from('T'));
    expect(verifySignature(before, Buffer.from('T'), signature)).toBe(false);
  });
});
