import { describe, expect, it } from 'vitest';
import { createLive, type RemoteRuntime } from '../src/main/remote/live.js';
import type { EventSink } from '../src/main/remote/events.js';
import type { GroupState, PipelineState } from '../src/ipc-contract.js';
import type { RemoteConfirmView } from '../src/ipc-contract/remote-wire.js';
import type { UpdateStatus } from '../src/ipc-contract/updates-api.js';
import type { LogEntry } from '../src/domain-types.js';
import type { RemoteDeviceView } from '../src/ipc-contract/remote-api.js';
import type { ApiRequest } from '../src/main/remote/api.js';
import { makeCommand, makeGroup } from './helpers/main-fakes.js';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  repeat: boolean;
}

const DEVICE: RemoteDeviceView = {
  id: 'd1',
  name: 'iPhone',
  client: 'Safari · iOS',
  createdAt: 1,
  lastSeenAt: 1,
};

const PIPELINE: PipelineState = {
  status: 'idle',
  currentStep: null,
  totalSteps: 0,
  lastError: null,
  lastRunId: null,
  startedAt: null,
};

function groupState(id: string): GroupState {
  return {
    groupId: id,
    group: makeGroup({ id, name: id, commands: [makeCommand({ id: 'web' })] }),
    currentBranch: null,
    color: 'stopped',
    lastError: null,
    commands: [],
    actions: [],
  };
}

function sink() {
  const chunks: string[] = [];
  let ended = false;
  const fake: EventSink = {
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
  };
  return {
    fake,
    ended: () => ended,
    events: () =>
      chunks
        .filter((chunk) => chunk.startsWith('event: '))
        .map((chunk) => {
          const [head = '', data = ''] = chunk.split('\n');
          return {
            event: head.slice('event: '.length),
            data: JSON.parse(data.slice('data: '.length)) as unknown,
          };
        }),
  };
}

function harness() {
  let clock = 1_000;
  const timers: FakeTimer[] = [];
  let bus: ((channel: string, payload: unknown) => void) | null = null;
  let onLog: ((payload: { id: string; entry: LogEntry }) => void) | null = null;
  let confirmListener: (() => void) | null = null;
  let confirms: RemoteConfirmView[] = [];
  let groups = [groupState('g1')];
  const branches = new Map<string, string>([['g1', 'main']]);
  let branchReads = 0;
  let presence = 0;
  let update: UpdateStatus = {
    available: null,
    staged: null,
    lastCheckAt: null,
    currentVersion: '0.11.0',
    phase: { state: 'idle' },
  };
  const schedule = (repeat: boolean) => (fn: () => void, ms: number) => {
    const timer = { fn, ms, cleared: false, repeat };
    timers.push(timer);
    return timer;
  };
  const runtime: RemoteRuntime = {
    groupStates: () => groups,
    pipelineState: () => PIPELINE,
    currentBranch: (groupId) => {
      branchReads += 1;
      return Promise.resolve({ ok: true, branch: branches.get(groupId) });
    },
    onLog: (listener) => {
      onLog = listener;
    },
    confirms: {
      pending: () => confirms,
      onChange: (listener) => {
        confirmListener = listener;
        return () => undefined;
      },
    },
    updater: {
      status: () => update,
      canInstallStaged: () => false,
    },
    onBus: (listener) => {
      bus = listener;
    },
  };
  const live = createLive({
    runtime,
    hostInfo: () => ({ name: 'mac-de-ana', version: '0.11.0' }),
    now: () => clock,
    timers: {
      setTimeout: schedule(false),
      clearTimeout: (handle) => {
        (handle as FakeTimer).cleared = true;
      },
      setInterval: schedule(true),
      clearInterval: (handle) => {
        (handle as FakeTimer).cleared = true;
      },
    },
    onPresenceChange: () => {
      presence += 1;
    },
  });
  const request = (query = ''): ApiRequest => ({
    method: 'GET',
    pathname: '/api/events',
    query: new URLSearchParams(query),
    token: 'x',
    ip: '192.168.1.40',
    userAgent: undefined,
    body: null,
  });
  /** Opens a stream the way the server does, and returns its sink. */
  const open = (query = '') => {
    const phone = sink();
    const answer = live.stream(request(query), DEVICE);
    if (!('open' in answer)) throw new Error(`refused: ${answer.status}`);
    const detach = answer.open(phone.fake);
    return { ...phone, detach };
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    live,
    open,
    request,
    settle,
    branches,
    emit: (channel: string, payload: unknown = null) => bus?.(channel, payload),
    log: (id: string, entry: LogEntry) => onLog?.({ id, entry }),
    setConfirms: (next: RemoteConfirmView[]) => {
      confirms = next;
      confirmListener?.();
    },
    setGroups: (next: GroupState[]) => {
      groups = next;
    },
    setUpdate: (next: UpdateStatus) => {
      update = next;
    },
    branchReads: () => branchReads,
    presence: () => presence,
    advance: (ms: number) => {
      clock += ms;
    },
    fire: (ms: number) => {
      for (const timer of timers.filter((t) => !t.cleared && t.ms === ms)) {
        if (!timer.repeat) timer.cleared = true;
        timer.fn();
      }
    },
    liveTimers: () => timers.filter((timer) => !timer.cleared),
  };
}

