import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const originalDefaultApp = Object.getOwnPropertyDescriptor(
  process,
  'defaultApp',
);

async function loadEntry(
  argv: string[],
  defaultApp: boolean,
  importBridge: () => object,
  importMain: () => object,
  platform: NodeJS.Platform = process.platform,
  runAsNode?: string,
): Promise<void> {
  vi.resetModules();
  vi.doMock('../src/mcp/cli.js', importBridge);
  vi.doMock('../src/main.js', importMain);
  process.argv.splice(0, process.argv.length, ...argv);
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  if (runAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = runAsNode;
  Object.defineProperty(process, 'defaultApp', {
    configurable: true,
    value: defaultApp,
  });
  await import('../src/entry.js');
}

describe('src/entry.ts', () => {
  afterEach(() => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    if (originalPlatform)
      Object.defineProperty(process, 'platform', originalPlatform);
    if (originalRunAsNode === undefined)
      delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode;
    if (originalDefaultApp)
      Object.defineProperty(process, 'defaultApp', originalDefaultApp);
    else Reflect.deleteProperty(process, 'defaultApp');
    vi.doUnmock('../src/mcp/cli.js');
    vi.doUnmock('../src/main.js');
    vi.doUnmock('node:child_process');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('imports the MCP CLI for bridge launches', async () => {
    const importBridge = vi.fn(() => ({}));
    const importMain = vi.fn(() => ({}));

    await loadEntry(
      ['/repo/devbar', '/repo/build/src/mcp/cli.js'],
      false,
      importBridge,
      importMain,
      process.platform,
      '1',
    );

    expect(importBridge).toHaveBeenCalledOnce();
    expect(importMain).not.toHaveBeenCalled();
  });

  it('imports the app main module for regular launches', async () => {
    const importBridge = vi.fn(() => ({}));
    const importMain = vi.fn(() => ({}));

    await loadEntry(
      ['/repo/devbar', '--hidden'],
      false,
      importBridge,
      importMain,
    );

    expect(importBridge).not.toHaveBeenCalled();
    expect(importMain).toHaveBeenCalledOnce();
  });

  it('runs a Windows bridge in Node mode and propagates its exit code', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(
      (..._args: unknown[]) => child as unknown as ChildProcess,
    );
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const importBridge = vi.fn(() => ({}));
    const importMain = vi.fn(() => ({}));
    vi.doMock('node:child_process', () => ({ spawn }));

    await loadEntry(
      [
        'C:/Program Files/DevBar/devbar.exe',
        'C:/Program Files/DevBar/resources/app.asar/build/src/mcp/cli.js',
        '--home',
        'C:/Users/test/AppData/Roaming/DevBar/mcp',
      ],
      false,
      importBridge,
      importMain,
      'win32',
    );

    expect(spawn).toHaveBeenCalledOnce();
    const [executable, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      {
        env: NodeJS.ProcessEnv;
        stdio: string;
        windowsHide: boolean;
      },
    ];
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([
      'C:/Program Files/DevBar/resources/app.asar/build/src/mcp/cli.js',
      '--home',
      'C:/Users/test/AppData/Roaming/DevBar/mcp',
    ]);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(options.stdio).toBe('inherit');
    expect(options.windowsHide).toBe(true);
    expect(importBridge).not.toHaveBeenCalled();
    expect(importMain).not.toHaveBeenCalled();

    child.emit('exit', 17, null);

    expect(exit).toHaveBeenCalledWith(17);
  });
});
