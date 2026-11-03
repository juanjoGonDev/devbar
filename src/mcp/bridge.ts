import type { Duplex, Readable, Writable } from 'node:stream';
import { helloLine, mcpSocketPath, mcpTokenPath } from './endpoint.js';

/**
 * The stdio bridge an assistant launches (`cli.ts`): it speaks MCP on its
 * stdin/stdout and forwards every byte to the running app's local endpoint
 * after presenting the token. It understands nothing of MCP itself — except
 * when DevBar cannot be reached, where it answers every request with a clear
 * error instead of leaving the assistant waiting.
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

/** `--home <dir>`, the app's MCP folder. */
export function homeArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf('--home');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ? value : null;
}

/** Answers each request on `stdin` with the «not open» error, forever. */
function answerUnreachable(deps: BridgeDeps): void {
  let pending = '';
  deps.stdin.setEncoding('utf8');
  deps.stdin.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if (!line) continue;
      let id: unknown;
      try {
        const message = JSON.parse(line) as { id?: unknown; method?: unknown };
        // Notifications carry no id and expect no answer.
        if (message.id === undefined || message.method === undefined) continue;
        id = message.id;
      } catch {
        continue;
      }
      deps.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: UNREACHABLE_CODE, message: UNREACHABLE_MESSAGE },
        }) + '\n',
      );
    }
  });
  deps.stdin.on('end', () => deps.exit(0));
}

export async function runBridge(deps: BridgeDeps): Promise<void> {
  const home = homeArgument(deps.argv);
  if (!home) {
    deps.stderr.write('devbar mcp: falta --home <carpeta MCP de DevBar>\n');
    deps.exit(2);
    return;
  }
  let socket: Duplex;
  let token: string;
  try {
    token = deps.readFile(mcpTokenPath(home, deps.platform)).trim();
    socket = await deps.connect(mcpSocketPath(home, deps.platform));
  } catch {
    deps.stderr.write(`devbar mcp: ${UNREACHABLE_MESSAGE}\n`);
    answerUnreachable(deps);
    return;
  }
  socket.write(helloLine(token));
  deps.stdin.pipe(socket);
  socket.pipe(deps.stdout);
  socket.on('error', () => deps.exit(1));
  socket.on('close', () => deps.exit(0));
}
