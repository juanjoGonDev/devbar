import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The `remoteControl` key of `src/config-store/store.ts`, through the real
 * `electron-store` (only `electron` is faked). It holds the linked devices'
 * public keys and this computer's identity seed, so the point here is as
 * much where it does NOT go — exports, import backups, the settings every
 * window reads, other users of this computer — as where it does.
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
    secret: 'c2VlZC1pbi10aGUtY2xlYXI',
    sealed: false,
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

    for (const secret of ['devicePub', 'c2VlZC1pbi10aGUtY2xlYXI', 'identity']) {
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

  // POSIX modes only: on Windows the user's AppData ACLs do this job.
  describe.skipIf(process.platform === 'win32')('the file it lives in', () => {
    const configFile = (): string => path.join(harness.dir(), 'config.json');
    const mode = (): number => fs.statSync(configFile()).mode & 0o777;

    it('is readable and writable by its user only, as it holds the identity seed', async () => {
      const store = await harness.open();

      store.saveRemoteControl(STATE);

      expect(mode()).toBe(0o600);
    });

    it('is created that way, before anything is saved in it', async () => {
      await harness.open();

      expect(mode()).toBe(0o600);
    });

    it('is tightened on the next start when an earlier version left it readable by others', async () => {
      const first = await harness.open();
      first.saveRemoteControl(STATE);
      fs.chmodSync(configFile(), 0o644);

      await harness.open({ home: harness.home() });

      expect(mode()).toBe(0o600);
    });
  });
});
