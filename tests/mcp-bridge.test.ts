import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  homeArgument,
  runBridge,
  UNREACHABLE_MESSAGE,
  type BridgeDeps,
} from '../src/mcp/bridge.js';
import { collect, duplexPair, tick } from './helpers/duplex-pair.js';

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

  it('exits when DevBar hangs up', async () => {
    const [appSide, bridgeSide] = duplexPair();
    const h = harness({ connect: () => Promise.resolve(bridgeSide) });
    await runBridge(h.deps);

    appSide.destroy();
    await tick();
    await tick();

    expect(h.exits).toContain(0);
  });
});
