import { describe, expect, it } from 'vitest';
import { createRemoteClient } from '../renderer/remote/api.js';
import {
  createChannel,
  RemoteError,
  type Fetcher,
} from '../renderer/remote/channel.js';
import {
  fakeRuntime,
  harness,
  linkPhone,
  type Harness,
  type LinkedPhone,
} from './helpers/remote-control-harness.js';

/**
 * The phone's client (renderer/remote/api.ts) against the real desktop: when
 * it signs in, what it retries on a fresh session, and the one answer after
 * which it gives the device up.
 */

/** Lets every pending promise and microtask run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

async function setup(runtime = fakeRuntime()) {
  const h = harness(undefined, { runtime });
  await h.remote.setEnabled(true);
  const phone = await linkPhone(h);
  return { h, phone };
}

function clientFor(h: Harness, phone: LinkedPhone, fetch: Fetcher) {
  const lost: string[] = [];
  const client = createRemoteClient(fetch, {
    onLost: (reason) => lost.push(reason),
  });
  client.trust({
    serverKey: phone.serverKey,
    device: { id: phone.deviceId, secretKey: phone.device.secretKey },
  });
  return { client, lost };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RemoteError ? error.code : String(error);
  }
  return 'resolved';
}

describe('renderer/remote/api.ts', () => {
  describe('signing in', () => {
    it('never sends a call on a half-made session: it waits for the sign-in', async () => {
      const { h, phone } = await setup();
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      // The first call after the handshake is the sign-in: hold it back.
      const fetch: Fetcher = async (url, init) => {
        if (url === '/api/rpc' && ++calls === 1) await held;
        return h.net.fetch(url, init);
      };
      const { client, lost } = clientFor(h, phone, fetch);

      const signingIn = client.reconnect();
      await flush();
      const state = client.call('state');
      await flush();
      release();
      await signingIn;

      await expect(state).resolves.toMatchObject({ status: 200 });
      expect(lost).toEqual([]);
    });

    it('gives the device up only when a fresh sign-in says it is unknown', async () => {
      const { h, phone } = await setup();
      const { client, lost } = clientFor(h, phone, h.net.fetch);

      h.remote.unlinkDevice(phone.deviceId);

      expect(await codeOf(client.reconnect())).toBe('unlinked');
      expect(lost).toEqual(['unlinked']);
    });

    it('keeps the device when the sign-in fails for any other reason', async () => {
      const { h, phone } = await setup();
      const { client, lost } = clientFor(h, phone, h.net.fetch);
      client.trust({
        serverKey: phone.serverKey,
        // The desktop knows the device, but not by this key.
        device: { id: phone.deviceId, secretKey: new Uint8Array(32).fill(7) },
      });

      expect(await codeOf(client.reconnect())).toBe('http');
      expect(lost).toEqual([]);
    });
  });

  describe('a session DevBar no longer knows', () => {
    it('retries a read on a fresh session, transparently', async () => {
      const { h, phone } = await setup();
      const { client } = clientFor(h, phone, h.net.fetch);
      await client.reconnect();
      await h.remote.setEnabled(false);
      await h.remote.setEnabled(true);

      await expect(client.call('state')).resolves.toMatchObject({
        status: 200,
      });
    });

    it('never runs a command twice: a forged «session» after it ran is reported, not retried', async () => {
      const runtime = fakeRuntime();
      let stops = 0;
      runtime.actions.stopAll = () => {
        stops += 1;
        return Promise.resolve({ ok: true, stopped: 0 });
      };
      const { h, phone } = await setup(runtime);
      let forge = false;
      // DevBar runs the command; on the way back the reply is swapped for
      // a plaintext 401 `session`, which anyone on the network can send.
      const fetch: Fetcher = async (url, init) => {
        const reply = await h.net.fetch(url, init);
        if (url !== '/api/rpc' || !forge) return reply;
        forge = false;
        return {
          status: 401,
          json: () => Promise.resolve({ error: 'session' }),
        };
      };
      const { client } = clientFor(h, phone, fetch);
      await client.reconnect();

      forge = true;
      expect(await codeOf(client.call('stopAll'))).toBe('session');

      expect(stops).toBe(1);
      // The next call simply shakes hands again.
      await expect(client.call('stopAll')).resolves.toMatchObject({
        status: 200,
      });
      expect(stops).toBe(2);
    });

    it.each(['state', 'logs', 'notices', 'branches', 'settings.get', 'me'])(
      'treats %s as a read worth retrying',
      async (op) => {
        const runtime = fakeRuntime();
        runtime.settings.get = () =>
          ({
            autostart: false,
            notifySuccess: true,
            silenceWarnings: false,
            silenceErrors: false,
          }) as ReturnType<typeof runtime.settings.get>;
        const { h, phone } = await setup(runtime);
        let forged = 0;
        const fetch: Fetcher = async (url, init) => {
          if (url === '/api/rpc' && forged === 1) {
            forged += 1;
            return {
              status: 401,
              json: () => Promise.resolve({ error: 'session' }),
            };
          }
          return h.net.fetch(url, init);
        };
        const { client } = clientFor(h, phone, fetch);
        await client.reconnect();
        forged = 1;

        expect(await codeOf(client.call(op, { id: 'x', groupId: 'g' }))).toBe(
          'resolved',
        );
        expect(forged).toBe(2);
      },
    );
  });
});

describe('renderer/remote/channel.ts', () => {
  it('is not ready until its sign-in succeeded', async () => {
    const { h, phone } = await setup();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: Fetcher = async (url, init) => {
      if (url === '/api/rpc') await held;
      return h.net.fetch(url, init);
    };
    const channel = createChannel(fetch);

    const opening = channel.open(phone.serverKey, {
      id: phone.deviceId,
      secretKey: phone.device.secretKey,
    });
    await flush();
    expect(channel.ready()).toBe(false);
    expect(channel.events()).toBeNull();
    release();
    await opening;

    expect(channel.ready()).toBe(true);
  });
});
