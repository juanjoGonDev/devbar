import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];
const originalDefaultApp = Object.getOwnPropertyDescriptor(
  process,
  'defaultApp',
);

async function loadEntry(
  argv: string[],
  defaultApp: boolean,
  importBridge: () => object,
  importMain: () => object,
): Promise<void> {
  vi.resetModules();
  vi.doMock('../src/mcp/cli.js', importBridge);
  vi.doMock('../src/main.js', importMain);
  process.argv.splice(0, process.argv.length, ...argv);
  Object.defineProperty(process, 'defaultApp', {
    configurable: true,
    value: defaultApp,
  });
  await import('../src/entry.js');
}

describe('src/entry.ts', () => {
  afterEach(() => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    if (originalDefaultApp)
      Object.defineProperty(process, 'defaultApp', originalDefaultApp);
    else Reflect.deleteProperty(process, 'defaultApp');
    vi.doUnmock('../src/mcp/cli.js');
    vi.doUnmock('../src/main.js');
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
});
