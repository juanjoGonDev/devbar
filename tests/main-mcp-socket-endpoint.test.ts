import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  createSocketEndpoint,
  HELLO_TIMEOUT_MS,
  type ListeningServer,
} from '../src/main/mcp/socket-endpoint.js';
import type { SocketTransport } from '../src/main/mcp/socket-transport.js';
import { helloLine } from '../src/mcp/endpoint.js';
import { duplexPair, tick } from './helpers/duplex-pair.js';

function harness(
  options: {
    platform?: NodeJS.Platform;
    busy?: boolean;
    failListen?: Error;
  } = {},
) {
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const sessions: SocketTransport[] = [];
  let onConnection: ((socket: Duplex) => void) | null = null;
  let errorListener: ((error: Error) => void) | null = null;
  const server: ListeningServer = {
    listen: (path, onListening) => {
      calls.push(`listen:${path}`);
      if (options.failListen) errorListener?.(options.failListen);
      else onListening();
    },
    close: (onClosed) => {
      calls.push('close');
      onClosed();
    },
    on: (_event, listener) => {
      errorListener = listener;
    },
    off: () => {
      errorListener = null;
    },
  };
  const endpoint = createSocketEndpoint({
    home: '/home/ana/mcp',
    platform: options.platform ?? 'darwin',
    createServer: (handler) => {
      onConnection = handler;
      return server;
    },
    probe: (path) => {
      calls.push(`probe:${path}`);
      return Promise.resolve(options.busy ?? false);
    },
    writeToken: (path, token) => calls.push(`token:${path}:${token}`),
    removeSocket: (path) => calls.push(`remove:${path}`),
    restrictSocket: (path) => calls.push(`restrict:${path}`),
    newToken: () => 'secret-token',
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    session: (transport) => sessions.push(transport),
  });
  const connect = (): Duplex => {
    const [serverSide, clientSide] = duplexPair();
    if (!onConnection) throw new Error('not listening');
    onConnection(serverSide);
    return clientSide;
  };
  return { endpoint, calls, timers, sessions, connect };
}

const PING: JSONRPCMessage = { jsonrpc: '2.0', id: 7, method: 'ping' };

describe('src/main/mcp/socket-endpoint.ts', () => {
  it('replaces a stale socket, writes a fresh token and listens owner-only', async () => {
    const h = harness();

    await h.endpoint.start();

    expect(h.calls).toEqual([
      'probe:/home/ana/mcp/devbar.sock',
      'remove:/home/ana/mcp/devbar.sock',
      'token:/home/ana/mcp/token:secret-token',
      'listen:/home/ana/mcp/devbar.sock',
      'restrict:/home/ana/mcp/devbar.sock',
    ]);
    expect(h.endpoint.listening()).toBe(true);
  });

  it('refuses to take over a socket another instance answers on', async () => {
    const h = harness({ busy: true });

    await expect(h.endpoint.start()).rejects.toThrow(
      'otra copia de DevBar ya lo tiene abierto',
    );
    expect(h.endpoint.listening()).toBe(false);
  });

  it('reports a listen failure', async () => {
    const h = harness({ failListen: new Error('EACCES') });

    await expect(h.endpoint.start()).rejects.toThrow('EACCES');
    expect(h.endpoint.listening()).toBe(false);
  });

  it('touches no socket file for a Windows named pipe', async () => {
    const h = harness({ platform: 'win32' });

    await h.endpoint.start();
    await h.endpoint.stop();

    expect(h.calls.filter((c) => /probe|remove|restrict/.test(c))).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('listen:\\\\.\\pipe\\'))).toBe(
      true,
    );
  });

  it('hands an authenticated connection to a session, bytes after the hello included', async () => {
    const h = harness();
    await h.endpoint.start();
    const socket = h.connect();

    socket.write(helloLine('secret-token') + JSON.stringify(PING) + '\n');
    await tick();

    expect(h.sessions).toHaveLength(1);
    const messages: JSONRPCMessage[] = [];
    const transport = h.sessions[0];
    if (!transport) throw new Error('no session');
    transport.onmessage = (message) => messages.push(message);
    await transport.start();
    await tick();
    expect(messages).toEqual([PING]);
    expect(h.timers[0]?.cleared).toBe(true);
  });

  it.each([
    ['a wrong token', helloLine('guess')],
    ['no hello at all', JSON.stringify(PING) + '\n'],
  ])('drops a connection with %s', async (_label, first) => {
    const h = harness();
    await h.endpoint.start();
    const socket = h.connect();
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });

    socket.write(first);
    await tick();
    await tick();

    expect(h.sessions).toEqual([]);
    expect(closed).toBe(true);
  });

  it('drops a connection that never says hello in time', async () => {
    const h = harness();
    await h.endpoint.start();
    const socket = h.connect();
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });

    expect(h.timers[0]?.ms).toBe(HELLO_TIMEOUT_MS);
    h.timers[0]?.fn();
    await tick();

    expect(closed).toBe(true);
  });

  it('drops a connection that sends a huge first line', async () => {
    const h = harness();
    await h.endpoint.start();
    const socket = h.connect();
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });

    socket.write('x'.repeat(5000));
    await tick();
    await tick();

    expect(closed).toBe(true);
  });

  it('hangs up every connection, closes and removes the socket on stop', async () => {
    const h = harness();
    await h.endpoint.start();
    const socket = h.connect();
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });

    await h.endpoint.stop();
    await tick();

    expect(closed).toBe(true);
    expect(h.calls.slice(-2)).toEqual([
      'close',
      'remove:/home/ana/mcp/devbar.sock',
    ]);
    expect(h.endpoint.listening()).toBe(false);
  });

  it('is a no-op to start twice or stop when stopped', async () => {
    const h = harness();
    await h.endpoint.stop();
    await h.endpoint.start();
    await h.endpoint.start();

    expect(h.calls.filter((c) => c.startsWith('listen'))).toHaveLength(1);
  });
});
