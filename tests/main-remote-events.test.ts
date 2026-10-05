import { describe, expect, it } from 'vitest';
import { createEventHub, type EventSink } from '../src/main/remote/events.js';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  repeat: boolean;
}

interface FakeSink extends EventSink {
  chunks: string[];
  ended: boolean;
  /** Next writes report a client that cannot keep up. */
  choke(): void;
}

/**
 * Records what the hub hands over as plain SSE text: the real sink (built by
 * src/main/remote/secure-api.ts) seals each event for its own session.
 */
function sink(): FakeSink {
  let choked = false;
  const write = (chunk: string): boolean => {
    fake.chunks.push(chunk);
    return !choked;
  };
  const fake: FakeSink = {
    chunks: [],
    ended: false,
    event: (type, data) =>
      write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
    heartbeat: () => write(': heartbeat\n\n'),
    end: () => {
      fake.ended = true;
    },
    choke: () => {
      choked = true;
    },
  };
  return fake;
}

function harness(options: { perDevice?: number; total?: number } = {}) {
  const timers: FakeTimer[] = [];
  let presenceChanges = 0;
  const presenceOf: string[] = [];
  const schedule = (repeat: boolean) => (fn: () => void, ms: number) => {
    const timer = { fn, ms, cleared: false, repeat };
    timers.push(timer);
    return timer;
  };
  const clear = (handle: unknown) => {
    (handle as FakeTimer).cleared = true;
  };
  const hub = createEventHub({
    timers: {
      setTimeout: schedule(false),
      clearTimeout: clear,
      setInterval: schedule(true),
      clearInterval: clear,
    },
    onPresenceChange: (deviceId) => {
      presenceChanges += 1;
      presenceOf.push(deviceId);
    },
    ...options,
  });
  const live = () => timers.filter((timer) => !timer.cleared);
  return {
    hub,
    timers,
    presenceChanges: () => presenceChanges,
    presenceOf: () => presenceOf,
    /** Fires every live timer once (one-shots are retired). */
    fire: (ms: number) => {
      for (const timer of live().filter((t) => t.ms === ms)) {
        if (!timer.repeat) timer.cleared = true;
        timer.fn();
      }
    },
    live,
  };
}

/** The events a sink received, parsed back from the SSE frames. */
function events(fake: FakeSink): { event: string; data: unknown }[] {
  return fake.chunks
    .filter((chunk) => chunk.startsWith('event: '))
    .map((chunk) => {
      const [eventLine = '', dataLine = ''] = chunk.split('\n');
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as unknown,
      };
    });
}

