import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// app-paths imports electron for app.isPackaged / app.getPath. The state is
// hoisted so the mock factory (evaluated before imports) can read it.
const state = vi.hoisted(() => ({
  isPackaged: true,
  home: '/home/u',
  userData: '/home/u/.config/devbar',
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: (name: string) =>
      name === 'home'
        ? state.home
        : name === 'userData'
          ? state.userData
          : `/mock/${name}`,
  },
}));

import fs from 'node:fs';
import os from 'node:os';

import {
  appHome,
  legacyLinuxConfigFile,
  migrateLegacyLinuxStore,
  packagedAppHome,
} from '../src/app-paths.js';

const savedEnv: Record<string, string | undefined> = {};
const savedPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('src/app-paths.ts', () => {
  beforeEach(() => {
    state.isPackaged = true;
    for (const key of ['APPDATA', 'XDG_CONFIG_HOME'] as const) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ['APPDATA', 'XDG_CONFIG_HOME'] as const) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setPlatform(savedPlatform);
  });

  describe('packagedAppHome', () => {
    it('pins the XDG config folder on linux', () => {
      setPlatform('linux');
      expect(packagedAppHome()).toBe(
        path.join(state.home, '.config', 'DevBar'),
      );
    });

    it('honors XDG_CONFIG_HOME on linux', () => {
      setPlatform('linux');
      process.env.XDG_CONFIG_HOME = '/xdg';
      expect(packagedAppHome()).toBe(path.join('/xdg', 'DevBar'));
    });

    // appHome() feeds the config store, the log dir, the update staging dir
    // and the directory the generated swap script is written to and RUN
    // from, so a non-absolute value must never be honored: it would resolve
    // against whatever CWD the app inherited. The XDG spec requires
    // absolute values anyway.
    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['relative', 'relative/path'],
      ['bare dot', '.'],
    ])('ignores a %s XDG_CONFIG_HOME and uses ~/.config', (_label, value) => {
      setPlatform('linux');
      process.env.XDG_CONFIG_HOME = value;
      expect(packagedAppHome()).toBe(
        path.join(state.home, '.config', 'DevBar'),
      );
    });

    it('pins %APPDATA% on win32', () => {
      setPlatform('win32');
      const appdata = path.join('/u', 'AppData', 'Roaming');
      process.env.APPDATA = appdata;
      expect(packagedAppHome()).toBe(path.join(appdata, 'DevBar'));
    });

    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['relative', 'relative\\path'],
    ])(
      'ignores a %s APPDATA and uses the home-relative AppData',
      (_label, value) => {
        setPlatform('win32');
        process.env.APPDATA = value;
        expect(packagedAppHome()).toBe(
          path.join(state.home, 'AppData', 'Roaming', 'DevBar'),
        );
      },
    );

    it('falls back to the home-relative AppData on win32', () => {
      setPlatform('win32');
      expect(packagedAppHome()).toBe(
        path.join(state.home, 'AppData', 'Roaming', 'DevBar'),
      );
    });

    it('pins the Application Support folder on darwin', () => {
      setPlatform('darwin');
      expect(packagedAppHome()).toBe(
        path.join(state.home, 'Library', 'Application Support', 'DevBar'),
      );
    });

    it('returns undefined in dev mode so Electron defaults apply', () => {
      setPlatform('linux');
      state.isPackaged = false;
      expect(packagedAppHome()).toBeUndefined();
    });
  });

  describe('appHome', () => {
    it('keeps Electron userData in dev mode', () => {
      setPlatform('linux');
      state.isPackaged = false;
      expect(appHome()).toBe(state.userData);
    });

    it('uses the pinned folder in packaged builds', () => {
      setPlatform('linux');
      expect(appHome()).toBe(path.join(state.home, '.config', 'DevBar'));
    });
  });

  describe('legacyLinuxConfigFile', () => {
    it('points at the lowercase package-name folder under the default XDG', () => {
      expect(legacyLinuxConfigFile('/home/u', undefined)).toBe(
        path.join('/home/u', '.config', 'devbar', 'config.json'),
      );
    });

    it('honors XDG_CONFIG_HOME', () => {
      expect(legacyLinuxConfigFile('/home/u', '/custom/xdg')).toBe(
        path.join('/custom/xdg', 'devbar', 'config.json'),
      );
    });
  });

  describe('migrateLegacyLinuxStore', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-migrate-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeLegacy(config: string, content: string): string {
      const legacy = path.join(config, 'devbar', 'config.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, content);
      return legacy;
    }

    it('moves the legacy config into the new store dir', () => {
      const config = path.join(dir, 'xdg');
      const newDir = path.join(dir, 'DevBar');
      writeLegacy(config, '{\"version\":3}');
      expect(migrateLegacyLinuxStore(newDir, dir, config)).toBe('moved');
      expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe(
        '{\"version\":3}',
      );
      expect(fs.existsSync(path.join(config, 'devbar', 'config.json'))).toBe(
        false,
      );
    });

    it('skips when there is no legacy file or the target already exists', () => {
      const config = path.join(dir, 'xdg');
      const newDir = path.join(dir, 'DevBar');
      expect(migrateLegacyLinuxStore(newDir, dir, config)).toBe('skipped');
      writeLegacy(config, '{\"version\":2}');
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(path.join(newDir, 'config.json'), '{\"version\":4}');
      expect(migrateLegacyLinuxStore(newDir, dir, config)).toBe('skipped');
      // the user data in the NEW location is never overwritten
      expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe(
        '{\"version\":4}',
      );
    });

    it('never replaces a target that appeared after the existence check', () => {
      const config = path.join(dir, 'xdg');
      const newDir = path.join(dir, 'DevBar');
      const legacy = writeLegacy(config, '{\"version\":2}');
      const target = path.join(newDir, 'config.json');
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(target, '{\"version\":4}');
      // The race the primary path must survive: a newer instance created
      // the target between the pre-flight existsSync and the move.
      // renameSync would have replaced it silently; linkSync fails EEXIST.
      const realExists = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
        p === target ? false : realExists(p),
      );

      expect(migrateLegacyLinuxStore(newDir, dir, config)).toBe('skipped');
      expect(fs.readFileSync(target, 'utf8')).toBe('{\"version\":4}');
      expect(fs.readFileSync(legacy, 'utf8')).toBe('{\"version\":2}');
    });

    it('skips without deleting legacy data when the target wins a creation race', () => {
      const config = path.join(dir, 'xdg');
      const newDir = path.join(dir, 'DevBar');
      const legacy = writeLegacy(config, '{\"version\":2}');
      const target = path.join(newDir, 'config.json');
      // Force the copy path (link is the atomic same-device preference).
      const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      });
      const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
        fs.writeFileSync(target, '{\"version\":4}');
        throw Object.assign(new Error('target exists'), { code: 'EEXIST' });
      });

      expect(migrateLegacyLinuxStore(newDir, dir, config)).toBe('skipped');
      expect(link).toHaveBeenCalledWith(legacy, target);
      expect(copy).toHaveBeenCalledWith(
        legacy,
        target,
        fs.constants.COPYFILE_EXCL,
      );
      expect(fs.readFileSync(target, 'utf8')).toBe('{\"version\":4}');
      expect(fs.readFileSync(legacy, 'utf8')).toBe('{\"version\":2}');
    });
  });
});
