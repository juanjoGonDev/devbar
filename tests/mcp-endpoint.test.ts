import { describe, expect, it } from 'vitest';
import {
  helloLine,
  mcpSocketPath,
  mcpTokenPath,
  parseHello,
  type BridgeHello,
} from '../src/mcp/endpoint.js';

describe('src/mcp/endpoint.ts', () => {
  it('puts the socket inside the MCP folder on macOS and Linux', () => {
    expect(mcpSocketPath('/home/ana/.config/DevBar/mcp', 'linux')).toBe(
      '/home/ana/.config/DevBar/mcp/devbar.sock',
    );
  });

  it('derives a stable named pipe from the folder on Windows', () => {
    const pipe = mcpSocketPath('C:\\Users\\Ana\\AppData\\DevBar\\mcp', 'win32');

    expect(pipe).toMatch(/^\\\\\.\\pipe\\devbar-mcp-[0-9a-f]{24}$/);
    expect(mcpSocketPath('c:\\users\\ana\\appdata\\devbar\\mcp', 'win32')).toBe(
      pipe,
    );
    expect(
      mcpSocketPath('C:\\Users\\Bob\\AppData\\DevBar\\mcp', 'win32'),
    ).not.toBe(pipe);
  });

  it('keeps the token next to the socket', () => {
    expect(mcpTokenPath('/x/mcp', 'darwin')).toBe('/x/mcp/token');
    expect(mcpTokenPath('C:\\x\\mcp', 'win32')).toBe('C:\\x\\mcp\\token');
  });

  it('round-trips the hello line', () => {
    const line = helloLine('t0k3n');
    const parsed = JSON.parse(line) as BridgeHello;

    expect(line.endsWith('\n')).toBe(true);
    expect(parsed.devbarMcp).toBe(1);
    expect(parseHello(line.trim())).toBe('t0k3n');
  });

  it.each([
    ['not json'],
    ['null'],
    ['{"devbarMcp":2,"token":"x"}'],
    ['{"devbarMcp":1}'],
    ['{"jsonrpc":"2.0","method":"initialize"}'],
  ])('refuses %s as a hello', (line) => {
    expect(parseHello(line)).toBeNull();
  });
});
