import type {
  RemoteNotice,
  RemoteSettingsView,
  RemoteStateView,
} from '../../src/ipc-contract/remote-wire.js';
import { logBatch, noticesView, settingsView, stateView } from './wire.js';

/**
 * The phone page's side of src/main/remote/api.ts and control-api.ts. Every
 * answer is read as `unknown` and narrowed (here or in wire.ts), so the views
 * only ever see shapes they can trust; every POST carries the JSON content
 * type and the `X-DevBar-Request` header the server demands of a mutation.
 * Requests that DevBar never answered reject; any answer resolves, whatever
 * its status, and the caller decides what that status means.
 */

export type Fetcher = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface Me {
  linked: boolean;
  deviceId: string;
  deviceName: string;
  deviceCreatedAt: number;
  hostName: string;
  version: string;
  suggestedName: string;
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const MUTATION_HEADERS = {
  'Content-Type': 'application/json',
  'X-DevBar-Request': '1',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export function createRemoteClient(fetcher: Fetcher) {
  const read = async (url: string, init?: RequestInit): Promise<Answer> => {
    const response = await fetcher(url, init);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* not JSON — the status alone has to do */
    }
    return { status: response.status, body: record(body) };
  };
  const post = (url: string, payload: unknown = {}): Promise<Answer> =>
    read(url, {
      method: 'POST',
      headers: MUTATION_HEADERS,
      body: JSON.stringify(payload),
    });
  /** A GET whose answer is only usable as a 200. */
  const ok = async (url: string): Promise<Answer> => {
    const answer = await read(url);
    if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
    return answer;
  };

  return {
    post,
    /** Throws when DevBar cannot be reached or answers nonsense. */
    me: async (): Promise<Me> => {
      const answer = await ok('/api/me');
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
    requestPairing: (code: string, name: string) =>
      post('/api/pair/request', { code, name }),
    pairStatus: (requestId: string) =>
      read(`/api/pair/status?id=${encodeURIComponent(requestId)}`),
    cancelPairing: (requestId: string) =>
      post('/api/pair/cancel', { requestId }),
    unlink: () => post('/api/unlink', {}),
    state: async (): Promise<RemoteStateView> =>
      stateView((await ok('/api/state')).body),
    notices: async (): Promise<RemoteNotice[]> =>
      noticesView((await ok('/api/notices')).body),
    settings: async (): Promise<RemoteSettingsView> =>
      settingsView((await ok('/api/settings')).body),
    logs: async (id: string, tail = 300) => {
      const answer = await ok(
        `/api/logs?id=${encodeURIComponent(id)}&tail=${tail}`,
      );
      const seq = answer.body.seq;
      return {
        ...logBatch(answer.body),
        seq: typeof seq === 'number' ? seq : 0,
      };
    },
    branches: async (groupId: string) => {
      const { body } = await ok(
        `/api/branches?groupId=${encodeURIComponent(groupId)}`,
      );
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
