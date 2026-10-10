import { describe, expect, it } from 'vitest';
import {
  clearKeys,
  keyMaterial,
  readKeys,
  writeKeys,
  type DeviceKeys,
} from '../renderer/remote/keys.js';
import { generateSigningKey, toB64 } from '../renderer/remote/rc-protocol.js';

/**
 * What a linked phone keeps in its own localStorage: the desktop key it
 * pinned, its device id and its own Ed25519 key pair, whether it verified
 * the security code, and the computer's name (to say whose key changed).
 * Storage can be missing or throw (private mode, blocked site data): every
 * access is guarded and reads as «no keys».
 */

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    env: {
      storage: () => ({
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
        removeItem: (key: string) => {
          map.delete(key);
        },
      }),
    },
  };
}

const broken = {
  storage: () => {
    throw new Error('SecurityError');
  },
};

function keys(): DeviceKeys {
  const device = generateSigningKey();
  return {
    serverIdPub: toB64(generateSigningKey().publicKey),
    deviceId: 'd1',
    devicePriv: toB64(device.secretKey),
    devicePub: toB64(device.publicKey),
    verified: false,
    hostName: 'Mac-de-Ana',
  };
}

describe('renderer/remote/keys.ts', () => {
  it('writes and reads the keys back', () => {
    const s = storage();
    const value = keys();

    expect(writeKeys(s.env, value)).toBe(true);
    expect(readKeys(s.env)).toEqual(value);
  });

  it('reads nothing from empty, garbled or incomplete storage', () => {
    expect(readKeys(storage().env)).toBeNull();
    expect(readKeys(storage({ 'devbar.remote.keys': '{nope' }).env)).toBeNull();
    const { devicePriv: _gone, ...partial } = keys();
    expect(
      readKeys(storage({ 'devbar.remote.keys': JSON.stringify(partial) }).env),
    ).toBeNull();
    expect(
      readKeys(
        storage({
          'devbar.remote.keys': JSON.stringify({ ...keys(), devicePub: 'x' }),
        }).env,
      ),
    ).toBeNull();
  });

  it('never throws where storage is blocked', () => {
    expect(readKeys(broken)).toBeNull();
    expect(writeKeys(broken, keys())).toBe(false);
    expect(() => clearKeys(broken)).not.toThrow();
  });

  it('forgets the keys', () => {
    const s = storage();
    writeKeys(s.env, keys());

    clearKeys(s.env);

    expect(readKeys(s.env)).toBeNull();
    expect(s.map.size).toBe(0);
  });

  it('decodes the material the protocol needs', () => {
    const value = keys();
    const material = keyMaterial(value);

    expect(material?.serverKey).toHaveLength(32);
    expect(material?.secretKey).toHaveLength(32);
    expect(material?.devicePub).toHaveLength(32);
    expect(keyMaterial({ ...value, serverIdPub: 'short' })).toBeNull();
  });
});
