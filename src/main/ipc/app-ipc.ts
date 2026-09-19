import type { IpcMainInvokeEvent } from 'electron';
import {
  errorMessage,
  ipcImportPreview,
  ipcRecord,
  ipcString,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';
import type { ImportPayload } from '../../config-io.js';
import type { GlobalSettings, ReleaseSummary } from '../../domain-types.js';
import type { ImportPreview, UpdateStatus } from '../../ipc-contract.js';
import type { ApplyUpdateResult } from '../assisted-update.js';

/**
 * App-level entry points: updates, configuration export/import, the icon
 * battery, the folder picker and the handful of `app:*` calls.
 *
 * The import flow is deliberately two-phase with an opaque token: the renderer
 * gets a PREVIEW of a validated payload, never the payload itself, so it cannot
 * smuggle an unvalidated one back into `config:applyImport`.
 */

type DialogProperty = 'openFile' | 'openDirectory' | 'createDirectory';

export interface AppIpcDeps {
  configStore: {
    exportConfig: () => unknown;
    replaceConfig: (payload: {
      version: number;
      groups: unknown[];
      preSteps?: unknown[];
      globalSettings: Partial<GlobalSettings>;
    }) => void;
    writeImportBackup: () => string;
    getGlobalSettings: () => GlobalSettings;
  };
  processManager: { stopAll(): Promise<{ ok: boolean; failed: string[] }> };
  configIo: {
    validateImportedConfig: (
      value: unknown,
    ) => { ok: true; payload: ImportPayload } | { ok: false; error: string };
    summarizeImport: (payload: ImportPayload) => ImportPreview;
  };
  files: {
    readText: (filePath: string) => string;
    writeText: (filePath: string, contents: string) => void;
  };
  dialogs: {
    save: (options: {
      title: string;
      defaultPath: string;
      filters: { name: string; extensions: string[] }[];
    }) => Promise<{ canceled: boolean; filePath?: string | undefined }>;
    open: (options: {
      title: string;
      properties: DialogProperty[];
      filters: { name: string; extensions: string[] }[];
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
    folder: (options: {
      title: string;
      properties: DialogProperty[];
      defaultPath?: string;
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
    message: (options: {
      type: 'question' | 'warning';
      buttons: string[];
      defaultId: number;
      cancelId: number;
      message: string;
      detail: string;
    }) => Promise<{ response: number }>;
  };
  updater: {
    status: () => UpdateStatus;
    runUpdateCheck: (options?: { manual?: boolean }) => Promise<unknown>;
    applyUpdate: () => Promise<ApplyUpdateResult>;
  };
  /** stopAll wiped every log buffer, so a stale run id must not linger. */
  snapshots: { forgetPipelineRunId(): void };
  expandTilde: (value: string) => string;
  syncRepoWatchers: () => void;
  applyAutostart: (enabled: boolean) => void;
  broadcast: () => void;
  fetchReleases: (limit: number) => Promise<ReleaseSummary[]>;
  releasesUrl: string;
  iconBattery: unknown;
  devPanelAvailable: boolean;
  appVersion: () => string;
  appQuit: () => void;
  openNotificationSettings: () => Promise<{ ok: boolean; error?: string }>;
  openExternal: (url: string) => void;
  /** Builds the GitHub issue report, copies it to the clipboard and
   *  answers the URL to open (host-provided; see src/report-issue.ts). */
  reportIssue: () => { url: string; bodyIncluded: boolean };
  setTimer?: (fn: () => void, ms: number) => unknown;
  newImportToken?: () => string;
}

const IMPORT_TTL_MS = 5 * 60 * 1000;

export function registerAppIpc(ipc: IpcRegistrar, deps: AppIpcDeps): void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const newToken =
    deps.newImportToken ??
    (() => `imp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  // Pending import payloads, keyed by opaque token.
  const pendingImports = new Map<string, ImportPayload>();

  // ── Updates ────────────────────────────────────────────────────────────
  ipc.handle('updates:status', () => deps.updater.status());
  ipc.handle('updates:check', () =>
    deps.updater.runUpdateCheck({ manual: true }),
  );
  ipc.handle('updates:apply', () => deps.updater.applyUpdate());
  // Last 5 releases for the changelog modal, plus the repo's releases page.
  ipc.handle('updates:changelog', async () => ({
    releases: await deps.fetchReleases(5),
    repoUrl: deps.releasesUrl,
  }));

  // ── Config Export / Import ────────────────────────────────────────────
  ipc.handle('config:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    let res;
    try {
      res = await deps.dialogs.save({
        title: 'Exportar configuración DevBar',
        defaultPath: `devbar-config-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      deps.files.writeText(
        res.filePath,
        JSON.stringify(deps.configStore.exportConfig(), null, 2),
      );
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipc.handle('config:import', async () => {
    let res;
    try {
      res = await deps.dialogs.open({
        title: 'Importar configuración DevBar',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const source = res.filePaths && res.filePaths[0];
    if (res.canceled || !source) return { ok: false, canceled: true };
    let raw;
    try {
      raw = deps.files.readText(source);
    } catch (err) {
      return {
        ok: false,
        error: `No se pudo leer el archivo: ${errorMessage(err)}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (_err) {
      return { ok: false, error: 'Archivo no es JSON válido' };
    }
    const v = deps.configIo.validateImportedConfig(parsed);
    if (!v.ok) return { ok: false, error: v.error };

    const token = newToken();
    pendingImports.set(token, v.payload);
    setTimer(() => pendingImports.delete(token), IMPORT_TTL_MS);
    return {
      ok: true,
      token,
      preview: deps.configIo.summarizeImport(v.payload),
      path: source,
    };
  });

  ipc.handle(
    'config:confirmImport',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const preview = ipcImportPreview(ipcRecord(payload).preview);
      const detail =
        `Esto sobreescribirá TODA tu configuración actual:\n\n` +
        `· ${preview.groupsCount} grupos\n` +
        `· ${preview.commandsCount} comandos\n` +
        `· ${preview.actionsCount} acciones\n` +
        `${preview.hasGlobalSettings ? '· ajustes globales\n' : ''}` +
        `\nSe guardará una copia en pre-import-backup.json antes de aplicar.`;
      let res;
      try {
        res = await deps.dialogs.message({
          type: 'warning',
          buttons: ['Cancelar', 'Importar'],
          defaultId: 0,
          cancelId: 0,
          message: 'Importar configuración',
          detail,
        });
      } catch (err) {
        return { confirmed: false };
      }
      return { confirmed: res.response === 1 };
    },
  );

  ipc.handle(
    'config:applyImport',
    async (_e: IpcMainInvokeEvent, rawPayload: unknown) => {
      const token = ipcStringField(rawPayload, 'token');
      const payload = pendingImports.get(token);
      if (!payload) {
        return {
          ok: false,
          error: 'La importación expiró — vuelve a seleccionar el archivo',
        };
      }
      pendingImports.delete(token);
      try {
        const backupPath = deps.configStore.writeImportBackup();
        const stopped = await deps.processManager.stopAll();
        if (!stopped.ok) {
          // Half-stopped fleet: replacing the config now would leave the
          // still-running services on the OLD config. Refuse the import.
          return {
            ok: false,
            error: `No se pudieron detener todos los servicios (${stopped.failed.join(', ')}) — la importación se canceló. Detén los servicios e inténtalo de nuevo.`,
          };
        }
        deps.snapshots.forgetPipelineRunId();
        deps.configStore.replaceConfig(payload);
        deps.syncRepoWatchers();
        deps.applyAutostart(deps.configStore.getGlobalSettings().autostart);
        deps.broadcast();
        return { ok: true, backupPath };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  );

  // ── Icons ────────────────────────────────────────────────────────────
  ipc.handle('icons:get', () => deps.iconBattery);

  // ── Folder picker ─────────────────────────────────────────────────────
  ipc.handle(
    'dialog:pickFolder',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const rawDefaultPath = ipcRecord(payload).defaultPath;
      const defaultPath =
        rawDefaultPath === undefined
          ? undefined
          : ipcString(rawDefaultPath, 'defaultPath');
      const expanded = defaultPath ? deps.expandTilde(defaultPath) : undefined;
      let res;
      try {
        res = await deps.dialogs.folder({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Selecciona una carpeta',
          ...(expanded ? { defaultPath: expanded } : {}),
        });
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
      if (res.canceled || !res.filePaths.length)
        return { ok: false, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    },
  );

  // ── App ───────────────────────────────────────────────────────────────
  // Lets the renderer decide whether to load the dev-only simulation panel.
  ipc.handle('app:isDev', () => deps.devPanelAvailable);
  ipc.handle('app:quit', () => {
    deps.appQuit();
    return { ok: true };
  });
  ipc.handle('app:version', () => deps.appVersion());
  ipc.handle('app:openNotificationSettings', () =>
    deps.openNotificationSettings(),
  );
  // One-click bug report: the host assembles the report (and copies it to
  // the clipboard); here we only route the browser and surface failures.
  ipc.handle('app:reportIssue', () => {
    try {
      const report = deps.reportIssue();
      deps.openExternal(report.url);
      return { ok: true, bodyIncluded: report.bodyIncluded };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  // Open an external https URL in the default browser. https-only guard so a
  // renderer bug can't fire arbitrary schemes (file:, javascript:, …).
  ipc.handle('app:openExternal', (_e: IpcMainInvokeEvent, url: unknown) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      deps.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });
}
