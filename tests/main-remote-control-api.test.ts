import { describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../src/main/remote/api.js';
import {
  createControlApi,
  type ControlApiDeps,
} from '../src/main/remote/control-api.js';
import { createConfirmQueue } from '../src/main/confirm-queue.js';
import type { GlobalSettings, Group, LogEntry } from '../src/domain-types.js';
import type { RemoteDeviceView } from '../src/ipc-contract/remote-api.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeSettings,
} from './helpers/main-fakes.js';

const DEVICE: RemoteDeviceView = {
  id: 'd1',
  name: 'iPhone de Ana',
  client: 'Safari · iOS',
  createdAt: 1,
  lastSeenAt: 1,
};

const GROUPS: Group[] = [
  makeGroup({
    id: 'g1',
    commands: [
      makeCommand({ id: 'web', confirm: true }),
      makeCommand({ id: 'api' }),
    ],
    actions: [
      makeAction({ id: 'seed', confirm: true }),
      makeAction({ id: 'lint' }),
    ],
  }),
];

type Deferred = { resolve: (value: { ok: boolean }) => void };

function harness(overrides: Partial<ControlApiDeps> = {}) {
  const calls: string[] = [];
  const held: Deferred[] = [];
  const hold = <T>(label: string) => {
    calls.push(label);
    return new Promise<T>((resolve) => {
      held.push({ resolve: resolve as Deferred['resolve'] });
    });
  };
  let settings = makeSettings();
  const logs = new Map<string, LogEntry[]>();
  const pendingTokens = new Set<string>(['t1']);
  let renameOutcome: 'ok' | 'invalid-name' | 'not-found' = 'ok';
  const errors: unknown[] = [];
  const deps: ControlApiDeps = {
    configStore: {
      getGroup: (id) => GROUPS.find((group) => group.id === id) ?? null,
    },
    runtime: {
      startProcess: (pid) =>
        pid === 'cmd:g1:web'
          ? hold(`start:${pid}`)
          : (calls.push(`start:${pid}`), Promise.resolve({ ok: true })),
      stopProcess: (pid) => {
        calls.push(`stop:${pid}`);
        return Promise.resolve({ ok: true });
      },
      runAction: (groupId, actionId) =>
        actionId === 'seed'
          ? hold(`run:${groupId}:${actionId}`)
          : (calls.push(`run:${groupId}:${actionId}`),
            Promise.resolve({ ok: false, processId: 'x', error: 'boom' })),
      stopAll: () => {
        calls.push('stopAll');
        return Promise.resolve({ ok: true, stopped: 2 });
      },
      runPipeline: () => hold('pipeline'),
      listBranches: () =>
        Promise.resolve({ ok: true, branches: ['main', 'feat/x'] }),
      switchBranch: (groupId, branch) => {
        calls.push(`switch:${groupId}:${branch}`);
        return Promise.resolve({ ok: true });
      },
      needsConfirm: (pid) => pid === 'cmd:g1:web' || pid === 'act:g1:seed',
    },
    state: () =>
      Promise.resolve({ now: 5 } as unknown as Awaited<
        ReturnType<ControlApiDeps['state']>
      >),
    logs: (id) => logs.get(id) ?? [],
    logSeq: (id) => logs.get(id)?.at(-1)?.seq ?? 0,
    notices: () => [{ id: 1, ts: 1, kind: 'info', title: 'hola', body: '' }],
    confirms: {
      hasPending: (token) => pendingTokens.has(token),
      resolveConfirm: (token, decision) => {
        pendingTokens.delete(token);
        calls.push(`resolve:${token}:${decision}`);
      },
    },
    settings: {
      get: () => settings,
      save: (patch: Partial<GlobalSettings>) => {
        calls.push(`save:${JSON.stringify(patch)}`);
        settings = { ...settings, ...patch };
        return settings;
      },
    },
    updater: {
      canInstallStaged: () => false,
      installStagedHeadless: () => {
        calls.push('install');
        return Promise.resolve({ ok: true, quitting: true });
      },
    },
    renameDevice: (id, name) => {
      calls.push(`rename:${id}:${name}`);
      return renameOutcome;
    },
    branchSwitched: (groupId) => calls.push(`branchSwitched:${groupId}`),
    reportError: (error) => errors.push(error),
    ...overrides,
  };
  const api = createControlApi(deps);
  const call = (request: Partial<ApiRequest>) =>
    api.handle(
      {
        method: 'GET',
        pathname: '/api/state',
        query: new URLSearchParams(),
        token: 'x',
        ip: '192.168.1.40',
        userAgent: undefined,
        body: undefined,
        ...request,
      },
      DEVICE,
    );
  const post = (pathname: string, body: unknown = {}) =>
    call({ method: 'POST', pathname, body });
  const get = (pathname: string, query: Record<string, string> = {}) =>
    call({ pathname, query: new URLSearchParams(query) });
  return {
    api,
    deps,
    calls,
    held,
    logs,
    errors,
    post,
    get,
    failRename: (outcome: 'invalid-name' | 'not-found') => {
      renameOutcome = outcome;
    },
  };
}

