import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { ConfigChanges } from './config-changes.js';
import type { McpEndpoint } from './mcp-control.js';
import type { McpCore } from './mcp-wiring.js';
import type { McpRuntime } from './runtime.js';
import { createSession, type Session } from './session.js';
import { createSocketEndpoint } from './socket-endpoint.js';
import { MCP_TOOLS } from './tools/catalog.js';

/**
 * The local endpoint over the real network stack and disk: a Unix socket or
 * named pipe (src/main/mcp/socket-endpoint.ts) with one MCP session per
 * assistant connection, all of them closed when the switch goes off.
 */

const OWNER_ONLY_FILE = 0o600;

const timers = {
  setTimer: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimer: (handle: unknown): void =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The real local endpoint: the socket (or pipe) and a session per assistant. */
export function localEndpoint(
  core: McpCore & { changes: ConfigChanges },
  runtime: McpRuntime,
  version: string,
): McpEndpoint {
  const firstApprovals = new Set<string>();
  const sessions = new Set<Session>();
  const endpoint = createSocketEndpoint({
    home: core.home,
    platform: process.platform,
    createServer: (onConnection) => net.createServer(onConnection),
    probe: (socketPath) =>
      new Promise((resolve) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      }),
    writeToken: (tokenPath, token) =>
      fs.writeFileSync(tokenPath, token, { mode: OWNER_ONLY_FILE }),
    removeSocket: (socketPath) => fs.rmSync(socketPath, { force: true }),
    restrictSocket: (socketPath) => fs.chmodSync(socketPath, OWNER_ONLY_FILE),
    newToken: () => randomBytes(32).toString('base64url'),
    ...timers,
    session: (transport) => {
      const session = createSession(transport, {
        ...core,
        runtime,
        tools: MCP_TOOLS,
        version,
        firstApprovals,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        setTimer: timers.setTimer,
      });
      sessions.add(session);
      session.server.server.onclose = () => {
        sessions.delete(session);
        void session.close();
      };
    },
  });
  return {
    ...endpoint,
    stop: async () => {
      // An open session would otherwise keep answering until it hangs up.
      await Promise.all([...sessions].map((session) => session.close()));
      sessions.clear();
      await endpoint.stop();
    },
  };
}
