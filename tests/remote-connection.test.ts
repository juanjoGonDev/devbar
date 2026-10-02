import { describe, expect, it } from 'vitest';
import {
  createConnection,
  type ConnectionDeps,
  type EventSourceLike,
} from '../renderer/remote/connection.js';

/**
 * The phone's /api/events connection: one EventSource at a time, its
 * events handed on parsed, and reconnection with a growing back-off that
 * first asks the server whether this device is still linked — and whether
 * DevBar came back as a newer version, which needs a fresh page.
 */

interface FakeSource extends EventSourceLike {
  url: string;
  closed: boolean;
  emit(type: string, data?: unknown): void;
}

function harness(
  check: ConnectionDeps['check'] = () => Promise.resolve('linked'),
) {
  const sources: FakeSource[] = [];
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
    check,
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
  return {
    connection,
    sources,
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
  it('opens the stream, with the process whose logs it wants', () => {
    const h = harness();

    h.connection.watch(null);
    h.connection.watch('cmd:g1:web');

    expect(h.sources.map((s) => s.url)).toEqual([
      '/api/events',
      '/api/events?logs=cmd%3Ag1%3Aweb',
    ]);
    expect(h.sources[0]?.closed).toBe(true);
  });

  it('keeps the stream it has when nothing changes', () => {
    const h = harness();

    h.connection.watch('x');
    h.connection.watch('x');

    expect(h.sources).toHaveLength(1);
  });

  it('hands each event on, parsed, and skips one that is not JSON', () => {
    const h = harness();
    h.connection.watch(null);
    const [source] = h.sources;

    source?.emit('open');
    source?.emit('state', '{"now":1}');
    source?.emit('notice', 'not json');
    source?.emit('log', '{"id":"x","lines":[]}');

    expect(h.statuses).toEqual(['live']);
    expect(h.events).toEqual([
      ['state', { now: 1 }],
      ['log', { id: 'x', lines: [] }],
    ]);
  });

  it('reconnects with a growing back-off while DevBar is unreachable', async () => {
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
    expect(h.sources[1]?.url).toBe('/api/events?logs=x');
    h.sources[1]?.emit('open');
    h.sources[1]?.emit('error');
    expect(await h.retry()).toBe(1000);
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

    h.sources[0]?.emit('unlinked', '{}');

    expect(h.sources[0]?.closed).toBe(true);
    expect(h.unlinked()).toBe(1);
    expect(h.timers).toEqual([]);
  });

  it('closes the stream and any pending retry', () => {
    const h = harness();
    h.connection.watch(null);
    h.sources[0]?.emit('error');

    h.connection.close();

    expect(h.timers.every((t) => t.cleared)).toBe(true);
    h.connection.watch(null);
    expect(h.sources).toHaveLength(2);
  });

  it('ignores the late events of a stream it already replaced', () => {
    const h = harness();
    h.connection.watch('a');
    h.connection.watch('b');

    h.sources[0]?.emit('error');
    h.sources[0]?.emit('state', '{}');

    expect(h.statuses).toEqual([]);
    expect(h.events).toEqual([]);
  });
});
