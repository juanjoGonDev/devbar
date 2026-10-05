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
import { logBatch, noticesView, settingsView, stateView } from './wire.js';

export type { Answer, Fetcher } from './channel.js';

/**
 * The phone page's side of the «Control remoto» API, over devbar-rc/1
 * (renderer/remote/channel.ts). It knows whom to trust — the identity key
 * from the pairing QR, or the one this device pinned — and, for a linked
 * device, signs in (`auth`) after every handshake. A session the desktop
 * forgot is replaced transparently: the call is retried once on a fresh one.
 *
 * Every answer is read as `unknown` and narrowed (here or in wire.ts). Calls
 * DevBar never answered reject; any answer resolves, whatever its status,
 * and the caller decides what it means. Losing trust — another identity key,
 * or a device the desktop no longer knows — is reported once through
 * `onLost`, and the call rejects.
 */

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
    const { serverKey, device } = trust;
    await channel.open(serverKey);
    if (!device) return;
    const answer = await channel.send('auth', {
      deviceId: device.id,
      sig: channel.proof(device.secretKey),
    });
    if (answer.status === 200) return;
    channel.close();
    throw new RemoteError(answer.status === 401 ? 'unlinked' : 'http');
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

  async function call(op: string, args: unknown = {}): Promise<Answer> {
    if (!channel.ready()) await connect();
    try {
      return await channel.send(op, args);
    } catch (error) {
      if (!(error instanceof RemoteError) || error.code !== 'session')
        throw error;
      await connect();
      return channel.send(op, args);
    }
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
    requestPairing: (code: string, name: string, devicePub: string) =>
      call('pair.request', { code, name, devicePub }),
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
