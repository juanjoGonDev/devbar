import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

vi.mock('electron', () => {
  const app = { isPackaged: false, getPath: () => os.tmpdir() };
  return { app, default: { app } };
});

import { createAuditLog } from '../src/main/mcp/audit-log.js';
import { createClientStore } from '../src/main/mcp/client-store.js';
import { createConfirmDesk } from '../src/main/mcp/confirm-desk.js';
import { createConfigChanges } from '../src/main/mcp/config-changes.js';
import { localEndpoint } from '../src/main/mcp/local-endpoint.js';
import { SocketTransport } from '../src/main/mcp/socket-transport.js';
import { helloLine, mcpSocketPath, mcpTokenPath } from '../src/mcp/endpoint.js';
import { fakeConfigPort, fakeRuntime } from './helpers/mcp-fakes.js';

/**
 * The whole local path on a real Unix socket in a temp folder (no network):
 * the endpoint the app opens, the hello the bridge sends, and an MCP client
 * on the other end. POSIX only — the Windows named pipe has its own name.
 */

const dirs: string[] = [];
const posix = process.platform !== 'win32';

function core() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-'));
  dirs.push(home);
  const timers = {
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  };
  return {
    home,
    changes: createConfigChanges(fakeConfigPort(fakeRuntime())),
    clients: createClientStore({
      read: () => undefined,
      write: () => undefined,
      now: () => Date.now(),
      newId: () => 'c1',
      ...timers,
    }),
    audit: createAuditLog({
      load: () => null,
      append: () => undefined,
      rewrite: () => undefined,
      now: () => Date.now(),
      newId: () => String(Math.random()),
      retentionDays: () => 30,
      published: () => undefined,
      refreshed: () => undefined,
    }),
    desk: createConfirmDesk({
      now: () => Date.now(),
      newId: () => 'r1',
      ...timers,
      requested: () => undefined,
      closed: () => undefined,
    }),
  };
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('src/main/mcp/local-endpoint.ts', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(posix)(
    'serves MCP to a client that presents the token, owner-only',
    async () => {
      const parts = core();
      const endpoint = localEndpoint(parts, fakeRuntime(), '0.12.0');
      await endpoint.start();
      const socketPath = mcpSocketPath(parts.home, process.platform);
      const tokenPath = mcpTokenPath(parts.home, process.platform);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);

      const socket = await connect(socketPath);
      socket.write(helloLine(fs.readFileSync(tokenPath, 'utf8')));
      const client = new Client({ name: 'claude-code', version: '1' });
      await client.connect(new SocketTransport(socket));

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['devbar_access']);
      expect(parts.clients.list()[0]?.status).toBe('pending');

      await client.close();
      await endpoint.stop();
      expect(fs.existsSync(socketPath)).toBe(false);
    },
  );

  it.runIf(posix)('hangs up on a connection with the wrong token', async () => {
    const parts = core();
    const endpoint = localEndpoint(parts, fakeRuntime(), '0.12.0');
    await endpoint.start();

    const socket = await connect(mcpSocketPath(parts.home, process.platform));
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.write(helloLine('not-the-token'));

    await expect(closed).resolves.toBeUndefined();
    await endpoint.stop();
  });
});
