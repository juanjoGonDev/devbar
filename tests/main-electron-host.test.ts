import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  isPackaged: false,
  dark: false,
  focused: null as {
    isDestroyed: () => boolean;
    getBounds: () => unknown;
  } | null,
  themeListeners: [] as (() => void)[],
  calls: [] as string[],
  loginItem: { wasOpenedAtLogin: true },
  emptyImage: true,
}));

vi.mock('electron', () => {
  const display = (x: number) => ({
    workArea: { x, y: 25, width: 1440, height: 875 },
    bounds: { x, y: 0, width: 1440, height: 900 },
    workAreaSize: { width: 1440, height: 875 },
  });
  return {
    app: {
      get isPackaged() {
        return electron.isPackaged;
      },
      getPath: (name: string) => `/paths/${name}`,
      getVersion: () => '1.2.0',
      quit: () => electron.calls.push('quit'),
      exit: (code: number) => electron.calls.push(`exit:${code}`),
      setLoginItemSettings: (settings: unknown) =>
        electron.calls.push(`login:${JSON.stringify(settings)}`),
      getLoginItemSettings: () => electron.loginItem,
    },
    BrowserWindow: class {
      static getFocusedWindow(): unknown {
        return electron.focused;
      }
      static fromWebContents(sender: unknown): unknown {
        return sender === 'known' ? 'owner' : null;
      }
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
        electron.calls.push('new BrowserWindow');
      }
      isDestroyed(): boolean {
        return false;
      }
      getBounds(): unknown {
        return { x: 0, y: 0, width: 100, height: 100 };
      }
    },
    dialog: {
      showMessageBox: (...args: unknown[]) => {
        electron.calls.push(`messageBox:${args.length}`);
        return Promise.resolve({ response: 0 });
      },
      showOpenDialog: (...args: unknown[]) => {
        electron.calls.push(`openDialog:${args.length}`);
        return Promise.resolve({ canceled: true, filePaths: [] });
      },
      showSaveDialog: (...args: unknown[]) => {
        electron.calls.push(`saveDialog:${args.length}`);
        return Promise.resolve({ canceled: true });
      },
    },
    nativeImage: {
      createEmpty: () => ({ empty: true, isEmpty: () => true }),
      createFromPath: () => ({ isEmpty: () => electron.emptyImage }),
    },
    nativeTheme: {
      get shouldUseDarkColors() {
        return electron.dark;
      },
      on: (_event: string, listener: () => void) =>
        electron.themeListeners.push(listener),
    },
    screen: {
      getDisplayMatching: () => display(0),
      getDisplayNearestPoint: () => display(1440),
      getCursorScreenPoint: () => ({ x: 1500, y: 100 }),
    },
    shell: {
      openExternal: (url: string) => {
        electron.calls.push(`external:${url}`);
        return Promise.resolve();
      },
      openPath: (target: string) => {
        electron.calls.push(`openPath:${target}`);
        return Promise.resolve('');
      },
    },
  };
});

const { createElectronHost } = await import('../src/main/electron-host.js');

let dir: string;

function host(overrides: { dialogOwner?: () => never } = {}) {
  return createElectronHost({
    dirname: dir,
    themePreference: () => 'auto',
    dialogOwner: overrides.dialogOwner ?? (() => null),
  });
}

