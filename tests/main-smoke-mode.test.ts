import { describe, expect, it, vi } from 'vitest';
import {
  isSmokeMode,
  runSmokeMode,
  smokeArtifactKind,
  smokeFlags,
  type SmokeModeDeps,
} from '../src/main/smoke-mode.js';

function harness(overrides: Partial<SmokeModeDeps> = {}) {
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  const markers: string[] = [];
  let trayDestroyed = false;
  const deps: SmokeModeDeps = {
    argv: [],
    env: {},
    platform: 'darwin',
    pid: 4242,
    version: () => '1.2.0',
    removeMarker: () => calls.push('removeMarker'),
    writeMarker: (contents) => markers.push(contents),
    createTray: () => {
      calls.push('createTray');
      return { isDestroyed: () => trayDestroyed };
    },
    installedAppPath: () => '/Applications/DevBar.app',
    updatesDir: () => '/home/updates',
    verifySha256: () => Promise.resolve(true),
    stageDownloadedArtifact: (input) => {
      calls.push(`stage:${input.kind}:${input.destDir}`);
      return Promise.resolve({ version: input.version, appPath: '/staged' });
    },
    spawnSwap: (input) => calls.push(`swap:${input.relaunchArgs?.join(',')}`),
    exit: (code) => calls.push(`exit:${code}`),
    setTimer: (fn) => timers.push(fn),
    ...overrides,
  };
  return {
    deps,
    calls,
    timers,
    markers,
    killTray: () => {
      trayDestroyed = true;
    },
  };
}

describe('src/main/smoke-mode.ts', () => {
  describe('isSmokeMode', () => {
    it('reads either the flag or the environment variable', () => {
      expect(isSmokeMode(['--devbar-smoke'], {})).toBe(true);
      expect(isSmokeMode([], { DEVBAR_SMOKE: '1' })).toBe(true);
      expect(isSmokeMode([], { DEVBAR_SMOKE: '0' })).toBe(false);
      expect(isSmokeMode([], {})).toBe(false);
    });
  });

  describe('smokeFlags', () => {
    it('reads hold from either source and update from the environment', () => {
      expect(smokeFlags(['--devbar-smoke-hold'], {})).toEqual({
        hold: true,
        update: false,
      });
      expect(
        smokeFlags([], { DEVBAR_SMOKE_HOLD: '1', DEVBAR_SMOKE_UPDATE: '1' }),
      ).toEqual({ hold: true, update: true });
      expect(smokeFlags([], {})).toEqual({ hold: false, update: false });
    });
  });

  describe('smokeArtifactKind', () => {
    it('picks the platform staging shape', () => {
      expect(smokeArtifactKind('darwin', '/Applications/DevBar.app')).toBe(
        'macBundle',
      );
      expect(smokeArtifactKind('linux', '/opt/DevBar.AppImage')).toBe(
        'appImage',
      );
    });

    it('splits Windows by install shape', () => {
      const portable = smokeArtifactKind(
        'win32',
        'D:\\Tools\\DevBar\\DevBar.exe',
      );
      expect(['winInstaller', 'winPortable']).toContain(portable);
    });
  });

  describe('runSmokeMode', () => {
    it('clears a stale marker, owns a tray, then writes the marker and exits', () => {
      const h = harness();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      expect(h.calls).toEqual(['removeMarker', 'createTray']);
      h.timers[0]?.();
      expect(h.markers[0]).toBe('DEVBAR_SMOKE_OK darwin 1.2.0\n');
      expect(log).toHaveBeenCalledWith('DEVBAR_SMOKE_OK');
      expect(h.calls).toContain('exit:0');
      log.mockRestore();
    });

    it('fails when the stale marker cannot be removed', () => {
      const h = harness({
        removeMarker: () => {
          throw new Error('locked');
        },
      });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      expect(h.calls).toEqual(['exit:1']);
      expect(error).toHaveBeenCalledWith(
        'DEVBAR_SMOKE_MARKER_CLEANUP_FAILED:',
        expect.any(Error),
      );
      error.mockRestore();
    });

    it('fails when the platform refuses a tray', () => {
      const h = harness({
        createTray: () => {
          throw new Error('no display');
        },
      });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      expect(h.calls).toEqual(['removeMarker', 'exit:1']);
      error.mockRestore();
    });

    it('fails when the tray did not survive the wait', () => {
      const h = harness();
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      h.killTray();
      h.timers[0]?.();
      expect(error).toHaveBeenCalledWith('DEVBAR_SMOKE_TRAY_GONE');
      expect(h.calls).toContain('exit:1');
      expect(h.markers).toEqual([]);
      error.mockRestore();
    });

    it('still reports success when the marker file cannot be written', () => {
      const h = harness({
        writeMarker: () => {
          throw new Error('read-only');
        },
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      h.timers[0]?.();
      expect(log).toHaveBeenCalledWith('DEVBAR_SMOKE_OK');
      expect(h.calls).toContain('exit:0');
      log.mockRestore();
    });

    it('stays resident in hold mode and prints its pid', () => {
      const h = harness({ argv: ['--devbar-smoke-hold'] });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      h.timers[0]?.();
      expect(log).toHaveBeenCalledWith('DEVBAR_SMOKE_HOLDING 4242');
      expect(h.calls).not.toContain('exit:0');
      log.mockRestore();
    });
  });

  describe('runSmokeMode update phase', () => {
    const updateEnv = {
      DEVBAR_SMOKE_UPDATE: '1',
      DEVBAR_SMOKE_ARTIFACT: '/tmp/DevBar.zip',
      DEVBAR_SMOKE_SHA: 'abc',
      DEVBAR_SMOKE_VERSION: '1.3.0',
    };

    it('stages the local artifact and hands the swap off, without a tray', async () => {
      const h = harness({ env: updateEnv });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      await vi.waitFor(() => expect(h.calls).toContain('exit:0'));
      expect(h.calls).not.toContain('createTray');
      expect(h.calls).toContain('stage:macBundle:/home/updates/1.3.0');
      expect(h.calls).toContain('swap:--devbar-smoke');
      expect(log).toHaveBeenCalledWith('DEVBAR_SMOKE_UPDATE_HANDOFF 1.3.0');
      log.mockRestore();
    });

    it('refuses an incomplete environment', () => {
      const h = harness({ env: { DEVBAR_SMOKE_UPDATE: '1' } });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      expect(error).toHaveBeenCalledWith(
        'DEVBAR_SMOKE_UPDATE_FAILED missing DEVBAR_SMOKE_ARTIFACT/_SHA/_VERSION',
      );
      expect(h.calls).toContain('exit:1');
      error.mockRestore();
    });

    it('refuses to swap a build that is not installed anywhere', () => {
      const h = harness({ env: updateEnv, installedAppPath: () => null });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      expect(error).toHaveBeenCalledWith(
        'DEVBAR_SMOKE_UPDATE_FAILED not running from an installed location',
      );
      error.mockRestore();
    });

    it('refuses an artifact whose hash does not match', async () => {
      const h = harness({
        env: updateEnv,
        verifySha256: () => Promise.resolve(false),
      });
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      runSmokeMode(h.deps);
      await vi.waitFor(() => expect(h.calls).toContain('exit:1'));
      expect(error).toHaveBeenCalledWith(
        'DEVBAR_SMOKE_UPDATE_FAILED el hash del artefacto no coincide',
      );
      error.mockRestore();
    });
  });
});
