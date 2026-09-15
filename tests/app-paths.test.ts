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

import { appHome, packagedAppHome } from '../src/app-paths.js';

const savedEnv: Record<string, string | undefined> = {};
const savedPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  state.isPackaged = true;
  for (const key of ['APPDATA', 'XDG_CONFIG_HOME'] as const) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ['APPDATA', 'XDG_CONFIG_HOME'] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setPlatform(savedPlatform);
});

describe('packagedAppHome', () => {
  it('pins the XDG config folder on linux', () => {
    setPlatform('linux');
    expect(packagedAppHome()).toBe(path.join(state.home, '.config', 'DevBar'));
  });

  it('honors XDG_CONFIG_HOME on linux', () => {
    setPlatform('linux');
    process.env.XDG_CONFIG_HOME = '/xdg';
    expect(packagedAppHome()).toBe(path.join('/xdg', 'DevBar'));
  });

  it('pins %APPDATA% on win32', () => {
    setPlatform('win32');
    const appdata = path.join('/u', 'AppData', 'Roaming');
    process.env.APPDATA = appdata;
    expect(packagedAppHome()).toBe(path.join(appdata, 'DevBar'));
  });

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