describe('src/main/remote/events.ts', () => {
  describe('delivery', () => {
    it('hands each broadcast to every stream as its type and data', () => {
      const h = harness();
      const one = sink();
      const two = sink();
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, one);
      h.hub.attach({ deviceId: 'd2', sessionId: 's-d2', logsId: null }, two);

      h.hub.broadcast('notice', { title: 'a\nb' });

      for (const phone of [one, two])
        expect(events(phone)).toEqual([
          { event: 'notice', data: { title: 'a\nb' } },
        ]);
    });

    it('can leave one device out of a broadcast', () => {
      const h = harness();
      const left = sink();
      const told = sink();
      h.hub.attach({ deviceId: 'd1', sessionId: 's1', logsId: null }, left);
      h.hub.attach({ deviceId: 'd2', sessionId: 's2', logsId: null }, told);

      h.hub.broadcast('notice', { title: 'x' }, 'd1');

      expect(left.chunks).toEqual([]);
      expect(events(told)).toEqual([{ event: 'notice', data: { title: 'x' } }]);
    });

    it('sends to one stream only what is addressed to it', () => {
      const h = harness();
      const first = sink();
      const second = sink();
      const client = h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: null },
        first,
      );
      h.hub.attach({ deviceId: 'd2', sessionId: 's-d2', logsId: null }, second);

      client?.send('state', { ok: true });

      expect(events(first)).toEqual([{ event: 'state', data: { ok: true } }]);
      expect(second.chunks).toEqual([]);
    });
  });

  describe('limits', () => {
    it('caps the streams one device may hold open', () => {
      const h = harness({ perDevice: 2 });
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, sink());
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, sink());

      expect(h.hub.canAttach('d1')).toBe(false);
      expect(
        h.hub.attach(
          { deviceId: 'd1', sessionId: 's-d1', logsId: null },
          sink(),
        ),
      ).toBeNull();
      expect(h.hub.canAttach('d2')).toBe(true);
    });

    it('caps the streams of every device together', () => {
      const h = harness({ total: 2 });
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, sink());
      h.hub.attach({ deviceId: 'd2', sessionId: 's-d2', logsId: null }, sink());

      expect(h.hub.canAttach('d3')).toBe(false);
    });

    it('frees the slot of a stream that closed', () => {
      const h = harness({ perDevice: 1 });
      const client = h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: null },
        sink(),
      );

      client?.detach();

      expect(h.hub.canAttach('d1')).toBe(true);
    });

    it('drops a client that cannot keep up', () => {
      const h = harness();
      const slow = sink();
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, slow);
      slow.choke();

      h.hub.broadcast('state', {});

      expect(slow.ended).toBe(true);
      expect(h.hub.isConnected('d1')).toBe(false);
    });
  });

  describe('presence', () => {
    it('reports a device connected while it holds at least one stream', () => {
      const h = harness();
      const first = h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: null },
        sink(),
      );
      const second = h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: null },
        sink(),
      );

      expect(h.hub.isConnected('d1')).toBe(true);
      expect(h.presenceChanges()).toBe(1);
      first?.detach();
      expect(h.hub.isConnected('d1')).toBe(true);
      second?.detach();
      second?.detach();

      expect(h.hub.isConnected('d1')).toBe(false);
      expect(h.presenceChanges()).toBe(2);
      expect(h.presenceOf()).toEqual(['d1', 'd1']);
      expect(h.hub.hasClients()).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('comments every 25 s while anyone listens, and stops after', () => {
      const h = harness();
      const phone = sink();
      const client = h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: null },
        phone,
      );

      h.fire(25_000);
      expect(phone.chunks).toEqual([': heartbeat\n\n']);

      client?.detach();
      expect(h.live()).toEqual([]);
    });
  });

  describe('logs', () => {
    it('batches lines for the streams subscribed to that process only', () => {
      const h = harness();
      const watching = sink();
      const other = sink();
      h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: 'cmd:g1:web' },
        watching,
      );
      h.hub.attach(
        { deviceId: 'd2', sessionId: 's-d2', logsId: 'cmd:g1:api' },
        other,
      );

      h.hub.log('cmd:g1:web', { seq: 1, ts: 1, level: null, line: 'a' });
      h.hub.log('cmd:g1:web', { seq: 2, ts: 2, level: 'warn', line: 'b' });
      expect(watching.chunks).toEqual([]);
      h.fire(100);

      expect(events(watching)).toEqual([
        {
          event: 'log',
          data: {
            id: 'cmd:g1:web',
            lines: [
              { seq: 1, ts: 1, level: null, line: 'a' },
              { seq: 2, ts: 2, level: 'warn', line: 'b' },
            ],
          },
        },
      ]);
      expect(other.chunks).toEqual([]);
    });

    it('knows which processes some stream is watching', () => {
      const h = harness();
      const client = h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: 'cmd:g1:web' },
        sink(),
      );

      expect(h.hub.watches('cmd:g1:web')).toBe(true);
      expect(h.hub.watches('cmd:g1:api')).toBe(false);
      client?.detach();
      expect(h.hub.watches('cmd:g1:web')).toBe(false);
    });

    it('does not even buffer lines nobody is watching', () => {
      const h = harness();
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, sink());

      h.hub.log('cmd:g1:web', { seq: 1, ts: 1, level: null, line: 'a' });

      expect(h.live().filter((timer) => timer.ms === 100)).toEqual([]);
    });

    it('keeps only the newest lines of a burst', () => {
      const h = harness();
      const watching = sink();
      h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: 'cmd:g1:web' },
        watching,
      );

      for (let seq = 1; seq <= 600; seq++)
        h.hub.log('cmd:g1:web', { seq, ts: seq, level: null, line: 'x' });
      h.fire(100);

      const [batch] = events(watching);
      const lines = (batch?.data as { lines: { seq: number }[] }).lines;
      expect(lines).toHaveLength(500);
      expect(lines[0]?.seq).toBe(101);
    });
  });

  describe('subscribe', () => {
    it("moves one session's streams to another process, or to none", () => {
      const h = harness();
      const phone = sink();
      const other = sink();
      h.hub.attach({ deviceId: 'd1', sessionId: 's1', logsId: null }, phone);
      h.hub.attach({ deviceId: 'd1', sessionId: 's2', logsId: null }, other);

      h.hub.subscribe('s1', 'cmd:g1:web');
      expect(h.hub.watches('cmd:g1:web')).toBe(true);
      h.hub.log('cmd:g1:web', { seq: 1, ts: 1, level: null, line: 'a' });
      h.fire(100);
      expect(events(phone).map((e) => e.event)).toEqual(['log']);
      expect(other.chunks).toEqual([]);

      h.hub.subscribe('s1', null);
      expect(h.hub.watches('cmd:g1:web')).toBe(false);
    });
  });

  describe('closeSessions', () => {
    it('ends the streams of those sessions without saying unlinked', () => {
      const h = harness();
      const closing = sink();
      const stays = sink();
      h.hub.attach({ deviceId: 'd1', sessionId: 's1', logsId: null }, closing);
      h.hub.attach({ deviceId: 'd1', sessionId: 's2', logsId: null }, stays);

      h.hub.closeSessions(['s1', 'unknown']);

      expect(closing.ended).toBe(true);
      expect(closing.chunks).toEqual([]);
      expect(stays.ended).toBe(false);
      expect(h.hub.isConnected('d1')).toBe(true);
    });
  });

  describe('drop', () => {
    it('tells an unlinked device so, then closes its streams', () => {
      const h = harness();
      const gone = sink();
      const stays = sink();
      h.hub.attach({ deviceId: 'd1', sessionId: 's-d1', logsId: null }, gone);
      h.hub.attach({ deviceId: 'd2', sessionId: 's-d2', logsId: null }, stays);

      h.hub.drop('d1');

      expect(events(gone)).toEqual([{ event: 'unlinked', data: {} }]);
      expect(gone.ended).toBe(true);
      expect(stays.ended).toBe(false);
      expect(h.hub.isConnected('d1')).toBe(false);
    });
  });

  describe('closeAll', () => {
    it('ends every stream and every timer', () => {
      const h = harness();
      const phone = sink();
      h.hub.attach(
        { deviceId: 'd1', sessionId: 's-d1', logsId: 'cmd:g1:web' },
        phone,
      );
      h.hub.log('cmd:g1:web', { seq: 1, ts: 1, level: null, line: 'a' });

      h.hub.attach({ deviceId: 'd2', sessionId: 's-d2', logsId: null }, sink());
      h.hub.closeAll();

      expect(phone.ended).toBe(true);
      expect(h.presenceOf().slice(-2)).toEqual(['d1', 'd2']);
      expect(h.live()).toEqual([]);
      expect(h.hub.hasClients()).toBe(false);
    });
  });
});
