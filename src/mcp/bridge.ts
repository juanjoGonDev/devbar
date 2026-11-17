import net from 'node:net';
import type { Duplex, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { helloLine, mcpSocketPath, mcpTokenPath } from './endpoint.js';

/**
 * The stdio bridge an assistant launches (`cli.ts`): it speaks MCP on its
 * stdin/stdout and forwards every line to the running app's local endpoint
 * after presenting the token. It understands little of MCP itself: enough to
 * answer a request with a clear error while DevBar cannot be reached, and to
 * survive DevBar restarting. The assistant keeps this process for its whole
 * session, so when DevBar goes away the bridge waits; the next request
 * reconnects (with the new start's token) and first replays the assistant's
 * own `initialize`, which the new DevBar needs before anything else.
 *
 * Self-contained on purpose: it runs in a fresh Node process for every
 * assistant session and must start fast, so it imports neither the SDK nor
 * anything of the app.
 */

export interface BridgeDeps {
  argv: readonly string[];
  platform: NodeJS.Platform;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  readFile(path: string): string;
  /** Resolves with the open connection, rejects when nothing listens. */
  connect(path: string): Promise<Duplex>;
  exit(code: number): void;
}

/** JSON-RPC «server error»: what a request gets while DevBar is away. */
const UNREACHABLE_CODE = -32000;
export const UNREACHABLE_MESSAGE =
  'DevBar no está abierto, o su servidor MCP está desactivado (Ajustes › MCP). Ábrelo y vuelve a intentarlo.';

/** What a request gets when DevBar went away before answering it. */
export const RESTARTED_MESSAGE =
  'DevBar se ha cerrado o reiniciado antes de responder. Vuelve a intentarlo.';

/** The id the replayed `initialize` carries, so its answer is not relayed. */
const REPLAY_ID_PREFIX = 'devbar-bridge-replay-';

/** The real `connect`: opens the socket or pipe, rejecting when nothing listens. */
export function connectSocket(path: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** `--home <dir>`, the app's MCP folder. */
export function homeArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf('--home');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ? value : null;
}

interface Message {
  id?: unknown;
  method?: unknown;
}

function parse(line: string): Message | null {
  try {
    const message = JSON.parse(line) as unknown;
    return typeof message === 'object' && message !== null ? message : null;
  } catch {
    return null;
  }
}

/** Notifications carry no id and expect no answer. */
const isRequest = (message: Message | null): message is Message =>
  message?.id !== undefined && message.method !== undefined;

/** Calls `onLine` for every complete, non-empty line `stream` delivers. */
function eachLine(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  stream.on('data', (chunk: Buffer | string) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if (line) onLine(line);
    }
  });
}

export async function runBridge(deps: BridgeDeps): Promise<void> {
  const home = homeArgument(deps.argv);
  if (!home) {
    deps.stderr.write('devbar mcp: falta --home <carpeta MCP de DevBar>\n');
    deps.exit(2);
    return;
  }
  const socketPath = mcpSocketPath(home, deps.platform);
  const tokenPath = mcpTokenPath(home, deps.platform);
  let socket: Duplex | null = null;
  let warned = false;
  let replays = 0;
  /** The assistant's `initialize` and `initialized`, for a restarted DevBar. */
  let handshake: string[] = [];
  /** Requests sent to DevBar and not answered yet. */
  const inFlight = new Set<unknown>();
  const replayIds = new Set<unknown>();

  const fail = (id: unknown, message: string): void => {
    deps.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: UNREACHABLE_CODE, message },
      }) + '\n',
    );
  };

  const fromApp = (line: string): void => {
    const message = parse(line);
    if (message?.id !== undefined && message.method === undefined) {
      if (replayIds.delete(message.id)) return;
      inFlight.delete(message.id);
    }
    deps.stdout.write(line + '\n');
  };

  async function open(): Promise<Duplex | null> {
    try {
      // Read on every connect: each DevBar start writes a new token.
      const token = deps.readFile(tokenPath).trim();
      const next = await deps.connect(socketPath);
      next.write(helloLine(token));
      eachLine(next, fromApp);
      const drop = (): void => {
        if (socket !== next) return;
        socket = null;
        for (const id of inFlight) fail(id, RESTARTED_MESSAGE);
        inFlight.clear();
        replayIds.clear();
      };
      next.on('error', drop);
      next.on('close', drop);
      warned = false;
      return next;
    } catch {
      if (!warned) deps.stderr.write(`devbar mcp: ${UNREACHABLE_MESSAGE}\n`);
      warned = true;
      return null;
    }
  }

  function replayHandshake(target: Duplex): void {
    const [initialize, initialized] = handshake;
    const message = initialize ? parse(initialize) : null;
    if (!message) return;
    replays += 1;
    const id = `${REPLAY_ID_PREFIX}${String(replays)}`;
    replayIds.add(id);
    target.write(JSON.stringify({ ...message, id }) + '\n');
    if (initialized) target.write(initialized + '\n');
  }

  async function forward(line: string): Promise<void> {
    const message = parse(line);
    if (!socket) {
      socket = await open();
      if (socket && message?.method !== 'initialize') replayHandshake(socket);
    }
    if (message?.method === 'initialize') handshake = [line];
    else if (
      message?.method === 'notifications/initialized' &&
      handshake.length === 1
    )
      handshake.push(line);
    if (!socket) {
      if (isRequest(message)) fail(message.id, UNREACHABLE_MESSAGE);
      return;
    }
    if (isRequest(message)) inFlight.add(message.id);
    socket.write(line + '\n');
  }

  socket = await open();
  // One line at a time: a reconnect must finish before the next line goes.
  let queue = Promise.resolve();
  eachLine(deps.stdin, (line) => {
    queue = queue.then(() => forward(line));
  });
  deps.stdin.on('end', () => {
    void queue.then(() => deps.exit(0));
  });
}