describe('src/main/electron-host.ts', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-host-'));
    fs.mkdirSync(path.join(dir, '..', 'assets'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('paths', () => {
    it('resolves bundled renderer, asset and preload paths', () => {
      const h = host();
      expect(h.rendererFile('logs.html')).toBe(
        path.join(dir, '..', 'renderer', 'logs.html'),
      );
      expect(h.assetFile('icon.png')).toBe(
        path.join(dir, '..', 'assets', 'icon.png'),
      );
      expect(h.preloadPath).toBe(path.join(dir, 'preload.cjs'));
    });

    it('reports the dev panel as absent when its files did not ship', () => {
      expect(host().devPanelAvailable).toBe(false);
    });

    it('reports the dev panel as present when they did', () => {
      fs.mkdirSync(path.join(dir, 'dev'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dev', 'dev-ipc.js'), '');
      expect(host().devPanelAvailable).toBe(true);
      fs.rmSync(path.join(dir, 'dev'), { recursive: true, force: true });
    });

    it('uses Electron own logs dir in a dev run', () => {
      expect(host().logFilePath()).toBe(path.join('/paths/logs', 'app.log'));
    });

    it('serves the updates and downloads directories', () => {
      const h = host();
      expect(h.updatesDir().endsWith('updates')).toBe(true);
      expect(h.downloadsDir()).toBe('/paths/downloads');
    });
  });

  describe('displays', () => {
    it('follows the cursor when no window has focus', () => {
      expect(host().workArea().x).toBe(1440);
    });

    it('follows the focused window instead', () => {
      electron.focused = {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      };
      expect(host().workArea().x).toBe(0);
      electron.focused = null;
    });

    it('serves the work-area height of the display a rectangle sits on', () => {
      const h = host();
      const rect = { x: 0, y: 0, width: 10, height: 10 };
      expect(h.workAreaHeight(rect)).toBe(875);
      expect(h.displayMatching(rect).bounds.height).toBe(900);
    });
  });

  describe('windows and theming', () => {
    it('constructs a BrowserWindow from the options it is given', () => {
      electron.calls.length = 0;
      host().createWindow({ width: 100 });
      expect(electron.calls).toEqual(['new BrowserWindow']);
    });

    it('resolves the theme through the OS in auto mode', () => {
      expect(host().background()).toBe('#f5f5f7');
      electron.dark = true;
      expect(host().background()).toBe('#1e1e1e');
      electron.dark = false;
    });

    it('subscribes to appearance flips', () => {
      const listener = vi.fn();
      host().onThemeUpdated(listener);
      electron.themeListeners.at(-1)?.();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('falls back to an empty icon when the asset is missing', () => {
      expect(host().windowIcon()).toMatchObject({ empty: true });
    });

    it('falls back to an empty icon when the file will not decode', () => {
      fs.writeFileSync(path.join(dir, '..', 'assets', 'icon.png'), 'x');
      expect(host().windowIcon()).toMatchObject({ empty: true });
    });

    it('uses the real icon once it decodes', () => {
      electron.emptyImage = false;
      expect(host().windowIcon()).not.toMatchObject({ empty: true });
      electron.emptyImage = true;
    });
  });

  describe('confirmLogo', () => {
    it('degrades to an empty string when the asset cannot be read', () => {
      fs.rmSync(path.join(dir, '..', 'assets', 'icon.png'), { force: true });
      const h = host();
      expect(h.confirmLogo()).toBe('');
      expect(h.confirmLogo()).toBe(''); // cached
    });

    it('encodes the logo as a data URL', () => {
      fs.writeFileSync(path.join(dir, '..', 'assets', 'icon.png'), 'PNG');
      expect(host().confirmLogo()).toBe(
        `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`,
      );
    });
  });

  describe('dialogs', () => {
    it('parents a dialog on the owner window when there is one', async () => {
      electron.calls.length = 0;
      const h = host({ dialogOwner: () => 'owner' as never });
      await h.messageBox({ message: 'x' });
      await h.openDialog({});
      await h.saveDialog({});
      expect(electron.calls).toEqual([
        'messageBox:2',
        'openDialog:2',
        'saveDialog:2',
      ]);
    });

    it('opens ownerless when nothing can parent it', async () => {
      electron.calls.length = 0;
      const h = host();
      await h.messageBox({ message: 'x' });
      await h.openDialog({});
      await h.saveDialog({});
      await h.folderDialog({});
      expect(electron.calls).toEqual([
        'messageBox:1',
        'openDialog:1',
        'saveDialog:1',
        'openDialog:1',
      ]);
    });

    it('parents a dirty-close prompt on the window that asked', async () => {
      electron.calls.length = 0;
      const h = host();
      await h.messageBoxForSender('known', { message: 'x' });
      await h.messageBoxForSender('other', { message: 'x' });
      expect(electron.calls).toEqual(['messageBox:2', 'messageBox:1']);
    });
  });

  describe('files', () => {
    it('reads, writes and removes', () => {
      const h = host();
      const file = path.join(dir, 'note.txt');
      h.files.writeText(file, 'hola');
      expect(h.files.readText(file)).toBe('hola');
      h.removeFile(file);
      expect(fs.existsSync(file)).toBe(false);
      h.writeFile(file, 'again');
      expect(fs.readFileSync(file, 'utf8')).toBe('again');
      h.removeFile(file);
    });

    it('serves the updater its own file operations', () => {
      const h = host();
      const staging = path.join(dir, 'updates', '1.3.0');
      h.updaterFs.mkdirSync(staging);
      expect(h.updaterFs.readdirSync(path.join(dir, 'updates'))).toEqual([
        '1.3.0',
      ]);
      expect(h.updaterFs.isDirectory(staging)).toBe(true);
      h.updaterFs.rmSync(path.join(dir, 'updates'), {
        recursive: true,
        force: true,
      });
      expect(fs.existsSync(path.join(dir, 'updates'))).toBe(false);
    });

    it('returns null for an Info.plist it cannot read', () => {
      expect(host().updaterFs.readInstalledPlist('/nowhere')).toBeNull();
    });

    it('reads an Info.plist that is there', () => {
      const bundle = path.join(dir, 'DevBar.app');
      fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<plist/>');
      expect(host().updaterFs.readInstalledPlist(bundle)).toBe('<plist/>');
    });
  });

  describe('os integration', () => {
    it('does nothing in a dev run', () => {
      electron.calls.length = 0;
      host().applyAutostart(true);
      expect(electron.calls).toEqual([]);
    });

    it('registers the login item in a packaged build', () => {
      electron.isPackaged = true;
      electron.calls.length = 0;
      host().applyAutostart(true);
      expect(electron.calls[0]).toMatch(/^login:/);
      electron.isPackaged = false;
    });

    it('answers the login-launch question', () => {
      expect(typeof host().wasOpenedAtLogin()).toBe('boolean');
    });

    it('spawns a detached child that can be released', () => {
      const child = host().spawnDetached('devbar-nonexistent-binary', []);
      child.once('error', () => undefined);
      expect(() => child.unref()).not.toThrow();
    });
  });

  describe('app surface', () => {
    it('exposes the version, quit, exit and the shell openers', async () => {
      electron.calls.length = 0;
      const h = host();
      expect(h.appVersion()).toBe('1.2.0');
      h.appQuit();
      h.appExit(3);
      h.openExternal('https://devbar.test');
      await h.openExternalAsync('https://devbar.test/2');
      await h.openPath('/tmp/a.dmg');
      expect(electron.calls).toEqual([
        'quit',
        'exit:3',
        'external:https://devbar.test',
        'external:https://devbar.test/2',
        'openPath:/tmp/a.dmg',
      ]);
    });

    it('reports the process identity the modules branch on', () => {
      const h = host();
      expect(h.platform).toBe(process.platform);
      expect(h.arch).toBe(process.arch);
      expect(h.pid).toBe(process.pid);
      expect(typeof h.isMac).toBe('boolean');
      expect(typeof h.isLinux).toBe('boolean');
      expect(typeof h.desktop).toBe('string');
      expect(typeof h.sessionType).toBe('string');
    });
  });
});
