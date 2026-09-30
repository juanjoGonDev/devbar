import { describe, expect, it, vi } from 'vitest';
import { harness, update } from './helpers/updater-harness.js';
import type { UpdaterDeps } from '../src/main/updater.js';
import type { AvailableUpdate } from '../src/domain-types.js';

describe('src/main/updater.ts — Linux flow and reporting', () => {
  describe('applyUpdate on Linux', () => {
    const linuxUpdate: AvailableUpdate = {
      ...update,
      zipUrl: null,
      appImageUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.AppImage',
      debUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.deb',
    };
    const linux = (overrides: Partial<UpdaterDeps> = {}) =>
      harness({
        platform: 'linux',
        isMac: false,
        checkForUpdate: () => Promise.resolve(linuxUpdate),
        stageableAsset: () => null,
        downloadsDir: () => '/home/pi/Downloads',
        fetchReleaseSha256: () =>
          Promise.resolve(
            new Map([['DevBar-1.3.0-linux-arm64.deb', 'debhash']]),
          ),
        ...overrides,
      });
    const deb = '/home/pi/Downloads/DevBar-1.3.0-linux-arm64.deb';

    it('downloads the .deb without a dialog, then installs it on the second click', async () => {
      const box = vi.fn(() => Promise.resolve({ response: 1 }));
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = linux({ messageBox: box });
      await h.updater.runUpdateCheck();
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: true,
        path: deb,
      });
      expect(box).not.toHaveBeenCalled();
      expect(h.updater.status().phase).toMatchObject({
        state: 'ready-to-install',
        install: 'package',
      });
      await expect(h.updater.applyUpdate()).resolves.toMatchObject({
        ok: true,
        quitting: true,
      });
      expect(h.processes[0]).toEqual([
        '/usr/bin/pkexec',
        '/usr/bin/apt-get',
        'install',
        '-y',
        deb,
      ]);
      expect(h.calls).toContain('relaunch');
      vi.restoreAllMocks();
    });

    it('retries the install after a cancelled authentication', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      let code = 126;
      const ran: string[][] = [];
      const h = linux({
        runProcess: (file, args) => {
          ran.push([file, ...args]);
          return Promise.resolve({
            code,
            stdout: '',
            stderr: '',
            spawnError: null,
          });
        },
      });
      await h.updater.runUpdateCheck();
      await h.updater.applyUpdate();
      await h.updater.applyUpdate();
      expect(h.updater.status().phase.state).toBe('install-failed');
      code = 0;
      await h.updater.applyUpdate();
      expect(ran).toHaveLength(2);
      expect(h.updater.status().phase.state).toBe('restarting');
      vi.restoreAllMocks();
    });

    it('re-downloads on retry after a failed download', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let fail = true;
      let downloads = 0;
      const h = linux({
        downloadFile: (_url, dest) => {
          downloads++;
          return fail
            ? Promise.reject(new Error('ECONNRESET'))
            : Promise.resolve(dest);
        },
      });
      await h.updater.runUpdateCheck();
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: false,
        error: 'ECONNRESET',
      });
      fail = false;
      await h.updater.applyUpdate();
      expect(downloads).toBe(2);
      expect(h.updater.status().phase.state).toBe('ready-to-install');
      vi.restoreAllMocks();
    });

    it('does not download again while the manual instructions are showing', async () => {
      const h = linux({ linuxInstallShape: () => Promise.resolve('other') });
      await h.updater.runUpdateCheck();
      await h.updater.applyUpdate();
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: true,
        path: deb,
      });
      expect(h.calls.filter((c) => c === 'download')).toHaveLength(1);
    });

    it('retries a failed in-place staging instead of blacklisting the version', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      let verified = false;
      const h = linux({
        stageableAsset: () => ({
          url: linuxUpdate.appImageUrl ?? '',
          fileName: 'DevBar-1.3.0-linux-arm64.AppImage',
          kind: 'appImage',
        }),
        fetchReleaseSha256: () =>
          Promise.resolve(
            new Map([['DevBar-1.3.0-linux-arm64.AppImage', 'hash']]),
          ),
        verifySha256: () => Promise.resolve(verified),
        installedAppPath: () => '/home/pi/Apps/DevBar.AppImage',
      });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() =>
        expect(h.updater.status().phase.state).toBe('verify-failed'),
      );
      verified = true;
      await expect(h.updater.applyUpdate()).resolves.toEqual({ ok: true });
      expect(h.updater.staged()?.version).toBe('1.3.0');
      expect(h.updater.status().phase).toMatchObject({
        state: 'ready-to-install',
        install: 'restart',
      });
      vi.restoreAllMocks();
    });

    it('restarts a staged AppImage without a modal confirmation', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const box = vi.fn(() => Promise.resolve({ response: 0 }));
      const h = linux({
        messageBox: box,
        stageableAsset: () => ({
          url: linuxUpdate.appImageUrl ?? '',
          fileName: 'DevBar-1.3.0-linux-arm64.AppImage',
          kind: 'appImage',
        }),
        fetchReleaseSha256: () =>
          Promise.resolve(
            new Map([['DevBar-1.3.0-linux-arm64.AppImage', 'hash']]),
          ),
      });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() => expect(h.updater.staged()).not.toBeNull());
      await expect(h.updater.applyUpdate()).resolves.toMatchObject({
        ok: true,
        quitting: true,
      });
      expect(box).not.toHaveBeenCalled();
      expect(h.calls).toContain('spawnSwap');
      vi.restoreAllMocks();
    });

    it('answers a failed retry of the staging with its reason', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = linux({
        stageableAsset: () => ({
          url: 'u',
          fileName: 'DevBar-1.3.0-linux-arm64.AppImage',
          kind: 'appImage',
        }),
        verifySha256: () => Promise.resolve(false),
      });
      await h.updater.runUpdateCheck();
      await vi.waitFor(() =>
        expect(h.updater.status().phase.state).toBe('verify-failed'),
      );
      const res = await h.updater.applyUpdate();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/SHA256SUMS/);
      vi.restoreAllMocks();
    });
  });

  describe('busy guard', () => {
    it('refuses a second apply while a download is running', async () => {
      let finish: (value: string) => void = () => undefined;
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = harness({
        platform: 'linux',
        isMac: false,
        stageableAsset: () => null,
        checkForUpdate: () =>
          Promise.resolve({
            ...update,
            debUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.deb',
          }),
        downloadFile: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      });
      await h.updater.runUpdateCheck();
      const first = h.updater.applyUpdate();
      await vi.waitFor(() =>
        expect(h.updater.status().phase.state).toBe('downloading'),
      );
      await expect(h.updater.applyUpdate()).resolves.toEqual({
        ok: false,
        busy: true,
      });
      finish('/done');
      await first;
      vi.restoreAllMocks();
    });
  });

  describe('applyUpdateAndReport', () => {
    it('tells the user about a failure no window is showing', async () => {
      const h = harness({
        messageBox: () => Promise.reject(new Error('no window')),
        stageableAsset: () => null,
      });
      await h.updater.runUpdateCheck();
      h.banners.length = 0;
      await h.updater.applyUpdateAndReport();
      expect(h.banners).toEqual(['No se pudo actualizar: no window']);
    });

    it('points at the Updates pane when the next step is the user’s', async () => {
      const h = harness({
        platform: 'linux',
        isMac: false,
        stageableAsset: () => null,
        checkForUpdate: () =>
          Promise.resolve({
            ...update,
            debUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.deb',
          }),
        fetchReleaseSha256: () =>
          Promise.resolve(
            new Map([['DevBar-1.3.0-linux-arm64.deb', 'debhash']]),
          ),
      });
      await h.updater.runUpdateCheck();
      h.banners.length = 0;
      await h.updater.applyUpdateAndReport();
      expect(h.banners).toEqual([
        'v1.3.0 descargada. Instálala desde Configuración → Acerca de.',
      ]);
    });

    it('stays quiet on a cancel', async () => {
      const h = harness({
        messageBox: () => Promise.resolve({ response: 0 }),
        stageableAsset: () => null,
      });
      await h.updater.runUpdateCheck();
      h.banners.length = 0;
      await h.updater.applyUpdateAndReport();
      expect(h.banners).toEqual([]);
    });

    it('never rejects, even when the apply itself throws', async () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const h = harness({
        stageableAsset: () => null,
        messageBox: () => {
          throw new Error('boom');
        },
      });
      await h.updater.runUpdateCheck();
      h.banners.length = 0;
      await expect(h.updater.applyUpdateAndReport()).resolves.toBeUndefined();
      expect(h.banners).toEqual(['No se pudo actualizar: boom']);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/^\[updates\]/);
      vi.restoreAllMocks();
    });
  });

  describe('manual-install helpers', () => {
    it('copies the command and reveals the file of the current phase', async () => {
      const h = harness({
        platform: 'linux',
        isMac: false,
        stageableAsset: () => null,
        linuxInstallShape: () => Promise.resolve('other'),
        checkForUpdate: () =>
          Promise.resolve({
            ...update,
            debUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.deb',
          }),
        fetchReleaseSha256: () =>
          Promise.resolve(
            new Map([['DevBar-1.3.0-linux-arm64.deb', 'debhash']]),
          ),
        downloadsDir: () => '/home/pi/Downloads',
      });
      await h.updater.runUpdateCheck();
      await h.updater.applyUpdate();
      const file = '/home/pi/Downloads/DevBar-1.3.0-linux-arm64.deb';
      expect(h.updater.copyInstallCommand()).toEqual({ ok: true });
      expect(h.updater.showDownloadedFile()).toEqual({ ok: true });
      expect(h.calls).toContain(`copy:sudo apt install ${file}`);
      expect(h.calls).toContain(`show:${file}`);
    });

    it('has nothing to copy or show before a download', () => {
      const h = harness();
      expect(h.updater.copyInstallCommand()).toEqual({
        ok: false,
        error: 'no_command',
      });
      expect(h.updater.showDownloadedFile()).toEqual({
        ok: false,
        error: 'no_file',
      });
    });
  });
});
