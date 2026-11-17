import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ElectronFake {
  windows: { options: unknown; destroyed: boolean; script: string }[];
  answer: string | null;
}

const electron = vi.hoisted((): ElectronFake => ({
  windows: [],
  answer: `data:image/png;base64,${Buffer.from('drawn').toString('base64')}`,
}));

vi.mock('electron', () => {
  class BrowserWindow {
    record: { options: unknown; destroyed: boolean; script: string };
    webContents = {
      executeJavaScript: (script: string) => {
        this.record.script = script;
        return Promise.resolve(electron.answer);
      },
    };
    constructor(options: unknown) {
      this.record = { options, destroyed: false, script: '' };
      electron.windows.push(this.record);
    }
    loadURL() {
      return Promise.resolve();
    }
    destroy() {
      this.record.destroyed = true;
    }
  }
  const nativeImage = {
    createFromBuffer: (bytes: Buffer) => ({ size: bytes.length }),
  };
  return {
    BrowserWindow,
    nativeImage,
    default: { BrowserWindow, nativeImage },
  };
});

import {
  createIpcTap,
  electronConfigPort,
  pruneBackups,
  rasterizeScript,
  type ConfigPortWiring,
} from '../src/main/mcp/config-port-wiring.js';

const dirs: string[] = [];
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-mcp-port-'));
  dirs.push(dir);
  return dir;
}

function wiring(
  overrides: Partial<ConfigPortWiring> = {},
): ConfigPortWiring & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    home: home(),
    invoke: (channel) => {
      calls.push(channel);
      return Promise.resolve({ ok: true });
    },
    configStore: {
      replaceConfig: () => calls.push('replace'),
      writeImportBackup: () => '/pre-import-backup.json',
      getGlobalSettings: () => ({ autostart: false }) as never,
      groupsOverlayActive: () => false,
      exportConfig: () => ({ exported: true }),
      configSnapshot: () => ({ groups: [] }) as never,
    },
    processManager: {
      stopAll: () => Promise.resolve({ ok: true, failed: [] }),
    },
    workflowRunner: { cancelAll: () => calls.push('cancelAll') },
    syncRepoWatchers: () => calls.push('sync'),
    applyAutostart: () => calls.push('autostart'),
    broadcast: () => calls.push('broadcast'),
    ...overrides,
  };
}

describe('src/main/mcp/config-port-wiring.ts', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
    electron.windows.length = 0;
  });

  describe('createIpcTap', () => {
    it('registers every handler on ipcMain and can call it in process', async () => {
      const registered: string[] = [];
      const tap = createIpcTap();
      const ipc = tap.tap({ handle: (channel) => registered.push(channel) });

      ipc.handle('groups:save', (_event, payload) => ({ saved: payload }));

      expect(registered).toEqual(['groups:save']);
      await expect(tap.invoke('groups:save', { id: 'g' })).resolves.toEqual({
        saved: { id: 'g' },
      });
      await expect(tap.invoke('nope', null)).rejects.toThrow('nope');
    });
  });

  describe('electronConfigPort', () => {
    it('writes backups owner-only and reads them back', () => {
      const w = wiring();
      const port = electronConfigPort(w);
      const record = {
        slice: { kind: 'all' as const },
        snapshot: port.snapshot(),
      };

      port.writeBackup('abcdefgh12', record);

      expect(port.readBackup('abcdefgh12')).toEqual(record);
      const file = path.join(w.home, 'backups', 'abcdefgh12.json');
      if (process.platform !== 'win32')
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(port.readBackup('missing-token')).toBeNull();
    });

    it('refuses a token that could be a path', () => {
      const port = electronConfigPort(wiring());

      expect(() =>
        port.writeBackup('../../etc', {
          slice: { kind: 'all' },
          snapshot: port.snapshot(),
        }),
      ).toThrow();
      expect(port.readBackup('../x')).toBeNull();
      expect(port.newToken()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });

    it('validates an import like a file, then replaces everything', async () => {
      const w = wiring();
      const port = electronConfigPort(w);

      await expect(port.importConfig({ version: 1 })).resolves.toMatchObject({
        ok: false,
      });
      await expect(
        port.importConfig({ version: 4, groups: [] }),
      ).resolves.toEqual({
        ok: true,
        backupPath: '/pre-import-backup.json',
      });
      expect(w.calls).toEqual([
        'cancelAll',
        'replace',
        'sync',
        'autostart',
        'broadcast',
      ]);
    });

    it('exports, snapshots and decodes through the app', () => {
      const port = electronConfigPort(wiring());

      expect(port.exportConfig()).toEqual({ exported: true });
      expect(port.decodeImage(Buffer.from('abc'))).toEqual({ size: 3 });
    });

    it('draws an SVG in a hidden sandboxed window and closes it', async () => {
      const port = electronConfigPort(wiring());

      const png = await port.rasterizeSvg('<svg/>', 64);

      expect(png?.toString()).toBe('drawn');
      expect(electron.windows[0]).toMatchObject({
        destroyed: true,
        options: {
          show: false,
          webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      });
      expect(electron.windows[0]?.script).toContain(
        'data:image/svg+xml;base64,',
      );
    });

    it('answers null when the page could not draw it', async () => {
      electron.answer = null;
      const port = electronConfigPort(wiring());

      expect(await port.rasterizeSvg('<svg/>', 64)).toBeNull();
      expect(electron.windows[0]?.destroyed).toBe(true);
    });
  });

  it('builds a drawing script that never inlines the SVG as markup', () => {
    const script = rasterizeScript('<svg onload="alert(1)"/>', 32);

    expect(script).not.toContain('onload="alert');
    expect(script).toContain('const s = 32;');
  });

  it('prunes backups older than 30 days', () => {
    const dir = home();
    fs.writeFileSync(path.join(dir, 'old.json'), '{}');
    fs.writeFileSync(path.join(dir, 'new.json'), '{}');
    const old = Date.now() / 1000 - 31 * 24 * 3600;
    fs.utimesSync(path.join(dir, 'old.json'), old, old);

    pruneBackups(dir, Date.now());
    pruneBackups(path.join(dir, 'missing'), Date.now());

    expect(fs.readdirSync(dir)).toEqual(['new.json']);
  });
});
