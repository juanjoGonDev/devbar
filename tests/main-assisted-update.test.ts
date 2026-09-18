import { describe, expect, it } from 'vitest';
import {
  runAssistedUpdate,
  type AssistedUpdateDeps,
} from '../src/main/assisted-update.js';
import type { AvailableUpdate } from '../src/domain-types.js';

const update: AvailableUpdate = {
  version: '1.3.0',
  url: 'https://github.test/releases/v1.3.0',
  dmgUrl: 'https://github.test/DevBar-1.3.0-macos-arm64.dmg',
  zipUrl: null,
  setupUrl: null,
  appImageUrl: null,
  debUrl: 'https://github.test/DevBar-1.3.0-linux-x64.deb',
};

function harness(overrides: Partial<AssistedUpdateDeps> = {}) {
  const calls: string[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const deps: AssistedUpdateDeps = {
    repo: { owner: 'o', repo: 'r' },
    platform: 'darwin',
    arch: 'arm64',
    downloadsDir: () => '/Users/me/Downloads',
    downloadFile: (_url, dest) => {
      calls.push(`download:${dest}`);
      return Promise.resolve(dest);
    },
    fetchReleaseSha256: () =>
      Promise.resolve(new Map([['DevBar-1.3.0-macos-arm64.dmg', 'hash']])),
    verifySha256: () => Promise.resolve(true),
    messageBox: () => Promise.resolve({ response: 1 }),
    openPath: () => Promise.resolve(''),
    openExternal: (url) => calls.push(`external:${url}`),
    showBannerNotification: () => calls.push('banner'),
    toast: (kind, message) => toasts.push({ kind, message }),
    markUpdateExit: () => calls.push('markUpdateExit'),
    quitAfter: (ms) => calls.push(`quit:${ms}`),
    removeFile: (target) => calls.push(`remove:${target}`),
    ...overrides,
  };
  return { deps, calls, toasts };
}

describe('src/main/assisted-update.ts', () => {
  describe('runAssistedUpdate', () => {
    it('downloads, verifies, opens the installer and quits on macOS', async () => {
      const h = harness();
      await expect(runAssistedUpdate(h.deps, update)).resolves.toEqual({
        ok: true,
        path: '/Users/me/Downloads/DevBar-1.3.0-macos-arm64.dmg',
        quitting: true,
      });
      expect(h.calls).toContain('markUpdateExit');
      expect(h.calls).toContain('quit:1200');
    });

    it('does nothing when the user declines the dialog', async () => {
      const h = harness({ messageBox: () => Promise.resolve({ response: 0 }) });
      await expect(runAssistedUpdate(h.deps, update)).resolves.toEqual({
        ok: false,
        cancelled: true,
      });
      expect(h.calls).toEqual([]);
    });

    it('reports a dialog that could not be shown', async () => {
      const h = harness({
        messageBox: () => Promise.reject(new Error('no window')),
      });
      await expect(runAssistedUpdate(h.deps, update)).resolves.toEqual({
        ok: false,
        error: 'no window',
      });
    });

    it('opens the release page when this platform has no artifact', async () => {
      const h = harness();
      await expect(
        runAssistedUpdate(h.deps, { ...update, dmgUrl: null, debUrl: null }),
      ).resolves.toEqual({ ok: true, opened: 'page' });
      expect(h.calls).toEqual([`external:${update.url}`]);
    });

    it('falls back to the release page when the download fails', async () => {
      const h = harness({
        downloadFile: () => Promise.reject(new Error('ECONNRESET')),
      });
      await expect(runAssistedUpdate(h.deps, update)).resolves.toMatchObject({
        ok: false,
        error: 'ECONNRESET',
        fellBack: true,
      });
      expect(h.toasts[0]?.kind).toBe('error');
    });

    it('deletes the artifact and falls back when the manifest is missing', async () => {
      const h = harness({ fetchReleaseSha256: () => Promise.resolve(null) });
      const result = await runAssistedUpdate(h.deps, update);
      expect(result).toMatchObject({ fellBack: true });
      expect(h.calls).toContain(
        'remove:/Users/me/Downloads/DevBar-1.3.0-macos-arm64.dmg',
      );
    });

    it('never opens an artifact whose digest does not match', async () => {
      const h = harness({ verifySha256: () => Promise.resolve(false) });
      const result = await runAssistedUpdate(h.deps, update);
      expect(result).toMatchObject({ fellBack: true });
      expect(h.toasts[0]?.message).toMatch(/Integridad/);
    });

    it('opens the release page when the macOS mount fails, rather than stranding the user', async () => {
      const h = harness({ openPath: () => Promise.resolve('no mountable') });
      await expect(runAssistedUpdate(h.deps, update)).resolves.toMatchObject({
        ok: false,
        error: 'no mountable',
        fellBack: true,
      });
      expect(h.calls).toContain(`external:${update.url}`);
      expect(h.calls).not.toContain('markUpdateExit');
    });

    it('reports a Windows installer that would not start, without opening the page', async () => {
      const h = harness({
        platform: 'win32',
        arch: 'x64',
        openPath: () => Promise.resolve('blocked'),
        fetchReleaseSha256: () =>
          Promise.resolve(
            new Map([['DevBar-1.3.0-win-x64-setup.exe', 'hash']]),
          ),
      });
      const windowsUpdate = {
        ...update,
        setupUrl: 'https://github.test/DevBar-1.3.0-win-x64-setup.exe',
      };
      await expect(
        runAssistedUpdate(h.deps, windowsUpdate),
      ).resolves.toMatchObject({ ok: false, fellBack: true });
      expect(h.calls).not.toContain(`external:${update.url}`);
    });

    it('hands a Linux package over and keeps running', async () => {
      const h = harness({
        platform: 'linux',
        arch: 'x64',
        fetchReleaseSha256: () =>
          Promise.resolve(new Map([['DevBar-1.3.0-linux-x64.deb', 'hash']])),
      });
      await expect(runAssistedUpdate(h.deps, update)).resolves.toEqual({
        ok: true,
        path: '/Users/me/Downloads/DevBar-1.3.0-linux-x64.deb',
      });
      // Deliberately NOT an update exit: the app keeps running afterwards.
      expect(h.calls).not.toContain('markUpdateExit');
      expect(h.toasts[0]?.kind).toBe('ok');
    });
  });
});
