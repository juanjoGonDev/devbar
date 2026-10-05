import type {
  RemoteNotice,
  RemoteSettingsView,
  RemoteStateView,
} from '../../src/ipc-contract/remote-wire.js';
import {
  createChannel,
  RemoteError,
  type Answer,
  type EventReader,
  type Fetcher,
} from './channel.js';
import { pairMessage, rotateMessage, sign, toB64 } from './rc-protocol.js';
import { logBatch, noticesView, settingsView, stateView } from './wire.js';

export type { Answer, Fetcher } from './channel.js';

/**
 * The phone page's side of the «Control remoto» API, over devbar-rc/1
 * (renderer/remote/channel.ts). It knows whom to trust — the identity key
 * from the pairing QR, or the one this device pinned — and, for a linked
 * device, signs in (`auth`) as part of every handshake: a call made while
 * one is under way waits for it, so nothing goes out half signed in.
 *
 * A session the desktop forgot (a plaintext 401 `session`, which anyone on
 * the network could also send) is replaced on the next call. Only a read is
 * retried on the fresh one at once: a command whose reply was lost may
 * already have run, so it rejects with `session` and the user decides.
 *
 * Every answer is read as `unknown` and narrowed (here or in wire.ts). Calls
 * DevBar never answered reject; any answer resolves, whatever its status,
 * and the caller decides what it means. Losing trust — another identity key,
 * or a sign-in refused because the desktop does not know this device — is
 * reported once through `onLost`, and the call rejects.
 */

/** Reads, safe to send twice: the only calls retried on a fresh session. */
const RETRIED = new Set([
  'state',
  'logs',
  'notices',
  'branches',
  'settings.get',
  'me',
]);

export interface Me {
  linked: boolean;
  deviceId: string;
  deviceName: string;
  deviceCreatedAt: number;
  hostName: string;
  version: string;
  suggestedName: string;
}

/** Who to trust: a desktop identity key, and this device's own key once linked. */
export interface Trust {
  serverKey: Uint8Array;
  device: { id: string; secretKey: Uint8Array } | null;
}

export interface ClientHooks {
  onLost(reason: 'changed' | 'unlinked'): void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const isLost = (error: unknown): error is RemoteError =>
  error instanceof RemoteError &&
  (error.code === 'changed' || error.code === 'unlinked');

export function createRemoteClient(fetcher: Fetcher, hooks: ClientHooks) {
  const channel = createChannel(fetcher);
  let trust: Trust | null = null;
  let connecting: Promise<void> | null = null;

  async function handshake(): Promise<void> {
    if (!trust) throw new RemoteError('session');
    await channel.open(trust.serverKey, trust.device);
  }

  /** One handshake at a time, however many calls are waiting for it. */
  const connect = (): Promise<void> => {
    connecting ??= handshake()
      .catch((error: unknown) => {
        if (isLost(error)) hooks.onLost(error.code as 'changed' | 'unlinked');
        throw error;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };

  /** A ready session: the handshake under way, or a new one. */
  const session = (): Promise<void> =>
    connecting ?? (channel.ready() ? Promise.resolve() : connect());

  async function call(op: string, args: unknown = {}): Promise<Answer> {
    await session();
    try {
      return await channel.send(op, args);
    } catch (error) {
      if (
        !(error instanceof RemoteError) ||
        error.code !== 'session' ||
        !RETRIED.has(op)
      )
        throw error;
      await connect();
      return channel.send(op, args);
    }
  }

  /** A call whose new key signs this very session's handshake. */
  async function provenCall(
    op: string,
    key: { secretKey: Uint8Array; publicKey: Uint8Array },
    message: (handshake: Uint8Array) => Uint8Array,
    args: Record<string, unknown>,
  ): Promise<Answer> {
    await session();
    const handshake = channel.handshake();
    if (!handshake) throw new RemoteError('session');
    return channel.send(op, {
      ...args,
      devicePub: toB64(key.publicKey),
      sig: toB64(sign(key.secretKey, message(handshake))),
    });
  }

  /** A read whose answer is only usable as a 200. */
  const ok = async (op: string, args: unknown = {}): Promise<Answer> => {
    const answer = await call(op, args);
    if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
    return answer;
  };

  return {
    /** From now on, trust this; the next call shakes hands again. */
    trust: (next: Trust): void => {
      trust = next;
      channel.close();
    },
    /** A fresh handshake (and sign-in) right now. */
    reconnect: (): Promise<void> => {
      channel.close();
      return connect();
    },
    /**
     * Whether the desktop still knows this device: a sign-in on a session
     * of its own, so the one in use (and its stream) is left alone. Refused
     * for an unknown device, it is reported through `onLost` like any other.
     */
    confirmLinked: async (): Promise<boolean> => {
      if (!trust?.device) return false;
      try {
        await createChannel(fetcher).open(trust.serverKey, trust.device);
        return true;
      } catch (error) {
        if (isLost(error)) hooks.onLost(error.code as 'changed' | 'unlinked');
        return false;
      }
    },
    call,
    /** The reader for a stream on the current session, if there is one. */
    events: (): EventReader | null => channel.events(),
    /** Throws when DevBar cannot be reached or answers nonsense. */
    me: async (): Promise<Me> => {
      const answer = await ok('me');
      const host = record(answer.body.host);
      const device = record(answer.body.device);
      return {
        linked: answer.body.linked === true,
        deviceId: text(device.id),
        deviceName: text(device.name),
        deviceCreatedAt:
          typeof device.createdAt === 'number' ? device.createdAt : 0,
        hostName: text(host.name) || 'este ordenador',
        version: text(host.version),
        suggestedName: text(answer.body.suggestedName),
      };
    },
    /** Spends the QR's code for this session, before the name is asked. */
    claimPairing: (code: string) => call('pair.claim', { code }),
    /** Asks this session's claim to pair `device`, proving it holds the key. */
    requestPairing: (
      name: string,
      device: { secretKey: Uint8Array; publicKey: Uint8Array },
    ) => provenCall('pair.request', device, pairMessage, { name }),
    /** Replaces this device's key with `next`, proving it holds it. */
    rotateKey: (next: { secretKey: Uint8Array; publicKey: Uint8Array }) =>
      provenCall('device.rotate', next, rotateMessage, {}),
    pairStatus: (requestId: string) => call('pair.status', { requestId }),
    cancelPairing: (requestId: string) => call('pair.cancel', { requestId }),
    state: async (): Promise<RemoteStateView> =>
      stateView((await ok('state')).body),
    notices: async (): Promise<RemoteNotice[]> =>
      noticesView((await ok('notices')).body),
    settings: async (): Promise<RemoteSettingsView> =>
      settingsView((await ok('settings.get')).body),
    logs: async (id: string, tail = 300) => {
      const answer = await ok('logs', { id, tail });
      const seq = answer.body.seq;
      return {
        ...logBatch(answer.body),
        seq: typeof seq === 'number' ? seq : 0,
      };
    },
    branches: async (groupId: string) => {
      const { body } = await ok('branches', { groupId });
      const branches = Array.isArray(body.branches) ? body.branches : [];
      return {
        ok: body.ok === true,
        branches: branches.filter((b): b is string => typeof b === 'string'),
        error: text(body.error),
      };
    },
  };
}

export type RemoteClient = ReturnType<typeof createRemoteClient>;
