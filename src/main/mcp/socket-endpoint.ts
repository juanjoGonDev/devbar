import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { mcpSocketPath, mcpTokenPath, parseHello } from '../../mcp/endpoint.js';
import type { McpEndpoint } from './mcp-control.js';
import { SocketTransport } from './socket-transport.js';

/**
 * The local endpoint assistants reach DevBar through: a Unix socket (macOS,
 * Linux) or a named pipe (Windows) that the stdio bridge connects to. Two
 * locks keep other users out — the socket sits in a folder only this user
 * can open, and every connection must first present the token written next
 * to it (regenerated on every start), compared in constant time. A
 * connection that does not, within a few seconds, is dropped before a single
 * MCP message is read.
 */

export interface ListeningServer {
  listen(path: string, onListening: () => void): void;
  close(onClosed: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export interface SocketEndpointDeps {
  home: string;
  platform: NodeJS.Platform;
  createServer(onConnection: (socket: Duplex) => void): ListeningServer;
  /** Whether something already answers on that path (another instance). */
  probe(path: string): Promise<boolean>;
  writeToken(path: string, token: string): void;
  /** Removes a stale socket file; a no-op when there is none. */
  removeSocket(path: string): void;
  /** Tightens the socket file to its owner (POSIX). */
  restrictSocket(path: string): void;
  newToken(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** An authenticated connection, ready for an MCP server. */
  session(transport: SocketTransport): void;
}

/** How long a connection may take to present the token. */
export const HELLO_TIMEOUT_MS = 5000;
const MAX_HELLO_BYTES = 4096;

function sameToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSocketEndpoint(deps: SocketEndpointDeps): McpEndpoint {
  const socketPath = mcpSocketPath(deps.home, deps.platform);
  const tokenPath = mcpTokenPath(deps.home, deps.platform);
  const sockets = new Set<Duplex>();
  let server: ListeningServer | null = null;
  let token = '';

  const accept = (socket: Duplex): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let received = Buffer.alloc(0);
    const timer = deps.setTimer(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf('\n');
      if (newline === -1) {
        if (received.length > MAX_HELLO_BYTES) {
          deps.clearTimer(timer);
          socket.destroy();
        }
        return;
      }
      socket.off('data', onData);
      socket.pause();
      deps.clearTimer(timer);
      const given = parseHello(received.subarray(0, newline).toString('utf8'));
      if (given === null || !sameToken(token, given)) {
        socket.destroy();
        return;
      }
      const rest = received.subarray(newline + 1);
      if (rest.length > 0) socket.unshift(rest);
      deps.session(new SocketTransport(socket));
    };
    socket.on('data', onData);
  };

  return {
    start: async () => {
      if (server) return;
      if (deps.platform !== 'win32') {
        if (await deps.probe(socketPath))
          throw new Error('otra copia de DevBar ya lo tiene abierto');
        deps.removeSocket(socketPath);
      }
      token = deps.newToken();
      deps.writeToken(tokenPath, token);
      const candidate = deps.createServer(accept);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        candidate.on('error', onError);
        candidate.listen(socketPath, () => {
          candidate.off('error', onError);
          resolve();
        });
      });
      if (deps.platform !== 'win32') deps.restrictSocket(socketPath);
      server = candidate;
    },
    stop: async () => {
      const current = server;
      server = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!current) return;
      await new Promise<void>((resolve) => current.close(() => resolve()));
      if (deps.platform !== 'win32') deps.removeSocket(socketPath);
    },
    listening: () => server !== null,
  };
}
