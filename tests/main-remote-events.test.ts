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

function sink(): FakeSink {
  let choked = false;
  const fake: FakeSink = {
    chunks: [],
    ended: false,
    write: (chunk) => {
      fake.chunks.push(chunk);
      return !choked;
    },
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
  describe('framing', () => {
    it('writes each event as one SSE frame with a JSON line', () => {
      const h = harness();
      const phone = sink();
      h.hub.attach('d1', null, phone);

      h.hub.broadcast('notice', { title: 'a\nb' });

      expect(phone.chunks).toEqual([
        'event: notice\ndata: {"title":"a\\nb"}\n\n',
      ]);
    });

    it('sends to one stream only what is addressed to it', () => {
      const h = harness();
      const first = sink();
      const second = sink();
      const client = h.hub.attach('d1', null, first);
      h.hub.attach('d2', null, second);

      client?.send('state', { ok: true });

      expect(events(first)).toEqual([{ event: 'state', data: { ok: true } }]);
      expect(second.chunks).toEqual([]);
    });
  });

  describe('limits', () => {
    it('caps the streams one device may hold open', () => {
      const h = harness({ perDevice: 2 });
      h.hub.attach('d1', null, sink());
      h.hub.attach('d1', null, sink());

      expect(h.hub.canAttach('d1')).toBe(false);
      expect(h.hub.attach('d1', null, sink())).toBeNull();
      expect(h.hub.canAttach('d2')).toBe(true);
    });

    it('caps the streams of every device together', () => {
      const h = harness({ total: 2 });
      h.hub.attach('d1', null, sink());
      h.hub.attach('d2', null, sink());

      expect(h.hub.canAttach('d3')).toBe(false);
    });

    it('frees the slot of a stream that closed', () => {
      const h = harness({ perDevice: 1 });
      const client = h.hub.attach('d1', null, sink());

      client?.detach();

      expect(h.hub.canAttach('d1')).toBe(true);
    });

    it('drops a client that cannot keep up', () => {
      const h = harness();
      const slow = sink();
      h.hub.attach('d1', null, slow);
      slow.choke();

      h.hub.broadcast('state', {});

      expect(slow.ended).toBe(true);
      expect(h.hub.isConnected('d1')).toBe(false);
    });
  });

  describe('presence', () => {
    it('reports a device connected while it holds at least one stream', () => {
      const h = harness();
      const first = h.hub.attach('d1', null, sink());
      const second = h.hub.attach('d1', null, sink());

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
      const client = h.hub.attach('d1', null, phone);

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
      h.hub.attach('d1', 'cmd:g1:web', watching);
      h.hub.attach('d2', 'cmd:g1:api', other);

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
      const client = h.hub.attach('d1', 'cmd:g1:web', sink());

      expect(h.hub.watches('cmd:g1:web')).toBe(true);
      expect(h.hub.watches('cmd:g1:api')).toBe(false);
      client?.detach();
      expect(h.hub.watches('cmd:g1:web')).toBe(false);
    });

    it('does not even buffer lines nobody is watching', () => {
      const h = harness();
      h.hub.attach('d1', null, sink());

      h.hub.log('cmd:g1:web', { seq: 1, ts: 1, level: null, line: 'a' });

      expect(h.live().filter((timer) => timer.ms === 100)).toEqual([]);
    });

    it('keeps only the newest lines of a burst', () => {
      const h = harness();
      const watching = sink();
      h.hub.attach('d1', 'cmd:g1:web', watching);

      for (let seq = 1; seq <= 600; seq++)
        h.hub.log('cmd:g1:web', { seq, ts: seq, level: null, line: 'x' });
      h.fire(100);

      const [batch] = events(watching);
      const lines = (batch?.data as { lines: { seq: number }[] }).lines;
      expect(lines).toHaveLength(500);
      expect(lines[0]?.seq).toBe(101);
    });
  });

  describe('drop', () => {
    it('tells an unlinked device so, then closes its streams', () => {
      const h = harness();
      const gone = sink();
      const stays = sink();
      h.hub.attach('d1', null, gone);
      h.hub.attach('d2', null, stays);

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
      h.hub.attach('d1', 'cmd:g1:web', phone);
      h.hub.log('cmd:g1:web', { seq: 1, ts: 1, level: null, line: 'a' });

      h.hub.attach('d2', null, sink());
      h.hub.closeAll();

      expect(phone.ended).toBe(true);
      expect(h.presenceOf().slice(-2)).toEqual(['d1', 'd2']);
      expect(h.live()).toEqual([]);
      expect(h.hub.hasClients()).toBe(false);
    });
  });
});
