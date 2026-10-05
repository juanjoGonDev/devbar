import { describe, expect, it } from 'vitest';
import {
  createConnection,
  type ConnectionDeps,
  type EventSourceLike,
} from '../renderer/remote/connection.js';

/**
 * The phone's /api/events connection: one EventSource at a time on the
 * current session, its sealed `m` events opened by that session's reader,
 * the log subscription as a call, and reconnection with a growing back-off
 * that first shakes hands again and asks whether this device is still linked
 * — and whether DevBar came back as a newer version, which needs a fresh
 * page. The reader here is plain JSON: the sealing itself is
 * tests/main-remote-secure-api.test.ts and tests/remote-rc-e2e.test.ts.
 */

interface FakeSource extends EventSourceLike {
  url: string;
  closed: boolean;
  emit(type: string, data?: unknown): void;
}

function harness(
  verdict: ConnectionDeps['check'] = () => Promise.resolve('linked'),
) {
  const sources: FakeSource[] = [];
  const subscriptions: [string, string | null][] = [];
  /** One session per handshake: `check` makes a new one. */
  let session: number | null = 1;
  let sessions = 1;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const events: [string, unknown][] = [];
  const statuses: string[] = [];
  let unlinked = 0;
  let reloads = 0;
  const connection = createConnection({
    openEvents: (url) => {
      const listeners = new Map<
        string,
        ((event: { data?: unknown }) => void)[]
      >();
      const source: FakeSource = {
        url,
        closed: false,
        addEventListener: (type, listener) =>
          listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        close: () => {
          source.closed = true;
        },
        emit: (type, data) => {
          for (const listener of listeners.get(type) ?? [])
            listener(data === undefined ? {} : { data });
        },
      };
      sources.push(source);
      return source;
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    events: () =>
      session === null
        ? null
        : {
            url: `/api/events?sid=s${session}`,
            read: (data) => {
              try {
                return JSON.parse(String(data)) as {
                  type: string;
                  data: unknown;
                };
              } catch {
                return null;
              }
            },
          },
    check: async () => {
      const answer = await verdict();
      sessions += 1;
      session = sessions;
      return answer;
    },
    subscribe: (logsId) => {
      subscriptions.push([`s${session}`, logsId]);
      return Promise.resolve();
    },
    onEvent: (name, data) => events.push([name, data]),
    onStatus: (status) => statuses.push(status),
    onUnlinked: () => {
      unlinked += 1;
    },
    reload: () => {
      reloads += 1;
    },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  /** A sealed event, as the fake reader expects it. */
  const message = (type: string, data: unknown = {}) =>
    JSON.stringify({ type, data });
  return {
    connection,
    sources,
    subscriptions,
    message,
    noSession: () => {
      session = null;
    },
    timers,
    events,
    statuses,
    settle,
    unlinked: () => unlinked,
    reloads: () => reloads,
    /** Runs the next pending timer and lets its check settle. */
    retry: async () => {
      const timer = timers.find((t) => !t.cleared);
      if (!timer) throw new Error('no retry scheduled');
      timer.cleared = true;
      timer.fn();
      await settle();
      return timer.ms;
    },
  };
}

describe('renderer/remote/connection.ts', () => {
  it("opens the current session's stream, and subscribes logs by call", () => {
    const h = harness();

    h.connection.watch(null);
    h.connection.watch('cmd:g1:web');
    h.connection.watch('cmd:g1:web');
    h.connection.watch(null);

    expect(h.sources.map((s) => s.url)).toEqual(['/api/events?sid=s1']);
    expect(h.sources[0]?.closed).toBe(false);
    expect(h.subscriptions).toEqual([
      ['s1', 'cmd:g1:web'],
      ['s1', null],
    ]);
  });

  it('subscribes before opening when it starts on a process', () => {
    const h = harness();

    h.connection.watch('x');

    expect(h.subscriptions).toEqual([['s1', 'x']]);
    expect(h.sources).toHaveLength(1);
  });

  it('hands each opened event on, and skips one its reader refuses', () => {
    const h = harness();
    h.connection.watch(null);
    const [source] = h.sources;

    source?.emit('open');
    source?.emit('m', h.message('state', { now: 1 }));
    source?.emit('m', 'forged');
    source?.emit('m', h.message('log', { id: 'x', lines: [] }));
    source?.emit('m', h.message('surprise'));

    expect(h.statuses).toEqual(['live']);
    expect(h.events).toEqual([
      ['state', { now: 1 }],
      ['log', { id: 'x', lines: [] }],
    ]);
  });

  it('reconnects on a new session with a growing back-off while DevBar is unreachable', async () => {
    let reachable = false;
    const h = harness(() =>
      reachable ? Promise.resolve('linked') : Promise.reject(new Error('down')),
    );
    h.connection.watch('x');

    h.sources[0]?.emit('error');
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.statuses).toEqual(['down']);
    expect(await h.retry()).toBe(1000);
    expect(await h.retry()).toBe(2000);
    reachable = true;
    expect(await h.retry()).toBe(4000);

    expect(h.sources).toHaveLength(2);
    expect(h.sources[1]?.url).toMatch(/^\/api\/events\?sid=s\d+$/);
    expect(h.sources[1]?.url).not.toBe(h.sources[0]?.url);
    // The new session is subscribed again to what the page was showing.
    expect(h.subscriptions.at(-1)).toEqual([
      h.sources[1]?.url.split('=')[1],
      'x',
    ]);
    h.sources[1]?.emit('open');
    h.sources[1]?.emit('error');
    expect(await h.retry()).toBe(1000);
  });

  it('retries instead of opening when there is no session yet', async () => {
    const h = harness();
    h.noSession();

    h.connection.watch(null);

    expect(h.sources).toEqual([]);
    expect(h.statuses).toEqual(['down']);
    await h.retry();
    expect(h.sources).toHaveLength(1);
  });

  it('caps the back-off', async () => {
    const h = harness(() => Promise.reject(new Error('down')));
    h.connection.watch(null);
    h.sources[0]?.emit('error');

    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(await h.retry());

    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('gives up and says so when the device was unlinked meanwhile', async () => {
    const h = harness(() => Promise.resolve('unlinked'));
    h.connection.watch(null);
    h.sources[0]?.emit('error');

    await h.retry();

    expect(h.unlinked()).toBe(1);
    expect(h.sources).toHaveLength(1);
  });

  it('does nothing more once trust is lost: the app took over', async () => {
    const h = harness(() => Promise.resolve('lost'));
    h.connection.watch(null);
    h.sources[0]?.emit('error');

    await h.retry();

    expect([h.unlinked(), h.reloads(), h.sources.length]).toEqual([0, 0, 1]);
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);
  });

  it('reloads the page when DevBar came back as another version', async () => {
    const h = harness(() => Promise.resolve('reload'));
    h.connection.watch(null);
    h.sources[0]?.emit('error');

    await h.retry();

    expect(h.reloads()).toBe(1);
  });

  it('stops for good on an unlinked event', () => {
    const h = harness();
    h.connection.watch(null);

    h.sources[0]?.emit('m', h.message('unlinked'));

    expect(h.sources[0]?.closed).toBe(true);
    expect(h.unlinked()).toBe(1);
    expect(h.timers).toEqual([]);
  });

  it('closes the stream and any pending retry, and ignores a late answer', async () => {
    let answer: (verdict: 'linked') => void = () => undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    h.connection.watch(null);
    h.sources[0]?.emit('error');
    const pending = h.timers.find((t) => !t.cleared);
    pending?.fn();

    h.connection.close();
    answer('linked');
    await h.settle();

    expect(h.timers.every((t) => t.cleared || t === pending)).toBe(true);
    expect(h.sources).toHaveLength(1);
    h.connection.watch(null);
    expect(h.sources).toHaveLength(2);
  });

  it('ignores the late events of a stream it already replaced', async () => {
    const h = harness();
    h.connection.watch('a');
    const first = h.sources[0];
    first?.emit('error');
    await h.retry();

    first?.emit('error');
    first?.emit('m', h.message('state'));

    expect(h.statuses).toEqual(['down']);
    expect(h.events).toEqual([]);
  });
});
