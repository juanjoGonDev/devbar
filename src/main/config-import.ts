import type { CustomIcon, GlobalSettings } from '../domain-types.js';
import type { ImportPayload } from '../config-io.js';
import { errorMessage } from './ipc-validators.js';

/**
 * Replacing the whole configuration with a validated one: back the current
 * one up, stop every service (a half-stopped fleet refuses the import), cancel
 * every workflow run, write, and refresh what depends on the config. One path
 * for the «Importar» of Settings and for an assistant's `import_config`, so
 * neither can skip a step.
 */

export interface ConfigImportDeps {
  configStore: {
    replaceConfig: (payload: {
      version: number;
      groups: unknown[];
      workflows?: unknown;
      globalSettings: Partial<GlobalSettings>;
      customIcons?: readonly CustomIcon[];
    }) => void;
    writeImportBackup: () => string;
    getGlobalSettings: () => GlobalSettings;
    groupsOverlayActive: () => boolean;
  };
  processManager: { stopAll(): Promise<{ ok: boolean; failed: string[] }> };
  workflowRunner: { cancelAll(): void };
  syncRepoWatchers: () => void;
  applyAutostart: (enabled: boolean) => void;
  broadcast: () => void;
}

export type ConfigImportResult =
  { ok: true; backupPath: string } | { ok: false; error: string };

export async function applyConfigImport(
  deps: ConfigImportDeps,
  payload: ImportPayload,
): Promise<ConfigImportResult> {
  // Checked before anything is stopped: the user's real services keep
  // running underneath the dev panel's test groups.
  if (deps.configStore.groupsOverlayActive())
    return {
      ok: false,
      error:
        'Modo grupos de prueba activo: quita los grupos de prueba en el panel Dev antes de importar.',
    };
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
    deps.workflowRunner.cancelAll();
    deps.configStore.replaceConfig(payload);
    deps.syncRepoWatchers();
    deps.applyAutostart(deps.configStore.getGlobalSettings().autostart);
    deps.broadcast();
    return { ok: true, backupPath };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
