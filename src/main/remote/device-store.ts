import crypto from 'node:crypto';
import type { RemoteDeviceView } from '../../ipc-contract/remote-api.js';

/**
 * The linked devices and the remote-control switches, persisted under their
 * own `remoteControl` store key — never in globalSettings, which every window
 * reads and every export/backup dumps.
 *
 * A device's session token is handed out exactly once (`add`) and only its
 * sha256 is stored: the config file, a backup of it, or a renderer that
 * somehow read the state can never hand anyone a working session.
 */

const DEFAULT_REMOTE_PORT = 47821;
const DEVICE_NAME_MAX = 40;
/** `lastSeenAt` reaches the disk at most this often per device. */
const LAST_SEEN_PERSIST_MS = 60_000;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /\p{Cc}/u;

interface RemoteDevice extends RemoteDeviceView {
  /** sha256 hex of the session token. */
  tokenHash: string;
}

export interface RemoteControlState {
  enabled: boolean;
  autoUnlink: boolean;
  port: number;
  devices: RemoteDevice[];
}

export interface DeviceStoreDeps {
  read(): unknown;
  write(state: RemoteControlState): void;
  now(): number;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Buffer;
}

type RenameOutcome = 'ok' | 'invalid-name' | 'not-found';

export interface DeviceStore {
  settings(): { enabled: boolean; autoUnlink: boolean; port: number };
  setEnabled(enabled: boolean): void;
  setAutoUnlink(enabled: boolean): void;
  list(): RemoteDeviceView[];
  add(input: { name: string; client: string }): {
    device: RemoteDeviceView;
    token: string;
  };
  rename(id: string, name: string): RenameOutcome;
  remove(id: string): boolean;
  findByToken(token: string): RemoteDeviceView | null;
  /** Marks the device as seen now; true when that reached the disk. */
  touch(id: string): boolean;
  /** Removes devices unseen for 30 days (auto-unlink only); the count. */
  pruneStale(): number;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
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
  const { id, name, tokenHash, client, createdAt, lastSeenAt } = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof tokenHash !== 'string' ||
    !TOKEN_HASH.test(tokenHash) ||
    typeof client !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof lastSeenAt !== 'number'
  )
    return null;
  return { id, name, tokenHash, client, createdAt, lastSeenAt };
}

function normalizePort(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65535
    ? value
    : DEFAULT_REMOTE_PORT;
}

/** Whatever is on disk, as a state the rest of the module can trust. */
export function normalizeRemoteState(raw: unknown): RemoteControlState {
  const record = isRecord(raw) ? raw : {};
  const devices = Array.isArray(record.devices) ? record.devices : [];
  return {
    enabled: record.enabled === true,
    autoUnlink: record.autoUnlink !== false,
    port: normalizePort(record.port),
    devices: devices
      .map(normalizeDevice)
      .filter((device): device is RemoteDevice => device !== null),
  };
}

function view(device: RemoteDevice): RemoteDeviceView {
  const { tokenHash: _hash, ...rest } = device;
  return rest;
}

/** Constant-time comparison of two hex digests of the same length. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createDeviceStore(deps: DeviceStoreDeps): DeviceStore {
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const randomBytes = deps.randomBytes ?? ((size) => crypto.randomBytes(size));
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
    list: () => state.devices.map(view),
    add: ({ name, client }) => {
      const token = randomBytes(32).toString('base64url');
      const now = deps.now();
      const device: RemoteDevice = {
        id: randomUUID(),
        name,
        tokenHash: hashToken(token),
        client,
        createdAt: now,
        lastSeenAt: now,
      };
      state.devices.push(device);
      persist();
      return { device: view(device), token };
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
    findByToken: (token) => {
      if (!token) return null;
      const hash = hashToken(token);
      // Every device is compared, matched or not, so the time taken says
      // nothing about which (or whether one) matched.
      let found: RemoteDevice | null = null;
      for (const device of state.devices)
        if (sameHash(device.tokenHash, hash)) found = device;
      return found ? view(found) : null;
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
