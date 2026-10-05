import { fromB64, KEY_BYTES } from './rc-protocol.js';

/**
 * What a linked phone keeps in its own localStorage for devbar-rc/1: the
 * desktop identity key it pinned when it paired (or re-pinned by scanning a
 * security code), its device id, its own Ed25519 key pair, whether the user
 * verified the security code, and the computer's name — to say whose key
 * changed when it does.
 *
 * Storage can be missing or throw (private mode, blocked site data): every
 * access is guarded, and a phone that cannot keep keys reads as unlinked.
 */

const STORAGE_KEY = 'devbar.remote.keys';
const PROBE_KEY = 'devbar.remote.probe';

export interface DeviceKeys {
  serverIdPub: string;
  deviceId: string;
  devicePriv: string;
  devicePub: string;
  verified: boolean;
  hostName: string;
}

export interface KeyStorage {
  storage(): {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
}

/** The decoded bytes, or null when any of them is malformed. */
export function keyMaterial(keys: DeviceKeys): {
  serverKey: Uint8Array;
  secretKey: Uint8Array;
  devicePub: Uint8Array;
} | null {
  const serverKey = fromB64(keys.serverIdPub, KEY_BYTES);
  const secretKey = fromB64(keys.devicePriv, KEY_BYTES);
  const devicePub = fromB64(keys.devicePub, KEY_BYTES);
  return serverKey && secretKey && devicePub
    ? { serverKey, secretKey, devicePub }
    : null;
}

function narrow(value: unknown): DeviceKeys | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === 'string' ? raw[key] : null;
  const keys = {
    serverIdPub: text('serverIdPub'),
    deviceId: text('deviceId'),
    devicePriv: text('devicePriv'),
    devicePub: text('devicePub'),
    hostName: text('hostName') ?? '',
  };
  if (
    keys.serverIdPub === null ||
    !keys.deviceId ||
    keys.devicePriv === null ||
    keys.devicePub === null
  )
    return null;
  const result: DeviceKeys = {
    serverIdPub: keys.serverIdPub,
    deviceId: keys.deviceId,
    devicePriv: keys.devicePriv,
    devicePub: keys.devicePub,
    verified: raw.verified === true,
    hostName: keys.hostName,
  };
  return keyMaterial(result) ? result : null;
}

export function readKeys(env: KeyStorage): DeviceKeys | null {
  try {
    const stored = env.storage().getItem(STORAGE_KEY);
    return stored === null ? null : narrow(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** False when this browser would not keep them. */
export function writeKeys(env: KeyStorage, keys: DeviceKeys): boolean {
  try {
    env.storage().setItem(STORAGE_KEY, JSON.stringify(keys));
    return true;
  } catch {
    return false;
  }
}

export function clearKeys(env: KeyStorage): void {
  try {
    env.storage().removeItem(STORAGE_KEY);
  } catch {
    /* nothing to forget where nothing could be kept */
  }
}

/** Whether this browser keeps what the page stores (not in private mode…). */
export function storageWorks(env: KeyStorage): boolean {
  try {
    const storage = env.storage();
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}
