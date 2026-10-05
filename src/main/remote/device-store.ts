import crypto from 'node:crypto';
import type { RemoteDeviceView } from '../../ipc-contract/remote-api.js';
import { isRemotePort } from '../../remote-port.js';

/**
 * The linked devices, the remote-control switches and this computer's
 * identity key, persisted under their own `remoteControl` store key — never
 * in globalSettings, which every window reads and every export/backup dumps.
 *
 * A device is known by its Ed25519 public key (devbar-rc/1): it proves who
 * it is by signing each handshake, so nothing stored here — the config file,
 * a backup of it — is a credential anyone could replay. The public key never
 * leaves main either: the views the windows get do not carry it.
 */

const DEFAULT_REMOTE_PORT = 47821;
const DEVICE_NAME_MAX = 40;
/** `lastSeenAt` reaches the disk at most this often per device. */
const LAST_SEEN_PERSIST_MS = 60_000;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A raw 32-byte key in unpadded base64url. */
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_CHARS = /\p{Cc}/u;

interface RemoteDevice extends RemoteDeviceView {
  /** The device's Ed25519 public key, base64url. */
  devicePub: string;
}

/**
 * This computer's Ed25519 identity (src/main/remote/identity.ts): the public
 * key, and the 32-byte seed — sealed by the OS keychain when it can be.
 */
export interface StoredIdentity {
  publicKey: string;
  secret: string;
  sealed: boolean;
}

export interface RemoteControlState {
  enabled: boolean;
  autoUnlink: boolean;
  /** A desktop notice when a linked device connects. */
  notifyConnections: boolean;
  port: number;
  devices: RemoteDevice[];
  identity: StoredIdentity | null;
}

export interface DeviceStoreDeps {
  read(): unknown;
  write(state: RemoteControlState): void;
  now(): number;
  randomUUID?: () => string;
}

type RenameOutcome = 'ok' | 'invalid-name' | 'not-found';

export interface DeviceStore {
  settings(): {
    enabled: boolean;
    autoUnlink: boolean;
    notifyConnections: boolean;
    port: number;
  };
  setEnabled(enabled: boolean): void;
  setAutoUnlink(enabled: boolean): void;
  setNotifyConnections(enabled: boolean): void;
  /** Persists a port that already passed `isRemotePort`. */
  setPort(port: number): void;
  list(): RemoteDeviceView[];
  add(input: {
    name: string;
    client: string;
    devicePub: string;
    /** Where it paired from: the first address its sign-ins are held to. */
    ip?: string;
  }): RemoteDeviceView;
  rename(id: string, name: string): RenameOutcome;
  remove(id: string): boolean;
  find(id: string): RemoteDeviceView | null;
  /** The device's public key (base64url), null for an unknown device. */
  devicePub(id: string): string | null;
  /** A new key for the device: it is unverified again. */
  setDevicePub(id: string, devicePub: string): boolean;
  markVerified(id: string): boolean;
  /** The identity changed: no device has compared it yet. */
  clearVerified(): void;
  identity(): StoredIdentity | null;
  saveIdentity(identity: StoredIdentity): void;
  /** Marks the device as seen now; true when that reached the disk. */
  touch(id: string): boolean;
  /** The device signed in from `ip`: keeps it; the address it had before. */
  recordIp(id: string, ip: string): string | null;
  /** Removes devices unseen for 30 days (auto-unlink only); the count. */
  pruneStale(): number;
}

/** The trimmed name when it is 1–40 printable characters, else null. */
export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > DEVICE_NAME_MAX || CONTROL_CHARS.test(name))
    return null;
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDevice(value: unknown): RemoteDevice | null {
  if (!isRecord(value)) return null;
  const { id, name, devicePub, client, createdAt, lastSeenAt } = value;
  const verifiedAt = value.verifiedAt ?? null;
  const lastIp = typeof value.lastIp === 'string' ? value.lastIp : null;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof devicePub !== 'string' ||
    !RAW_KEY.test(devicePub) ||
    typeof client !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof lastSeenAt !== 'number' ||
    (verifiedAt !== null && typeof verifiedAt !== 'number')
  )
    return null;
  return {
    id,
    name,
    devicePub,
    client,
    createdAt,
    lastSeenAt,
    verifiedAt,
    lastIp,
  };
}

function normalizeIdentity(value: unknown): StoredIdentity | null {
  if (!isRecord(value)) return null;
  const { publicKey, secret, sealed } = value;
  if (
    typeof publicKey !== 'string' ||
    !RAW_KEY.test(publicKey) ||
    typeof secret !== 'string' ||
    typeof sealed !== 'boolean'
  )
    return null;
  return { publicKey, secret, sealed };
}

