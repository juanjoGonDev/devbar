import { describe, expect, it } from 'vitest';
import type { ApiRequest, RpcCall } from '../src/main/remote/api.js';
import type { RemoteDeviceView } from '../src/ipc-contract/remote-api.js';
import { createRpc } from '../src/main/remote/rpc.js';
import type { Session } from '../src/main/remote/sessions.js';

/**
 * devbar-rc/1 operations onto the handlers that already existed: session
 * operations to src/main/remote/api.ts, everything else — for a proven
 * device only — to the route of src/main/remote/control-api.ts it always
 * was. No business rule lives here; this only routes.
 */

const DEVICE: RemoteDeviceView = {
  id: 'd1',
  name: 'iPhone',
  client: 'Safari · iOS',
  createdAt: 1,
  lastSeenAt: 1,
  verifiedAt: null,
};

function session(deviceId: string | null): Session {
  return {
    id: 'sid-1',
    ip: '192.168.1.40',
    transcript: Buffer.from('T'),
    deviceId,
    logsId: null,
    open: () => null,
    seal: () => ({ n: 1, ct: '' }),
    sealEvent: () => '',
  };
}

function harness() {
  const routed: { request: ApiRequest; device: RemoteDeviceView }[] = [];
  const sessionCalls: string[] = [];
  const subscriptions: [string, string | null][] = [];
  let touched = 0;
  let persisted = false;
  let changed = 0;
  const rpc = createRpc({
    session: {
      handles: (op) => op === 'me' || op === 'auth',
      handle: (op) => {
        sessionCalls.push(op);
        return { status: 200, body: { op } };
      },
    },
    control: {
      handle: (request, device) => {
        routed.push({ request, device });
        return Promise.resolve({ status: 200, body: { routed: true } });
      },
    },
    devices: {
      find: (id) => (id === 'd1' ? DEVICE : null),
      touch: () => {
        touched += 1;
        return persisted;
      },
    },
    devicesChanged: () => {
      changed += 1;
    },
    subscribeLogs: (sessionId, logsId) =>
      subscriptions.push([sessionId, logsId]),
  });
  const call = (on: Session): RpcCall => ({
    session: on,
    ip: on.ip,
    userAgent: 'UA',
  });
  return {
    rpc,
    call,
    routed,
    sessionCalls,
    subscriptions,
    touched: () => touched,
    changed: () => changed,
    persistTouches: () => {
      persisted = true;
    },
  };
}

describe('src/main/remote/rpc.ts', () => {
  it('hands session operations to the session API, authenticated or not', async () => {
    const h = harness();

    await expect(h.rpc('me', {}, h.call(session(null)))).resolves.toEqual({
      status: 200,
      body: { op: 'me' },
    });
    expect(h.sessionCalls).toEqual(['me']);
  });

  it('refuses every control operation to a session that is no device', async () => {
    const h = harness();

    for (const deviceId of [null, 'gone'])
      await expect(
        h.rpc('state', {}, h.call(session(deviceId))),
      ).resolves.toEqual({ status: 401, body: { error: 'unlinked' } });
    expect(h.routed).toEqual([]);
  });

  it('answers 404 to an operation nobody knows', async () => {
    const h = harness();

    await expect(h.rpc('rm -rf', {}, h.call(session('d1')))).resolves.toEqual({
      status: 404,
      body: { error: 'unknown-op' },
    });
  });

  it.each([
    ['state', 'GET', '/api/state'],
    ['process.start', 'POST', '/api/process/start'],
    ['process.stop', 'POST', '/api/process/stop'],
    ['actions.run', 'POST', '/api/actions/run'],
    ['pipeline.run', 'POST', '/api/pipeline/run'],
    ['stopAll', 'POST', '/api/stop-all'],
    ['branches', 'GET', '/api/branches'],
    ['branch', 'POST', '/api/branch'],
    ['logs', 'GET', '/api/logs'],
    ['notices', 'GET', '/api/notices'],
    ['confirm', 'POST', '/api/confirm'],
    ['settings.get', 'GET', '/api/settings'],
    ['settings.set', 'POST', '/api/settings'],
    ['update.apply', 'POST', '/api/update/apply'],
    ['device.rename', 'POST', '/api/device/rename'],
  ])(
    'runs %s as %s %s for the calling device',
    async (op, method, pathname) => {
      const h = harness();

      await h.rpc(op, {}, h.call(session('d1')));

      expect(h.routed[0]?.request).toMatchObject({ method, pathname });
      expect(h.routed[0]?.device).toBe(DEVICE);
    },
  );

  it('turns the arguments of a read into its query, and of a write into its body', async () => {
    const h = harness();
    const on = session('d1');

    await h.rpc('logs', { id: 'cmd:g1:web', tail: 300, junk: {} }, h.call(on));
    await h.rpc('process.start', { processId: 'cmd:g1:web' }, h.call(on));

    const [read, write] = h.routed.map((entry) => entry.request);
    expect(Object.fromEntries(read?.query ?? [])).toEqual({
      id: 'cmd:g1:web',
      tail: '300',
    });
    expect(read?.body).toBeUndefined();
    expect(write?.body).toEqual({ processId: 'cmd:g1:web' });
    expect(write?.sessionId).toBe('sid-1');
  });

  it('counts every call of a device as a sign of life', async () => {
    const h = harness();
    await h.rpc('state', {}, h.call(session('d1')));
    expect([h.touched(), h.changed()]).toEqual([1, 0]);

    h.persistTouches();
    await h.rpc('state', {}, h.call(session('d1')));
    expect([h.touched(), h.changed()]).toEqual([2, 1]);
  });

  describe('logs.subscribe', () => {
    it("moves the session's stream to a process, or to none", async () => {
      const h = harness();
      const on = session('d1');

      await expect(
        h.rpc('logs.subscribe', { id: 'cmd:g1:web' }, h.call(on)),
      ).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(on.logsId).toBe('cmd:g1:web');
      await h.rpc('logs.subscribe', { id: null }, h.call(on));
      expect(on.logsId).toBeNull();
      expect(h.subscriptions).toEqual([
        ['sid-1', 'cmd:g1:web'],
        ['sid-1', null],
      ]);
    });

    it('refuses a malformed process id, and a session that is no device', async () => {
      const h = harness();

      await expect(
        h.rpc('logs.subscribe', { id: '' }, h.call(session('d1'))),
      ).resolves.toEqual({ status: 400, body: { error: 'invalid-request' } });
      await expect(
        h.rpc('logs.subscribe', { id: 'x' }, h.call(session(null))),
      ).resolves.toMatchObject({ status: 401 });
      expect(h.subscriptions).toEqual([]);
    });
  });
});
