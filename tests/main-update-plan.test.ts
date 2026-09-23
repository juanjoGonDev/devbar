import { describe, expect, it } from 'vitest';
import {
  assistedUpdatePlan,
  parseBundleId,
  shouldNotifyUpdate,
  shouldStageUpdate,
} from '../src/main/update-plan.js';

const urls = {
  dmgUrl: 'https://example.test/DevBar-macos-arm64.dmg',
  setupUrl: 'https://example.test/DevBar-win-x64-setup.exe',
  debUrl: 'https://example.test/DevBar-linux-x64.deb',
  appImageUrl: 'https://example.test/DevBar-linux-x64.AppImage',
};
const none = { dmgUrl: null, setupUrl: null, debUrl: null, appImageUrl: null };

describe('src/main/update-plan.ts', () => {
  describe('parseBundleId', () => {
    it('reads the identifier out of an Info.plist', () => {
      expect(
        parseBundleId(
          '<key>CFBundleIdentifier</key>\n\t<string>dev.devbar.app</string>',
        ),
      ).toBe('dev.devbar.app');
    });

    it('returns null when the key is absent', () => {
      expect(parseBundleId('<plist><dict></dict></plist>')).toBeNull();
    });
  });

  describe('shouldStageUpdate', () => {
    const base = {
      version: '1.2.0',
      stagedVersion: null,
      stagingVersion: null,
      failedVersions: new Set<string>(),
    };

    it('stages a version nothing knows about yet', () => {
      expect(shouldStageUpdate(base)).toBe(true);
    });

    it('skips a version already staged or already downloading', () => {
      expect(shouldStageUpdate({ ...base, stagedVersion: '1.2.0' })).toBe(
        false,
      );
      expect(shouldStageUpdate({ ...base, stagingVersion: '1.2.0' })).toBe(
        false,
      );
    });

    it('does not re-pull a version that failed this session', () => {
      expect(
        shouldStageUpdate({ ...base, failedVersions: new Set(['1.2.0']) }),
      ).toBe(false);
    });

    it('still stages when a DIFFERENT version is staged or failed', () => {
      expect(shouldStageUpdate({ ...base, stagedVersion: '1.1.0' })).toBe(true);
      expect(
        shouldStageUpdate({ ...base, failedVersions: new Set(['1.1.0']) }),
      ).toBe(true);
    });
  });

  describe('shouldNotifyUpdate', () => {
    it('notifies once per launch from the automatic loop', () => {
      const input = { manual: false, configFocused: false };
      expect(shouldNotifyUpdate({ ...input, notifiedThisLaunch: false })).toBe(
        true,
      );
      expect(shouldNotifyUpdate({ ...input, notifiedThisLaunch: true })).toBe(
        false,
      );
    });

    it('always notifies on a manual check', () => {
      expect(
        shouldNotifyUpdate({
          manual: true,
          notifiedThisLaunch: true,
          configFocused: false,
        }),
      ).toBe(true);
    });

    it('stays quiet while config is focused, even on a manual check', () => {
      expect(
        shouldNotifyUpdate({
          manual: true,
          notifiedThisLaunch: false,
          configFocused: true,
        }),
      ).toBe(false);
    });
  });

  describe('assistedUpdatePlan', () => {
    it('picks the dmg and quits on macOS, falling back to the page on a mount failure', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, dmgUrl: urls.dmgUrl },
        platform: 'darwin',
        arch: 'arm64',
      });
      expect(plan.downloadUrl).toBe(urls.dmgUrl);
      expect(plan.destName).toBe('DevBar-1.2.0-macos-arm64.dmg');
      expect(plan.postDownload).toBe('open-and-quit-with-page-fallback');
      expect(plan.buttons).toEqual(['Cancelar', 'Descargar y cerrar']);
    });

    it('picks the NSIS installer and quits on Windows', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, setupUrl: urls.setupUrl },
        platform: 'win32',
        arch: 'x64',
      });
      expect(plan.destName).toBe('DevBar-1.2.0-win-x64-setup.exe');
      expect(plan.postDownload).toBe('open-and-quit');
    });

    it('never hands the Windows installer to Linux', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, setupUrl: urls.setupUrl, debUrl: urls.debUrl },
        platform: 'linux',
        arch: 'x64',
      });
      expect(plan.downloadUrl).toBe(urls.debUrl);
      expect(plan.postDownload).toBe('hand-off');
    });

    it('prefers the .deb over the AppImage on Linux', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, debUrl: urls.debUrl, appImageUrl: urls.appImageUrl },
        platform: 'linux',
        arch: 'x64',
      });
      expect(plan.destName).toBe('DevBar-1.2.0-linux-x64.deb');
    });

    it('falls back to the AppImage and explains where it landed', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, appImageUrl: urls.appImageUrl },
        platform: 'linux',
        arch: 'x64',
      });
      expect(plan.destName).toBe('DevBar-1.2.0-linux-x64.AppImage');
      expect(plan.detail).toMatch(/AppImage a Descargas/);
    });

    it('names a 32-bit ARM artifact the way the release does', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, debUrl: urls.debUrl },
        platform: 'linux',
        arch: 'arm',
      });
      expect(plan.destName).toBe('DevBar-1.2.0-linux-armv7.deb');
    });

    it('never offers Windows a Linux package when the installer is missing', () => {
      // `!isMac` let Windows fall into the Linux branch, so a release that
      // published no setup.exe (a partial release, or a future arch) handed a
      // Windows user a .deb and told them to install it. The mirror of the
      // guard the Windows branch already carries.
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, debUrl: urls.debUrl, appImageUrl: urls.appImageUrl },
        platform: 'win32',
        arch: 'x64',
      });
      expect(plan.downloadUrl).toBeNull();
      expect(plan.postDownload).toBe('hand-off');
    });

    it('offers the release page when this platform has no artifact', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: none,
        platform: 'darwin',
        arch: 'arm64',
      });
      expect(plan.downloadUrl).toBeNull();
      expect(plan.destName).toBe('');
      expect(plan.buttons).toEqual(['Cancelar', 'Descargar']);
    });

    it('offers the release page on macOS without a dmg, never the deb', () => {
      const plan = assistedUpdatePlan({
        version: '1.2.0',
        update: { ...none, debUrl: urls.debUrl },
        platform: 'darwin',
        arch: 'arm64',
      });
      expect(plan.downloadUrl).toBeNull();
    });
  });
});
