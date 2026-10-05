import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteControlState } from '../src/main/remote/device-store.js';
import { remoteControlDeps } from '../src/main/remote/remote-wiring.js';
import { createWindowRegistry } from '../src/main/renderer-bus.js';
import { fakeAppWiring } from './helpers/remote-wiring.js';

/**
 * «Control remoto» handed the real collaborators main.ts has: the renderer
 * directory, the config store, the window fan-out, the keychain and the
 * desktop banner.
 */

describe('src/main/remote/remote-wiring.ts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  function wiring() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-remote-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'remote.html'), '<p>hi</p>');
    let saved: RemoteControlState | null = null;
    const sent: unknown[] = [];
    const registry = createWindowRegistry(() => null);
    registry.config = {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => sent.push(args) },
      setBackgroundColor: () => undefined,
      getTitle: () => '',
      show: () => undefined,
      focus: () => undefined,
    };
    const app = fakeAppWiring().wiring;
    const banners: unknown[][] = [];
    const deps = remoteControlDeps({
      ...app,
      notifications: {
        showBannerNotification: (...args) => banners.push(args),
      },
      host: {
        ...app.host,
        rendererFile: (name) => path.join(dir, name),
        appVersion: () => '0.11.0',
        safeStorage: {
          isAsyncEncryptionAvailable: () => Promise.resolve(false),
          encryptStringAsync: () => Promise.resolve(Buffer.alloc(0)),
          decryptStringAsync: () =>
            Promise.resolve({ shouldReEncrypt: false, result: '' }),
        },
      },
      configStore: {
        ...app.configStore,
        getRemoteControl: () => ({ enabled: true }),
        saveRemoteControl: (state) => {
          saved = state;
        },
      },
      registry,
    });
    return { deps, sent, banners, saved: () => saved };
  }

  it('reads whitelisted build files through the renderer directory', () => {
    const { deps } = wiring();

    expect(deps.readStatic('remote.html')?.toString()).toBe('<p>hi</p>');
    expect(deps.readStatic('missing.js')).toBeNull();
  });

  it('pushes to the app windows and persists through the config store', () => {
    const { deps, sent, saved } = wiring();
    const state: RemoteControlState = {
      enabled: false,
      autoUnlink: true,
      notifyConnections: true,
      port: 47821,
      devices: [],
      identity: null,
    };

    deps.send('remote:changed', { x: 1 });
    deps.writeState(state);

    expect(sent).toEqual([['remote:changed', { x: 1 }]]);
    expect(saved()).toEqual(state);
    expect(deps.readState()).toEqual({ enabled: true });
  });

  it('hands connection banners to the app notifications, and the keychain over', async () => {
    const { deps, banners } = wiring();
    const options = {
      cta: { label: 'Ver dispositivos', action: 'open-remote' },
      record: false as const,
    };

    deps.showBanner?.('DevBar — control remoto', 'hola', options);

    expect(banners).toEqual([['DevBar — control remoto', 'hola', options]]);
    await expect(deps.secretBox?.isAsyncEncryptionAvailable()).resolves.toBe(
      false,
    );
  });

  it('names the host without its local domain', () => {
    const { deps } = wiring();

    expect(deps.hostName()).toBe(os.hostname().split('.')[0]);
    expect(deps.appVersion()).toBe('0.11.0');
    expect(typeof deps.networkInterfaces()).toBe('object');
  });
});