describe('src/main/remote/control-api.ts', () => {
  describe('routing', () => {
    it('claims only its own paths', () => {
      const { api } = harness();

      expect(api.handles('/api/state')).toBe(true);
      expect(api.handles('/api/settings')).toBe(true);
      expect(api.handles('/api/me')).toBe(false);
      expect(api.handles('/api/pair/request')).toBe(false);
    });

    it('answers 405 to a known path with the wrong method', async () => {
      const h = harness();

      await expect(h.get('/api/process/start')).resolves.toEqual({
        status: 405,
        body: { error: 'method-not-allowed' },
      });
      await expect(h.post('/api/state')).resolves.toMatchObject({
        status: 405,
      });
    });
  });

  describe('GET /api/state', () => {
    it('answers the state the phone paints', async () => {
      const h = harness();

      await expect(h.get('/api/state')).resolves.toEqual({
        status: 200,
        body: { now: 5 },
      });
    });
  });

  describe('POST /api/process/start', () => {
    it('starts a command and answers with the outcome', async () => {
      const h = harness();

      await expect(
        h.post('/api/process/start', { processId: 'cmd:g1:api' }),
      ).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(h.calls).toEqual(['start:cmd:g1:api']);
    });

    it('does not wait on a confirmation: 202, and the start carries on', async () => {
      const h = harness();

      await expect(
        h.post('/api/process/start', { processId: 'cmd:g1:web' }),
      ).resolves.toEqual({ status: 202, body: { pending: true } });
      expect(h.calls).toEqual(['start:cmd:g1:web']);
      h.held[0]?.resolve({ ok: true });
    });

    it.each([
      [{}, 400],
      [{ processId: 7 }, 400],
      [{ processId: 'act:g1:lint' }, 400],
      [{ processId: 'cmd:g1:nope' }, 404],
      [{ processId: 'cmd:nope:web' }, 404],
      [{ processId: 'pre:g1:s1' }, 400],
    ])('refuses %j with %i', async (body, status) => {
      const h = harness();

      await expect(h.post('/api/process/start', body)).resolves.toMatchObject({
        status,
      });
      expect(h.calls).toEqual([]);
    });

    it('reports a background start that blew up instead of losing it', async () => {
      const failure = new Error('spawn failed');
      const base = harness();
      const h = harness({
        runtime: {
          ...base.deps.runtime,
          startProcess: () => Promise.reject(failure),
        },
      });

      await expect(
        h.post('/api/process/start', { processId: 'cmd:g1:web' }),
      ).resolves.toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(h.errors).toEqual([failure]));
    });
  });

  describe('POST /api/process/stop', () => {
    it('stops a command or an action', async () => {
      const h = harness();

      await h.post('/api/process/stop', { processId: 'cmd:g1:web' });
      await h.post('/api/process/stop', { processId: 'act:g1:lint' });

      expect(h.calls).toEqual(['stop:cmd:g1:web', 'stop:act:g1:lint']);
    });

    it('answers 404 for a process that does not exist', async () => {
      const h = harness();

      await expect(
        h.post('/api/process/stop', { processId: 'act:g1:nope' }),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('POST /api/actions/run', () => {
    it('runs an action and relays a failure', async () => {
      const h = harness();

      await expect(
        h.post('/api/actions/run', { groupId: 'g1', actionId: 'lint' }),
      ).resolves.toEqual({ status: 200, body: { ok: false, error: 'boom' } });
    });

    it('answers 202 for an action that asks before running', async () => {
      const h = harness();

      await expect(
        h.post('/api/actions/run', { groupId: 'g1', actionId: 'seed' }),
      ).resolves.toEqual({ status: 202, body: { pending: true } });
    });

    it('refuses an unknown action', async () => {
      const h = harness();

      await expect(
        h.post('/api/actions/run', { groupId: 'g1', actionId: 'nope' }),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        h.post('/api/actions/run', { groupId: 'g1' }),
      ).resolves.toMatchObject({ status: 400 });
    });
  });

  describe('POST /api/pipeline/run and /api/stop-all', () => {
    it('starts the pipeline without waiting for it to finish', async () => {
      const h = harness();

      await expect(h.post('/api/pipeline/run')).resolves.toEqual({
        status: 202,
        body: { pending: true },
      });
      expect(h.calls).toEqual(['pipeline']);
    });

    it('stops every running service', async () => {
      const h = harness();

      await expect(h.post('/api/stop-all')).resolves.toEqual({
        status: 200,
        body: { ok: true, stopped: 2 },
      });
    });
  });

  describe('branches', () => {
    it('lists the branches of a group', async () => {
      const h = harness();

      await expect(h.get('/api/branches', { groupId: 'g1' })).resolves.toEqual({
        status: 200,
        body: { ok: true, branches: ['main', 'feat/x'] },
      });
    });

    it('relays a group that is not a repository', async () => {
      const h = harness({
        runtime: {
          ...harness().deps.runtime,
          listBranches: () =>
            Promise.resolve({ ok: false, error: 'not a git repo' }),
        },
      });

      await expect(h.get('/api/branches', { groupId: 'g1' })).resolves.toEqual({
        status: 200,
        body: { ok: false, branches: [], error: 'not a git repo' },
      });
    });

    it('switches to a branch from the list, then refreshes the cache', async () => {
      const h = harness();

      await expect(
        h.post('/api/branch', { groupId: 'g1', branch: 'feat/x' }),
      ).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(h.calls).toEqual(['switch:g1:feat/x', 'branchSwitched:g1']);
    });

    it('refuses a branch that is not in the list', async () => {
      const h = harness();

      await expect(
        h.post('/api/branch', { groupId: 'g1', branch: 'other' }),
      ).resolves.toEqual({ status: 400, body: { error: 'unknown-branch' } });
      await expect(
        h.post('/api/branch', { groupId: 'g1', branch: '--force' }),
      ).resolves.toMatchObject({ status: 400 });
      expect(h.calls).toEqual([]);
    });

    it('answers 404 for an unknown group', async () => {
      const h = harness();

      await expect(
        h.get('/api/branches', { groupId: 'nope' }),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        h.post('/api/branch', { groupId: 'nope', branch: 'main' }),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe('GET /api/logs', () => {
    const entry = (seq: number, line: string): LogEntry => ({
      ts: seq * 10,
      seq,
      stream: 'stdout',
      level: null,
      line,
    });

    it('answers the tail, ANSI-free, with where the buffer stands', async () => {
      const h = harness();
      h.logs.set('cmd:g1:web', [
        entry(1, 'one'),
        entry(2, '\u001b[32mtwo\u001b[0m'),
        entry(3, 'three'),
      ]);

      await expect(
        h.get('/api/logs', { id: 'cmd:g1:web', tail: '2' }),
      ).resolves.toEqual({
        status: 200,
        body: {
          id: 'cmd:g1:web',
          seq: 3,
          lines: [
            { seq: 2, ts: 20, level: null, line: 'two' },
            { seq: 3, ts: 30, level: null, line: 'three' },
          ],
        },
      });
    });

    it('refuses a bad tail and an unknown process', async () => {
      const h = harness();

      await expect(
        h.get('/api/logs', { id: 'cmd:g1:web', tail: 'lots' }),
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        h.get('/api/logs', { id: 'cmd:g1:nope' }),
      ).resolves.toMatchObject({ status: 404 });
      await expect(h.get('/api/logs')).resolves.toMatchObject({
        status: 400,
      });
    });
  });

  describe('GET /api/notices', () => {
    it('answers the notice log', async () => {
      const h = harness();

      await expect(h.get('/api/notices')).resolves.toEqual({
        status: 200,
        body: {
          notices: [{ id: 1, ts: 1, kind: 'info', title: 'hola', body: '' }],
        },
      });
    });
  });

  describe('POST /api/confirm', () => {
    it('answers a pending confirmation', async () => {
      const h = harness();

      await expect(
        h.post('/api/confirm', { token: 't1', decision: 'confirm' }),
      ).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(h.calls).toEqual(['resolve:t1:confirm']);
    });

    it('lets only the first answer count', async () => {
      const h = harness();
      await h.post('/api/confirm', { token: 't1', decision: 'cancel' });

      await expect(
        h.post('/api/confirm', { token: 't1', decision: 'confirm' }),
      ).resolves.toEqual({ status: 409, body: { error: 'already-answered' } });
      expect(h.calls).toEqual(['resolve:t1:cancel']);
    });

    it('refuses a malformed answer', async () => {
      const h = harness();

      await expect(
        h.post('/api/confirm', { token: 't1', decision: 'yes' }),
      ).resolves.toMatchObject({ status: 400 });
    });

    it('closes the desktop modal when the phone answers first', async () => {
      const windows: { closed: boolean }[] = [];
      const queue = createConfirmQueue({
        openWindow: () => {
          const win = {
            closed: false,
            isDestroyed: () => win.closed,
            close: () => {
              win.closed = true;
            },
          };
          windows.push(win);
          return win;
        },
        logo: () => '',
        newToken: () => 'real',
      });
      const h = harness({ confirms: queue });
      const decision = queue.confirmIfNeeded(
        makeCommand({ confirm: true }),
        null,
      );
      await vi.waitFor(() => expect(windows).toHaveLength(1));

      await h.post('/api/confirm', { token: 'real', decision: 'confirm' });

      await expect(decision).resolves.toBe(true);
      expect(windows[0]?.closed).toBe(true);
    });
  });

  describe('settings', () => {
    it('shows the four switches a phone may change', async () => {
      const h = harness();

      await expect(h.get('/api/settings')).resolves.toEqual({
        status: 200,
        body: {
          autostart: false,
          notifySuccess: true,
          silenceWarnings: false,
          silenceErrors: false,
        },
      });
    });

    it('saves a whitelisted change through the shared save path', async () => {
      const h = harness();

      await expect(
        h.post('/api/settings', { silenceWarnings: true }),
      ).resolves.toMatchObject({
        status: 200,
        body: { silenceWarnings: true },
      });
      expect(h.calls).toEqual(['save:{"silenceWarnings":true}']);
    });

    it('refuses anything outside the whitelist', async () => {
      const h = harness();

      await expect(
        h.post('/api/settings', { theme: 'dark' }),
      ).resolves.toMatchObject({ status: 400 });
      expect(h.calls).toEqual([]);
    });
  });

  describe('POST /api/update/apply', () => {
    it('answers 409 unless a staged update can be swapped in', async () => {
      const h = harness();

      await expect(h.post('/api/update/apply')).resolves.toEqual({
        status: 409,
        body: { error: 'not-ready' },
      });
      expect(h.calls).toEqual([]);
    });

    it('installs the staged update without a desktop dialog', async () => {
      const h = harness({
        updater: {
          canInstallStaged: () => true,
          installStagedHeadless: () =>
            Promise.resolve({ ok: true, quitting: true }),
        },
      });

      await expect(h.post('/api/update/apply')).resolves.toEqual({
        status: 202,
        body: { ok: true, restarting: true },
      });
    });

    it('relays an install that could not start', async () => {
      const h = harness({
        updater: {
          canInstallStaged: () => true,
          installStagedHeadless: () =>
            Promise.resolve({ ok: false, error: 'permission denied' }),
        },
      });

      await expect(h.post('/api/update/apply')).resolves.toEqual({
        status: 500,
        body: { error: 'permission denied' },
      });
    });
  });

  describe('POST /api/device/rename', () => {
    it("renames the caller's own device", async () => {
      const h = harness();

      await expect(
        h.post('/api/device/rename', { name: 'Móvil' }),
      ).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(h.calls).toEqual(['rename:d1:Móvil']);
    });

    it('refuses a name the device store does not accept', async () => {
      const h = harness();
      h.failRename('invalid-name');

      await expect(h.post('/api/device/rename', { name: '' })).resolves.toEqual(
        { status: 400, body: { error: 'invalid-name' } },
      );
    });

    it('answers 401 when the device vanished meanwhile', async () => {
      const h = harness();
      h.failRename('not-found');

      await expect(
        h.post('/api/device/rename', { name: 'x' }),
      ).resolves.toMatchObject({ status: 401 });
    });
  });
});
