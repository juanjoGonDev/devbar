import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  homeArgument,
  RESTARTED_MESSAGE,
  runBridge,
  UNREACHABLE_MESSAGE,
  type BridgeDeps,
} from '../src/mcp/bridge.js';
import { collect, duplexPair, tick } from './helpers/duplex-pair.js';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { clientInfo: { name: 'claude-code', version: '2' } },
});
const INITIALIZED = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
});
const request = (id: number, method = 'tools/list'): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method }) + '\n';
const answer = (id: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n';
const lines = (text: string): Record<string, unknown>[] =>
  text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** A DevBar that can be closed and opened again, one socket per start. */
function restartableApp() {
  let current: {
    app: ReturnType<typeof duplexPair>[0];
    got: () => string;
  } | null = null;
  return {
    open() {
      const [app, bridge] = duplexPair();
      current = { app, got: collect(app) };
      return bridge;
    },
    get app() {
      if (!current) throw new Error('DevBar is closed');
      return current;
    },
    close() {
      current?.app.destroy();
      current = null;
    },
  };
}

function harness(overrides: Partial<BridgeDeps> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exits: number[] = [];
  const out = collect(stdout);
  const err = collect(stderr);
  const deps: BridgeDeps = {
    argv: ['--home', '/home/ana/mcp'],
    platform: 'linux',
    stdin,
    stdout,
    stderr,
    readFile: () => 'secret-token\n',
    connect: () => Promise.reject(new Error('ENOENT')),
    exit: (code) => exits.push(code),
    ...overrides,
  };
  return { deps, stdin, out, err, exits };
}

describe('src/mcp/bridge.ts', () => {
  it('reads the MCP folder from --home', () => {
    expect(homeArgument(['--home', '/x'])).toBe('/x');
    expect(homeArgument(['--home'])).toBeNull();
    expect(homeArgument([])).toBeNull();
  });

  it('exits with a usage error without --home', async () => {
    const h = harness({ argv: [] });

    await runBridge(h.deps);

    expect(h.exits).toEqual([2]);
    expect(h.err()).toContain('--home');
  });

  it('answers every request with «DevBar no está abierto» when it cannot connect', async () => {
    const h = harness();
    await runBridge(h.deps);

    h.stdin.write(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        'garbage',
        JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'tools/list' }),
        '',
      ].join('\n'),
    );
    await tick();

    const answers = h
      .out()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: unknown; error: unknown });
    expect(answers).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: UNREACHABLE_MESSAGE },
      },
      {
        jsonrpc: '2.0',
        id: 'b',
        error: { code: -32000, message: UNREACHABLE_MESSAGE },
      },
    ]);
    expect(UNREACHABLE_MESSAGE).toContain('DevBar no está abierto');
    expect(h.err()).toContain('DevBar no está abierto');
    h.stdin.end();
    await tick();
    expect(h.exits).toEqual([0]);
  });

  it('treats a missing token like a closed DevBar', async () => {
    const h = harness({
      readFile: () => {
        throw new Error('ENOENT');
      },
      connect: () => Promise.reject(new Error('unreachable')),
    });

    await runBridge(h.deps);

    expect(h.err()).toContain('DevBar no está abierto');
  });

  it('presents the token first, then pipes both ways to the socket path', async () => {
    const [appSide, bridgeSide] = duplexPair();
    const paths: string[] = [];
    const h = harness({
      connect: (path) => {
        paths.push(path);
        return Promise.resolve(bridgeSide);
      },
    });
    const received = collect(appSide);

    await runBridge(h.deps);
    h.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    appSide.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await tick();

    expect(paths).toEqual(['/home/ana/mcp/devbar.sock']);
    expect(received()).toBe(
      '{"devbarMcp":1,"token":"secret-token"}\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    );
    expect(h.out()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  });

  it('keeps running when DevBar hangs up, and exits when the assistant does', async () => {
    const [appSide, bridgeSide] = duplexPair();
    const h = harness({ connect: () => Promise.resolve(bridgeSide) });
    await runBridge(h.deps);

    appSide.destroy();
    await tick();
    await tick();
    expect(h.exits).toEqual([]);

    h.stdin.end();
    await tick();
    expect(h.exits).toEqual([0]);
  });

  it('reconnects to a restarted DevBar with its new token and replays the handshake', async () => {
    const devbar = restartableApp();
    let token = 'token-a';
    const h = harness({
      readFile: () => token,
      connect: () => Promise.resolve(devbar.open()),
    });
    await runBridge(h.deps);
    h.stdin.write(`${INITIALIZE}\n${INITIALIZED}\n`);
    await tick();
    devbar.app.app.write(answer(0));
    await tick();

    devbar.close();
    await tick();
    token = 'token-b';
    h.stdin.write(request(7));
    await tick();
    await tick();
    const [hello, init, initialized, list] = devbar.app
      .got()
      .trim()
      .split('\n');
    const replayedId = (JSON.parse(init ?? '{}') as { id: unknown }).id;
    devbar.app.app.write(answer(replayedId) + answer(7));
    await tick();

    expect(hello).toBe('{"devbarMcp":1,"token":"token-b"}');
    expect(JSON.parse(init ?? '{}')).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'claude-code' } },
    });
    expect(replayedId).not.toBe(0);
    expect(initialized).toBe(INITIALIZED);
    expect(list).toBe(request(7).trim());
    expect(lines(h.out()).map((m) => m.id)).toEqual([0, 7]);
    expect(h.exits).toEqual([]);
  });

  it('answers the requests DevBar left unanswered when it went away', async () => {
    const [appSide, bridgeSide] = duplexPair();
    const h = harness({ connect: () => Promise.resolve(bridgeSide) });
    await runBridge(h.deps);
    h.stdin.write(request(1) + request(2));
    await tick();
    appSide.write(answer(1));
    await tick();

    appSide.destroy();
    await tick();

    expect(lines(h.out())).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: RESTARTED_MESSAGE },
      },
    ]);
  });

  it('connects on the next request once DevBar opens after the bridge started', async () => {
    const devbar = restartableApp();
    let open = false;
    const h = harness({
      connect: () =>
        open ? Promise.resolve(devbar.open()) : Promise.reject(new Error('x')),
    });
    await runBridge(h.deps);
    h.stdin.write(request(1));
    await tick();

    open = true;
    h.stdin.write(request(2));
    await tick();
    await tick();

    expect(lines(h.out())).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: UNREACHABLE_MESSAGE },
      },
    ]);
    expect(devbar.app.got()).toContain(request(2));
  });
});
