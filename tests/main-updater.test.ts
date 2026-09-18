import { describe, expect, it, vi } from 'vitest';
import { createUpdater, type UpdaterDeps } from '../src/main/updater.js';
import type { AvailableUpdate } from '../src/domain-types.js';

const update: AvailableUpdate = {
  version: '1.3.0',
  url: 'https://github.test/releases/v1.3.0',
  dmgUrl: null,
  zipUrl: 'https://github.test/DevBar-1.3.0-macos-arm64.zip',
  setupUrl: null,
  appImageUrl: null,
  debUrl: null,
};

function harness(overrides: Partial<UpdaterDeps> = {}) {
  const calls: string[] = [];
  const banners: string[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const statuses: unknown[] = [];
  const removed: string[] = [];
  const dirs = new Map<string, string[]>([
    ['/home/updates', ['1.2.0', 'file.zip']],
  ]);
  const deps: UpdaterDeps = {
    repo: { owner: 'o', repo: 'r' },
    platform: 'darwin',
    arch: 'arm64',
    isMac: true,
    pid: 99,
    appVersion: () => '1.2.0',
    checkForUpdate: () => Promise.resolve(update),
    fetchReleaseSha256: () =>
      Promise.resolve(new Map([['DevBar-1.3.0-macos-arm64.zip', 'hash']])),
    verifySha256: () => Promise.resolve(true),
    stageableAsset: () => ({
      url: update.zipUrl ?? '',
      fileName: 'DevBar-1.3.0-macos-arm64.zip',
      kind: 'macBundle',
    }),
    stageDownloadedArtifact: (input) => {
      calls.push(`stage:${input.destDir}`);
      return Promise.resolve({ version: input.version, appPath: '/staged' });
    },
    extractUpdate: (input) => {
      calls.push(`extract:${input.zipPath}`);
      return Promise.resolve({ version: input.version, appPath: '/staged' });
    },
    canInstallInPlace: (installed: string | null): installed is string =>
      installed !== null,
    installedAppPath: () => '/Applications/DevBar.app',
    spawnSwap: () => calls.push('spawnSwap'),
    downloadFile: (_url, dest) => {
      calls.push('download');
      return Promise.resolve(dest);
    },
    downloadsDir: () => '/Users/me/Downloads',
    updatesDir: () => '/home/updates',
    removeFile: (target) => removed.push(target),
    updaterFs: {
      mkdirSync: () => calls.push('mkdir'),
      rmSync: (target) => removed.push(target),
      readdirSync: (dir) => dirs.get(dir) ?? [],
      isDirectory: (target) => !target.endsWith('.zip'),
      readInstalledPlist: () =>
        '<key>CFBundleIdentifier</key><string>dev.devbar.app</string>',
    },
    messageBox: () => Promise.resolve({ response: 1 }),
    openPath: () => Promise.resolve(''),
    openExternal: (url) => calls.push(`external:${url}`),
    sendUpdateStatus: (payload) => statuses.push(payload),
    refreshTrayIcon: () => calls.push('refreshTrayIcon'),
    showBannerNotification: (_title, body) => banners.push(body),
    toast: (kind, message) => toasts.push({ kind, message }),
    markUpdateExit: () => calls.push('markUpdateExit'),
    quitAfter: (ms) => calls.push(`quit:${ms}`),
    configFocused: () => false,
    ...overrides,
  };
  return {
    updater: createUpdater(deps),
    calls,
    banners,
    toasts,
    statuses,
    removed,
  };
}

describe('src/main/updater.ts', () => {
  describe('status', () => {
    it('starts with nothing known and the running version', () => {
      const h = harness();
      expect(h.updater.status()).toEqual({
        available: null,
        staged: null,
        lastCheckAt: null,
        currentVersion: '1.2.0',
      });
      expect(h.updater.available()).toBeNull();
      expect(h.updater.staged()).toBeNull();
    });

    it('pushes the same shape to the renderers', () => {
      const h = harness();
      h.updater.broadcastStatus();
      expect(h.statuses[0]).toMatchObject({ currentVersion: '1.2.0' });
    });
  });

  describe('runUpdateCheck', () => {
    it('remembers the release and stages it when an in-place update is possible', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      const result = await h.updater.runUpdateCheck();
      expect(result.available).toEqual(update);
      expect(result.lastCheckAt).toEqual(expect.any(String));
      await vi.waitFor(() =>
        expect(h.calls).toContain('stage:/home/updates/1.3.0'),
      );
      expect(h.banners.at(-1)).toMatch(/Reinicia para instalarla/);
      log.mockRestore();
    });

    it('records no update when GitHub has nothing newer', async () => {
      const h = harness({ checkForUpdate: () => Promise.resolve(null) });
      await h.updater.runUpdateCheck();
      expect(h.updater.available()).toBeNull();
    });

    it('notifies instead of staging when the install shape cannot swap', async () => {
      const h = harness({ stageableAsset: () => null });
      await h.updater.runUpdateCheck();
      expect(h.banners).toEqual(['v1.3.0 disponible.']);
    });

    it('notifies at most once per launch from the automatic loop', async () => {
      const h = harness({ stageableAsset: () => null });
      await h.updater.runUpdateCheck();
      await h.updater.runUpdateCheck();
      expect(h.banners).toHaveLength(1);
    });

    it('notifies again on a manual check', async () => {
      const h = harness({ stageableAsset: () => null });
      await h.updater.runUpdateCheck();
      await h.updater.runUpdateCheck({ manual: true });
      expect(h.banners).toHaveLength(2);
    });

    it('stays quiet while the config window is focused', async () => {
      const h = harness({
        stageableAsset: () => null,
        configFocused: () => true,
      });
      await h.updater.runUpdateCheck({ manual: true });
      expect(h.banners).toEqual([]);
    });

    it('lets a simulated update own the slot', async () => {
      const h = harness();
      h.updater.setSimulatedUpdate({ ...update, version: '9.9.9' });
      await h.updater.runUpdateCheck();
      expect(h.updater.available()?.version).toBe('9.9.9');
      expect(h.calls).not.toContain('download');
    });

    it('hands the slot back when the simulation is released', async () => {
      const h = harness();
      h.updater.setSimulatedUpdate({ ...update, version: '9.9.9' });
      h.updater.setSimulatedUpdate(null);
      await h.updater.runUpdateCheck();
      expect(h.updater.available()?.version).toBe('1.3.0');
    });
  });

  describe('staging', () => {
    it('aborts and warns when the integrity manifest cannot be fetched', async () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness({ fetchReleaseSha256: () => Promise.resolve(null) });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.banners).toContain('v1.3.0 disponible.'));
      expect(h.updater.staged()).toBeNull();
      warn.mockRestore();
    });

    it('aborts when the digest does not match', async () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness({ verifySha256: () => Promise.resolve(false) });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.banners).toContain('v1.3.0 disponible.'));
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not re-pull a version that already failed this session', async () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness({ verifySha256: () => Promise.resolve(false) });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.banners).toHaveLength(1));
      await h.updater.runUpdateCheck({ manual: true });
      expect(h.calls.filter((call) => call === 'download')).toHaveLength(1);
      warn.mockRestore();
    });

    it('always deletes the downloaded archive', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      await h.updater.runUpdateCheck();
      await vi.waitFor(() =>
        expect(h.removed).toContain(
          '/home/updates/DevBar-1.3.0-macos-arm64.zip',
        ),
      );
      log.mockRestore();
    });

    it('prunes the older staged version but keeps the new one', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      await h.updater.runUpdateCheck();
      await vi.waitFor(() =>
        expect(h.removed).toContain('/home/updates/1.2.0'),
      );
      log.mockRestore();
    });

    it('survives an unreadable updates directory while pruning', () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness({
        updaterFs: {
          mkdirSync: () => undefined,
          rmSync: () => undefined,
          readdirSync: () => {
            throw new Error('ENOENT');
          },
          isDirectory: () => true,
          readInstalledPlist: () => null,
        },
      });
      expect(() => h.updater.pruneStagedUpdates('1.3.0')).not.toThrow();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('stages a locally built zip through the real announce path', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      await h.updater.stageFromZip('/tmp/DevBar.zip', '1.4.0');
      expect(h.calls).toContain('extract:/tmp/DevBar.zip');
      expect(h.updater.staged()?.version).toBe('1.4.0');
      expect(h.banners.at(-1)).toMatch(/v1.4.0 lista/);
      log.mockRestore();
    });
  });

  describe('applyUpdate', () => {
    it('refuses when nothing is available', async () => {
      const h = harness();
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: false,
        error: 'no_update',
      });
    });

    it('swaps in place once the matching version is staged', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.updater.staged()).not.toBeNull());
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: true,
        quitting: true,
        inPlace: true,
      });
      expect(h.calls).toContain('spawnSwap');
      expect(h.calls).toContain('quit:200');
      log.mockRestore();
    });

    it('does nothing when the restart prompt is declined', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness({ messageBox: () => Promise.resolve({ response: 0 }) });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.updater.staged()).not.toBeNull());
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: false,
        cancelled: true,
      });
      log.mockRestore();
    });

    it('reports a restart prompt that could not be shown', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness({
        messageBox: () => Promise.reject(new Error('no window')),
      });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.updater.staged()).not.toBeNull());
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: false,
        error: 'no window',
      });
      log.mockRestore();
    });

    it('reports a swap that could not be spawned', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness({
        spawnSwap: () => {
          throw new Error('permission denied');
        },
      });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.updater.staged()).not.toBeNull());
      await expect(h.updater.applyUpdate()).resolves.toMatchObject({
        ok: false,
        error: 'permission denied',
      });
      expect(h.toasts[0]?.kind).toBe('error');
      log.mockRestore();
    });

    it('falls back to the assisted flow when nothing is staged', async () => {
      const h = harness({ stageableAsset: () => null });
      await h.updater.runUpdateCheck();
      const result = await h.updater.applyUpdate();
      expect(result).toEqual({ ok: true, opened: 'page' });
    });
  });

  describe('installedBundleId', () => {
    it('reads the identifier back from the running bundle', () => {
      const h = harness();
      expect(h.updater.installedBundleId()).toBe('dev.devbar.app');
    });

    it('is null in a dev run with no bundle of ours', () => {
      const h = harness({ installedAppPath: () => null });
      expect(h.updater.installedBundleId()).toBeNull();
    });

    it('is null off macOS, where there is no Info.plist', () => {
      const h = harness({ isMac: false });
      expect(h.updater.installedBundleId()).toBeNull();
    });

    it('is null when the plist cannot be read', () => {
      const h = harness({
        updaterFs: {
          mkdirSync: () => undefined,
          rmSync: () => undefined,
          readdirSync: () => [],
          isDirectory: () => true,
          readInstalledPlist: () => null,
        },
      });
      expect(h.updater.installedBundleId()).toBeNull();
    });
  });
});
