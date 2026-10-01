import { describe, expect, it } from 'vitest';
import {
  X11_OZONE_FLAG,
  describeLinuxDisplayBackend,
  runsNativeWayland,
  settleLinuxDisplayBackend,
  shouldForceX11,
  x11RelaunchOptions,
} from '../src/main/linux-display-backend.js';

/** A KDE Plasma / GNOME Wayland session with XWayland available. */
const waylandEnv = {
  XDG_SESSION_TYPE: 'wayland',
  WAYLAND_DISPLAY: 'wayland-0',
  DISPLAY: ':0',
};
const plainArgv = ['/usr/bin/devbar'];

describe('src/main/linux-display-backend.ts', () => {
  describe('shouldForceX11', () => {
    it('forces XWayland on a Linux Wayland session that has an X display', () => {
      expect(
        shouldForceX11({ platform: 'linux', env: waylandEnv, argv: plainArgv }),
      ).toBe(true);
    });

    it('treats WAYLAND_DISPLAY alone as a Wayland session', () => {
      const env = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
      expect(shouldForceX11({ platform: 'linux', env, argv: plainArgv })).toBe(
        true,
      );
    });

    it('leaves non-Linux platforms alone', () => {
      for (const platform of ['darwin', 'win32'] as const) {
        expect(
          shouldForceX11({ platform, env: waylandEnv, argv: plainArgv }),
          platform,
        ).toBe(false);
      }
    });

    it('leaves an X11 session alone', () => {
      const env = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
      expect(shouldForceX11({ platform: 'linux', env, argv: plainArgv })).toBe(
        false,
      );
    });

    it('stays on native Wayland when there is no X display (no XWayland)', () => {
      const env = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };
      expect(shouldForceX11({ platform: 'linux', env, argv: plainArgv })).toBe(
        false,
      );
    });

    it('respects any ozone platform already on the command line (no relaunch loop)', () => {
      for (const flag of [
        X11_OZONE_FLAG,
        '--ozone-platform=wayland',
        '--ozone-platform-hint=auto',
      ]) {
        expect(
          shouldForceX11({
            platform: 'linux',
            env: waylandEnv,
            argv: [...plainArgv, flag],
          }),
          flag,
        ).toBe(false);
      }
    });

    it('is skipped entirely by DEVBAR_WAYLAND_NATIVE=1', () => {
      const env = { ...waylandEnv, DEVBAR_WAYLAND_NATIVE: '1' };
      expect(shouldForceX11({ platform: 'linux', env, argv: plainArgv })).toBe(
        false,
      );
    });
  });

  describe('runsNativeWayland', () => {
    it('is true on a Wayland session without an ozone override', () => {
      expect(
        runsNativeWayland({
          platform: 'linux',
          env: waylandEnv,
          argv: plainArgv,
        }),
      ).toBe(true);
    });

    it('is false once the x11 flag is on the command line', () => {
      expect(
        runsNativeWayland({
          platform: 'linux',
          env: waylandEnv,
          argv: [...plainArgv, X11_OZONE_FLAG],
        }),
      ).toBe(false);
    });

    it('is true when wayland is requested explicitly', () => {
      expect(
        runsNativeWayland({
          platform: 'linux',
          env: waylandEnv,
          argv: [...plainArgv, '--ozone-platform=wayland'],
        }),
      ).toBe(true);
    });

    it('is false on X11 sessions and other platforms', () => {
      expect(
        runsNativeWayland({
          platform: 'linux',
          env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
          argv: plainArgv,
        }),
      ).toBe(false);
      expect(
        runsNativeWayland({
          platform: 'darwin',
          env: waylandEnv,
          argv: plainArgv,
        }),
      ).toBe(false);
    });
  });

  describe('describeLinuxDisplayBackend', () => {
    it('names XWayland forced from a Wayland session', () => {
      expect(
        describeLinuxDisplayBackend({
          platform: 'linux',
          env: waylandEnv,
          argv: [...plainArgv, X11_OZONE_FLAG],
        }),
      ).toBe('x11 (forced from wayland)');
    });

    it('names native Wayland', () => {
      expect(
        describeLinuxDisplayBackend({
          platform: 'linux',
          env: { ...waylandEnv, DEVBAR_WAYLAND_NATIVE: '1' },
          argv: plainArgv,
        }),
      ).toBe('wayland (native)');
    });

    it('names a plain X11 session', () => {
      expect(
        describeLinuxDisplayBackend({
          platform: 'linux',
          env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
          argv: [...plainArgv, X11_OZONE_FLAG],
        }),
      ).toBe('x11');
    });

    it('returns null off Linux', () => {
      expect(
        describeLinuxDisplayBackend({
          platform: 'win32',
          env: {},
          argv: plainArgv,
        }),
      ).toBeNull();
    });
  });

  describe('x11RelaunchOptions', () => {
    it('keeps the original arguments and appends the x11 flag', () => {
      expect(
        x11RelaunchOptions({
          argv: ['/opt/DevBar/devbar', '--login'],
          appImage: null,
        }),
      ).toEqual({ args: ['--login', X11_OZONE_FLAG] });
    });

    it('relaunches the AppImage file, not the binary inside its tmp mount', () => {
      expect(
        x11RelaunchOptions({
          argv: ['/tmp/.mount_DevBarAbc/devbar'],
          appImage: '/home/u/Apps/DevBar.AppImage',
        }),
      ).toEqual({
        execPath: '/home/u/Apps/DevBar.AppImage',
        args: [X11_OZONE_FLAG],
      });
    });
  });
  describe('settleLinuxDisplayBackend', () => {
    function effects(appImage: string | null = null) {
      const calls: string[] = [];
      const relaunches: unknown[] = [];
      return {
        calls,
        relaunches,
        effects: {
          relaunch: (options: unknown) => {
            calls.push('relaunch');
            relaunches.push(options);
          },
          exit: () => calls.push('exit'),
          appImagePath: () => appImage,
        },
      };
    }

    it('relaunches with the x11 flag and then exits on a bare Wayland launch', () => {
      const probe = effects();
      const result = settleLinuxDisplayBackend(
        { platform: 'linux', env: waylandEnv, argv: [...plainArgv, '--login'] },
        probe.effects,
      );
      expect(result).toBe(true);
      expect(probe.calls).toEqual(['relaunch', 'exit']);
      expect(probe.relaunches).toEqual([{ args: ['--login', X11_OZONE_FLAG] }]);
    });

    it('does nothing once the flag is present', () => {
      const probe = effects();
      const result = settleLinuxDisplayBackend(
        {
          platform: 'linux',
          env: waylandEnv,
          argv: [...plainArgv, X11_OZONE_FLAG],
        },
        probe.effects,
      );
      expect(result).toBe(false);
      expect(probe.calls).toEqual([]);
    });

    it('touches nothing off Linux', () => {
      const probe = effects();
      expect(
        settleLinuxDisplayBackend(
          { platform: 'darwin', env: waylandEnv, argv: plainArgv },
          probe.effects,
        ),
      ).toBe(false);
      expect(probe.calls).toEqual([]);
    });
  });
});