function normalizePort(value: unknown): number {
  return isRemotePort(value) ? value : DEFAULT_REMOTE_PORT;
}

/** Whatever is on disk, as a state the rest of the module can trust. */
export function normalizeRemoteState(raw: unknown): RemoteControlState {
  const record = isRecord(raw) ? raw : {};
  const devices = Array.isArray(record.devices) ? record.devices : [];
  return {
    enabled: record.enabled === true,
    autoUnlink: record.autoUnlink !== false,
    notifyConnections: record.notifyConnections !== false,
    port: normalizePort(record.port),
    devices: devices
      .map(normalizeDevice)
      .filter((device): device is RemoteDevice => device !== null),
    identity: normalizeIdentity(record.identity),
  };
}

function view(device: RemoteDevice): RemoteDeviceView {
  const { devicePub: _key, ...rest } = device;
  return rest;
}

export function createDeviceStore(deps: DeviceStoreDeps): DeviceStore {
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const state = normalizeRemoteState(deps.read());
  /** The lastSeenAt each device last had ON DISK. */
  const persistedSeen = new Map(
    state.devices.map((device) => [device.id, device.lastSeenAt]),
  );

  const persist = (): void => {
    for (const device of state.devices)
      persistedSeen.set(device.id, device.lastSeenAt);
    deps.write(structuredClone(state));
  };
  const byId = (id: string): RemoteDevice | undefined =>
    state.devices.find((device) => device.id === id);

  return {
    settings: () => ({
      enabled: state.enabled,
      autoUnlink: state.autoUnlink,
      notifyConnections: state.notifyConnections,
      port: state.port,
    }),
    setEnabled: (enabled) => {
      state.enabled = enabled;
      persist();
    },
    setAutoUnlink: (enabled) => {
      state.autoUnlink = enabled;
      persist();
    },
    setNotifyConnections: (enabled) => {
      state.notifyConnections = enabled;
      persist();
    },
    setPort: (port) => {
      state.port = port;
      persist();
    },
    list: () => state.devices.map(view),
    add: ({ name, client, devicePub, ip }) => {
      const now = deps.now();
      const device: RemoteDevice = {
        id: randomUUID(),
        name,
        devicePub,
        client,
        createdAt: now,
        lastSeenAt: now,
        verifiedAt: null,
        lastIp: ip ?? null,
      };
      state.devices.push(device);
      persist();
      return view(device);
    },
    rename: (id, name) => {
      const normalized = normalizeDeviceName(name);
      if (normalized === null) return 'invalid-name';
      const device = byId(id);
      if (!device) return 'not-found';
      device.name = normalized;
      persist();
      return 'ok';
    },
    remove: (id) => {
      const before = state.devices.length;
      state.devices = state.devices.filter((device) => device.id !== id);
      if (state.devices.length === before) return false;
      persistedSeen.delete(id);
      persist();
      return true;
    },
    find: (id) => {
      const device = byId(id);
      return device ? view(device) : null;
    },
    devicePub: (id) => byId(id)?.devicePub ?? null,
    setDevicePub: (id, devicePub) => {
      const device = byId(id);
      if (!device) return false;
      device.devicePub = devicePub;
      device.verifiedAt = null;
      persist();
      return true;
    },
    markVerified: (id) => {
      const device = byId(id);
      if (!device) return false;
      device.verifiedAt = deps.now();
      persist();
      return true;
    },
    clearVerified: () => {
      for (const device of state.devices) device.verifiedAt = null;
      persist();
    },
    identity: () => (state.identity ? { ...state.identity } : null),
    saveIdentity: (identity) => {
      state.identity = { ...identity };
      persist();
    },
    touch: (id) => {
      const device = byId(id);
      if (!device) return false;
      device.lastSeenAt = deps.now();
      const onDisk = persistedSeen.get(id) ?? 0;
      if (device.lastSeenAt - onDisk < LAST_SEEN_PERSIST_MS) return false;
      persist();
      return true;
    },
    recordIp: (id, ip) => {
      const device = byId(id);
      if (!device) return null;
      const previous = device.lastIp;
      if (previous !== ip) {
        device.lastIp = ip;
        persist();
      }
      return previous;
    },
    pruneStale: () => {
      if (!state.autoUnlink) return 0;
      const cutoff = deps.now() - STALE_AFTER_MS;
      const kept = state.devices.filter(
        (device) => device.lastSeenAt >= cutoff,
      );
      const removed = state.devices.length - kept.length;
      if (removed === 0) return 0;
      state.devices = kept;
      persist();
      return removed;
    },
  };
}
