import { describe, expect, it, vi } from 'vitest';
import {
  applyAutostart,
  wasOpenedAtLogin,
  type AutostartHost,
} from '../src/main/os-integration.js';
import { LOGIN_ARG } from '../src/autostart.js';

function host(overrides: Partial<AutostartHost> = {}) {
  const loginItems: unknown[] = [];
  const linux: { execPath: string; enabled: boolean }[] = [];
  const base: AutostartHost = {
    isPackaged: true,
    isMac: false,
    isWin: false,
    setLoginItemSettings: (settings) => loginItems.push(settings),
    setLinuxAutostart: (execPath, enabled) => linux.push({ execPath, enabled }),
    installedAppPath: () => null,
    execPath: '/usr/bin/devbar',
    ...overrides,
  };
  return { base, loginItems, linux };
}

describe('src/main/os-integration.ts', () => {
  describe('applyAutostart', () => {
    it('is a no-op in a dev run, whose entry would boot a bare Electron', () => {
      const h = host({ isPackaged: false, isMac: true });
      applyAutostart(h.base, true);
      expect(h.loginItems).toEqual([]);
    });

    it('asks macOS to open hidden at login', () => {
      const h = host({ isMac: true });
      applyAutostart(h.base, true);
      expect(h.loginItems).toEqual([{ openAtLogin: true, openAsHidden: true }]);
    });

    it('passes the boot signal argument on Windows, and clears it when off', () => {
      const h = host({ isWin: true });
      applyAutostart(h.base, true);
      applyAutostart(h.base, false);
      expect(h.loginItems).toEqual([
        { openAtLogin: true, args: [LOGIN_ARG] },
        { openAtLogin: false, args: [] },
      ]);
    });

    it('points the Linux entry at the persistent AppImage, not the mount', () => {
      const h = host({ installedAppPath: () => '/opt/DevBar.AppImage' });
      applyAutostart(h.base, true);
      expect(h.linux).toEqual([
        { execPath: '/opt/DevBar.AppImage', enabled: true },
      ]);
    });

    it('falls back to execPath for a .deb install', () => {
      const h = host();
      applyAutostart(h.base, true);
      expect(h.linux[0]?.execPath).toBe('/usr/bin/devbar');
    });

    it('never lets an OS refusal escape', () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const h = host({
        isMac: true,
        setLoginItemSettings: () => {
          throw new Error('denied');
        },
      });
      expect(() => applyAutostart(h.base, true)).not.toThrow();
      expect(error).toHaveBeenCalledWith(
        'Failed to set login item:',
        expect.any(Error),
      );
      error.mockRestore();
    });
  });

  describe('wasOpenedAtLogin', () => {
    it('asks macOS directly', () => {
      const argv = vi.fn(() => true);
      expect(
        wasOpenedAtLogin({
          isMac: true,
          loginItemWasOpenedAtLogin: () => true,
          openedAtLoginFromArgv: argv,
        }),
      ).toBe(true);
      expect(argv).not.toHaveBeenCalled();
    });

    it('reads the --login argument everywhere else', () => {
      const native = vi.fn(() => true);
      expect(
        wasOpenedAtLogin({
          isMac: false,
          loginItemWasOpenedAtLogin: native,
          openedAtLoginFromArgv: () => false,
        }),
      ).toBe(false);
      expect(native).not.toHaveBeenCalled();
    });
  });
});