describe('src/main/remote/live.ts', () => {
  describe('state', () => {
    it('reads the branches it does not know yet, then answers the view', async () => {
      const h = harness();

      const state = await h.live.state();

      expect(state).toMatchObject({
        now: 1_000,
        host: { name: 'mac-de-ana', version: '0.11.0' },
        groups: [{ id: 'g1', branch: 'main' }],
        pipeline: { status: 'idle' },
        update: { state: 'current' },
        confirms: [],
      });
      await h.live.state();
      expect(h.branchReads()).toBe(1);
    });

    it('has no branch for a group that is not a repository', async () => {
      const h = harness();
      h.branches.clear();

      expect((await h.live.state()).groups[0]?.branch).toBeNull();
    });
  });

  describe('stream', () => {
    it('opens with the whole state and freshens the branches', async () => {
      const h = harness();

      const phone = h.open();
      await h.settle();

      expect(phone.events()[0]).toMatchObject({
        event: 'state',
        data: { host: { name: 'mac-de-ana' } },
      });
      expect(h.branchReads()).toBe(1);
      expect(h.presence()).toBe(1);
    });

    it('refuses a fourth stream from the same device', () => {
      const h = harness();
      h.open();
      h.open();
      h.open();

      expect(h.live.stream(h.request(), DEVICE)).toEqual({
        status: 429,
        body: { error: 'too-many-streams' },
      });
    });

    it('refuses a malformed log subscription', () => {
      const h = harness();

      expect(h.live.stream(h.request('logs='), DEVICE)).toEqual({
        status: 400,
        body: { error: 'invalid-request' },
      });
    });
  });

  describe('state pushes', () => {
    it('pushes at most one state per 250 ms, however many changes', async () => {
      const h = harness();
      const phone = h.open();
      await h.settle();
      const before = phone.events().length;

      h.emit('groups:update');
      h.emit('pipeline:update');
      h.emit('groups:update');
      h.fire(250);

      expect(
        phone
          .events()
          .slice(before)
          .map((e) => e.event),
      ).toEqual(['state']);
    });

    it('schedules nothing while no phone is listening', () => {
      const h = harness();

      h.emit('groups:update');

      expect(h.liveTimers()).toEqual([]);
    });

    it('re-reads the branches when a repository changes', async () => {
      const h = harness();
      const phone = h.open();
      await h.settle();
      h.fire(250);
      h.branches.set('g1', 'feat/x');

      h.emit('branches:changed', { path: '/repo' });
      await h.settle();
      h.fire(250);

      const states = phone.events().filter((e) => e.event === 'state');
      expect(states.at(-1)).toMatchObject({
        data: { groups: [{ branch: 'feat/x' }] },
      });
    });

    it('reads the branch of a group that just appeared', async () => {
      const h = harness();
      h.open();
      await h.settle();
      h.setGroups([groupState('g1'), groupState('g2')]);

      h.emit('groups:update');
      await h.settle();

      expect(h.branchReads()).toBe(2);
    });

    it('refreshes one group after a switch from the phone', async () => {
      const h = harness();
      await h.live.state();

      h.live.branchSwitched('g1');
      await h.settle();

      expect(h.branchReads()).toBe(2);
    });
  });

  describe('notices', () => {
    it('logs a toast and tells every phone', () => {
      const h = harness();
      const phone = h.open();

      h.emit('groups:toast', {
        kind: 'error',
        message: 'Backend · API exited 1',
      });

      expect(h.live.notices()[0]).toMatchObject({
        kind: 'error',
        title: 'Backend · API exited 1',
      });
      expect(phone.events().at(-1)).toMatchObject({
        event: 'notice',
        data: { kind: 'error' },
      });
    });

    it('ignores a toast it cannot read', () => {
      const h = harness();

      h.emit('groups:toast', 'nonsense');

      expect(h.live.notices()).toEqual([]);
    });

    it('logs a banner handed over by the notifications', () => {
      const h = harness();

      h.live.notice({
        title: 'DevBar — acción programada',
        body: 'Backend · Backup: completada',
        action: null,
      });

      expect(h.live.notices()[0]).toMatchObject({ kind: 'scheduled' });
    });
  });

  describe('confirmations', () => {
    it('pushes the pending list as soon as it changes', () => {
      const h = harness();
      const phone = h.open();
      const pending: RemoteConfirmView = {
        token: 't1',
        name: 'migrate',
        command: 'pnpm db:migrate',
        groupName: 'Backend',
        secs: 42,
        onTimeout: 'cancel',
        deadline: 43_000,
      };

      h.setConfirms([pending]);

      expect(phone.events().at(-1)).toEqual({
        event: 'confirm',
        data: { now: 1_000, confirms: [pending] },
      });
    });
  });

  describe('updates', () => {
    it('pushes the update summary, debounced like the state', () => {
      const h = harness();
      const phone = h.open();
      h.setUpdate({
        available: null,
        staged: null,
        lastCheckAt: null,
        currentVersion: '0.11.0',
        phase: { state: 'restarting', version: '0.12.0' },
      });

      h.emit('updates:phase');
      h.emit('updates:status');
      h.fire(250);

      const updates = phone.events().filter((e) => e.event === 'update');
      expect(updates).toEqual([
        {
          event: 'update',
          data: {
            currentVersion: '0.11.0',
            state: 'restarting',
            version: '0.12.0',
          },
        },
      ]);
    });
  });

  describe('logs', () => {
    it('relays the lines of the process a stream subscribed to', () => {
      const h = harness();
      const phone = h.open('logs=cmd:g1:web');

      h.log('cmd:g1:web', {
        ts: 5,
        seq: 7,
        stream: 'stdout',
        level: 'warn',
        line: '\u001b[33mcareful\u001b[0m',
      });
      h.log('cmd:g1:api', {
        ts: 5,
        seq: 1,
        stream: 'stdout',
        level: null,
        line: 'x',
      });
      h.fire(100);

      expect(phone.events().filter((e) => e.event === 'log')).toEqual([
        {
          event: 'log',
          data: {
            id: 'cmd:g1:web',
            lines: [{ seq: 7, ts: 5, level: 'warn', line: 'careful' }],
          },
        },
      ]);
    });
  });

  describe('close', () => {
    it('ends every stream and cancels pending pushes', () => {
      const h = harness();
      const phone = h.open();
      h.emit('groups:update');

      h.live.close();

      expect(phone.ended()).toBe(true);
      expect(h.liveTimers()).toEqual([]);
    });
  });
});
