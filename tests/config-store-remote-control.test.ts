import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The `remoteControl` key of `src/config-store/store.ts`, through the real
 * `electron-store` (only `electron` is faked). It holds the linked devices'
 * token hashes, so the point here is as much where it does NOT go — exports,
 * import backups, the settings every window reads — as where it does.
 */

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  home: '',
  userData: '',
  version: '0.11.0',
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

import { configStoreHarness } from './helpers/config-store.js';

const harness = configStoreHarness(electronState);

const STATE = {
  enabled: true,
  autoUnlink: false,
  notifyConnections: true,
  port: 47821,
  devices: [
    {
      id: 'd1',
      name: 'iPhone',
      devicePub: 'A'.repeat(43),
      client: 'Safari · iOS',
      createdAt: 1,
      lastSeenAt: 2,
      verifiedAt: null,
      lastIp: null,
    },
  ],
  identity: {
    publicKey: 'B'.repeat(43),
    secret: 'c2VhbGVkLXNlZWQ',
    sealed: true,
  },
};

describe('remoteControl store key', () => {
  afterEach(() => harness.cleanup());

  it('is absent until something is saved', async () => {
    const store = await harness.open();

    expect(store.getRemoteControl()).toBeUndefined();
  });

  it('keeps what is saved across a restart', async () => {
    const first = await harness.open();
    first.saveRemoteControl(STATE);

    const second = await harness.open({ home: harness.home() });

    expect(second.getRemoteControl()).toEqual(STATE);
    expect(harness.onDisk().remoteControl).toEqual(STATE);
  });

  it('never travels in an export, an import backup or the global settings', async () => {
    const store = await harness.open();
    store.saveRemoteControl(STATE);

    const backup = fs.readFileSync(store.writeImportBackup(), 'utf8');

    for (const secret of ['devicePub', 'c2VhbGVkLXNlZWQ', 'identity']) {
      expect(JSON.stringify(store.exportConfig())).not.toContain(secret);
      expect(backup).not.toContain(secret);
    }
    expect(store.getGlobalSettings()).not.toHaveProperty('remoteControl');
  });

  it('survives an import, which replaces only the configuration', async () => {
    const store = await harness.open();
    store.saveRemoteControl(STATE);

    store.replaceConfig({ version: 4, groups: [], globalSettings: {} });

    expect(store.getRemoteControl()).toEqual(STATE);
  });
});
