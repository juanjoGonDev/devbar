import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Where the app's local MCP endpoint listens, and where the bridge
 * (`src/mcp/cli.ts`) finds it. Both sides derive it from the same folder —
 * the app's `mcp` directory, which the bridge receives as `--home` — so the
 * two can never disagree:
 *
 * - macOS / Linux: a Unix socket inside that folder (the folder is 0700 and
 *   the socket 0600, so only this user can reach it);
 * - Windows: a named pipe whose name is derived from the folder.
 *
 * Next to it lives the `token` file the bridge presents as its first line:
 * the second lock, which also guards the Windows pipe (its default ACL lets
 * other local users open it read-only, but they cannot read the user's
 * profile folder the token lives in).
 *
 * Pure and dependency-free on purpose: the bridge imports it, and the bridge
 * has to start fast and ship nothing from the app.
 */

const TOKEN_FILE = 'token';
const SOCKET_FILE = 'devbar.sock';

/** The socket path (POSIX) or pipe name (Windows) for this `home`. */
export function mcpSocketPath(home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const digest = createHash('sha256')
      .update(path.win32.resolve(home).toLowerCase())
      .digest('hex')
      .slice(0, 24);
    return `\\\\.\\pipe\\devbar-mcp-${digest}`;
  }
  return path.posix.join(home, SOCKET_FILE);
}

export function mcpTokenPath(home: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.join(home, TOKEN_FILE)
    : path.posix.join(home, TOKEN_FILE);
}

/** The bridge's first line: who it is, before any MCP message. */
export interface BridgeHello {
  devbarMcp: 1;
  token: string;
}

export function helloLine(token: string): string {
  const hello: BridgeHello = { devbarMcp: 1, token };
  return JSON.stringify(hello) + '\n';
}

/** The token a first line carries, or null when it is not a hello. */
export function parseHello(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object') return null;
    const hello = value as Partial<BridgeHello>;
    return hello.devbarMcp === 1 && typeof hello.token === 'string'
      ? hello.token
      : null;
  } catch {
    return null;
  }
}
