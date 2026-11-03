import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The MCP slices of `src/config-store/store.ts`, through the real
 * `electron-store` (only `electron` is faked): the switch inside the global
 * settings, and the `mcpClients` key that holds each assistant's
 * permissions — which, like «Control remoto», never travels in an export or
 * an import backup.
 */

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  home: '',
  userData: '',
  version: '0.12.0',
}));

vi.mock('electron', () => {
  const app = {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: (name: string) =>
      name === 'home' ? electronState.home : electronState.userData,
    getVersion: () => electronState.version,
  };
  const electron = { app, ipcMain: { on: () => undefined }, shell: {} };
  return { ...electron, default: electron };
});

import type { McpTransport } from '../src/domain-types.js';
import { configStoreHarness } from './helpers/config-store.js';

const harness = configStoreHarness(electronState);

const CLIENT = { id: 'c1', key: 'claude-code', status: 'allowed' };

describe('src/config-store/store.ts (MCP)', () => {
  afterEach(() => harness.cleanup());

  it('leaves the MCP server off until the user turns it on', async () => {
    const store = await harness.open();

    expect(store.getGlobalSettings().mcp).toEqual({
      enabled: false,
      transport: 'stdio',
    });
  });

  it('keeps the switch, and only the stdio transport', async () => {
    const store = await harness.open();

    const unknown = 'http' as McpTransport;
    const saved = store.saveMcpSettings({ enabled: true, transport: unknown });

    expect(saved.mcp).toEqual({ enabled: true, transport: 'stdio' });
    const reopened = await harness.open({ home: harness.home() });
    expect(reopened.getGlobalSettings().mcp.enabled).toBe(true);
  });

  it('never lets the general settings save, nor an import, flip the switch', async () => {
    const store = await harness.open();
    store.saveMcpSettings({ enabled: true, transport: 'stdio' });

    const saved = store.saveGlobalSettings({
      theme: 'dark',
      mcp: { enabled: false, transport: 'stdio' },
    });

    expect(saved.theme).toBe('dark');
    expect(saved.mcp.enabled).toBe(true);
    expect(store.getGlobalSettings().mcp.enabled).toBe(true);
  });

  it('reads a hand-edited switch as off', async () => {
    const store = await harness.open({
      seed: { version: 4, globalSettings: { mcp: { enabled: 'yes' } } },
    });

    expect(store.getGlobalSettings().mcp.enabled).toBe(false);
  });

  it('keeps the clients across a restart, raw', async () => {
    const first = await harness.open();
    expect(first.getMcpClients()).toBeUndefined();
    first.saveMcpClients([CLIENT]);

    const second = await harness.open({ home: harness.home() });

    expect(second.getMcpClients()).toEqual([CLIENT]);
  });

  it('never puts the clients in an export or an import backup', async () => {
    const store = await harness.open();
    store.saveMcpClients([CLIENT]);

    const backup = fs.readFileSync(store.writeImportBackup(), 'utf8');

    expect(JSON.stringify(store.exportConfig())).not.toContain('claude-code');
    expect(backup).not.toContain('claude-code');
  });
});
