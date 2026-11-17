import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, nativeImage, type IpcMainInvokeEvent } from 'electron';
import { validateImportedConfig } from '../../config-io.js';
import { applyConfigImport, type ConfigImportDeps } from '../config-import.js';
import type { IpcRegistrar } from '../ipc-validators.js';
import type { ConfigSnapshot, McpConfigPort } from './config-changes.js';

/**
 * What the MCP config tools reach the app through, made of the real things:
 * the app's own IPC handlers (tapped as main registers them, so a tool's
 * write runs the exact handler Settings does), the import path Settings
 * uses, backups on disk (owner-only, kept 30 days) and Electron's image
 * decoding — with SVGs drawn by a hidden, sandboxed window, as the config
 * window draws an uploaded one.
 */

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface IpcTap {
  /** Registers on `ipc` and keeps a copy of every handler. */
  tap: (ipc: IpcRegistrar) => IpcRegistrar;
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

export function createIpcTap(): IpcTap {
  const handlers = new Map<string, Handler>();
  return {
    tap: (ipc) => ({
      handle: (channel, listener) => {
        handlers.set(channel, listener);
        ipc.handle(channel, listener);
      },
    }),
    invoke: async (channel, payload) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No hay ningún manejador para ${channel}`);
      // No renderer is behind an MCP call: there is no sender to answer.
      return await handler(
        { sender: null } as unknown as IpcMainInvokeEvent,
        payload,
      );
    },
  };
}

export interface ConfigPortWiring extends Omit<
  ConfigImportDeps,
  'configStore'
> {
  home: string;
  invoke: IpcTap['invoke'];
  configStore: ConfigImportDeps['configStore'] & {
    exportConfig(): unknown;
    configSnapshot(): ConfigSnapshot;
  };
}

/** Drawn in a hidden sandboxed page: an `<img>` cannot run an SVG's script. */
export function rasterizeScript(svg: string, size: number): string {
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return `new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const s = ${size};
    const w0 = img.naturalWidth || s, h0 = img.naturalHeight || s;
    const r = Math.min(s / w0, s / h0, 1) || 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * r));
    c.height = Math.max(1, Math.round(h0 * r));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    resolve(c.toDataURL('image/png'));
  };
  img.onerror = () => resolve(null);
  img.src = ${JSON.stringify(source)};
})`;
}

async function rasterizeSvg(svg: string, size: number): Promise<Buffer | null> {
  const window = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadURL('about:blank');
    const dataUrl: unknown = await window.webContents.executeJavaScript(
      rasterizeScript(svg, size),
    );
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png'))
      return null;
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } catch {
    return null;
  } finally {
    window.destroy();
  }
}

/** Drops backups older than the audit log keeps their undo tokens. */
export function pruneBackups(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > BACKUP_RETENTION_MS)
        fs.rmSync(file);
    } catch {
      // A file that vanished meanwhile is as good as pruned.
    }
  }
}

export function electronConfigPort(wiring: ConfigPortWiring): McpConfigPort {
  const dir = path.join(wiring.home, 'backups');
  const file = (token: string): string => {
    if (!TOKEN.test(token)) throw new Error('Token de copia no válido');
    return path.join(dir, `${token}.json`);
  };
  pruneBackups(dir, Date.now());
  return {
    invoke: wiring.invoke,
    exportConfig: () => wiring.configStore.exportConfig(),
    importConfig: async (value) => {
      const validation = validateImportedConfig(value);
      if (!validation.ok) return validation;
      return applyConfigImport(wiring, validation.payload);
    },
    snapshot: () => wiring.configStore.configSnapshot(),
    writeBackup: (token, record) => {
      fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
      fs.writeFileSync(file(token), JSON.stringify(record), {
        mode: OWNER_ONLY_FILE,
      });
    },
    readBackup: (token) => {
      try {
        return JSON.parse(fs.readFileSync(file(token), 'utf8')) as ReturnType<
          McpConfigPort['readBackup']
        >;
      } catch {
        return null;
      }
    },
    newToken: () => randomBytes(18).toString('base64url'),
    decodeImage: (bytes) => nativeImage.createFromBuffer(bytes),
    rasterizeSvg,
  };
}
