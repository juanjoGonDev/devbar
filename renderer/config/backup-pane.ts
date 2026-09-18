import type { GroupStore } from './group-store.js';
import { errorMessage, type ShowToast } from './toast.js';

export interface BackupPaneDeps {
  exportBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  store: GroupStore;
  showToast: ShowToast;
  loadSettings(): Promise<boolean>;
  loadGroups(): Promise<void>;
  renderGroupDetail(): void;
  refreshPipeline(): Promise<void>;
}

export function wireBackupButtons(deps: BackupPaneDeps): void {
  const { showToast } = deps;

  deps.exportBtn.addEventListener('click', async () => {
    let res;
    try {
      res = await window.api.exportConfig();
    } catch (err) {
      showToast(`Error al exportar: ${errorMessage(err)}`, 'error');
      return;
    }
    if (res.canceled) return;
    if (res.ok) {
      showToast(`Exportado en ${res.path}`, 'ok');
    } else {
      showToast(`Error al exportar: ${res.error}`, 'error');
    }
  });

  deps.importBtn.addEventListener('click', async () => {
    let picked;
    try {
      picked = await window.api.importConfig();
    } catch (err) {
      showToast(`Error al importar: ${errorMessage(err)}`, 'error');
      return;
    }
    if (picked.canceled) return;
    if (!picked.ok) {
      showToast(`Error: ${picked.error}`, 'error');
      return;
    }

    if (!picked.preview || !picked.token) {
      showToast('Error: respuesta de importación incompleta', 'error');
      return;
    }
    let confirmed;
    try {
      confirmed = await window.api.confirmImport({ preview: picked.preview });
    } catch (err) {
      showToast(`Error al confirmar: ${errorMessage(err)}`, 'error');
      return;
    }
    if (!confirmed.confirmed) return;

    let applied;
    try {
      applied = await window.api.applyImportedConfig({ token: picked.token });
    } catch (err) {
      showToast(`Error al aplicar: ${errorMessage(err)}`, 'error');
      return;
    }
    if (!applied.ok) {
      showToast(`Error al aplicar: ${applied.error}`, 'error');
      return;
    }

    // Reload the UI to reflect the newly imported config. If the settings
    // read fails, do NOT claim the import finished: the controls are still
    // on stale values and the error toast explains the retry.
    const settingsOk = await deps.loadSettings();
    await deps.loadGroups();
    deps.store.setSelectedId(null);
    deps.renderGroupDetail();
    await deps.refreshPipeline(); // import replaces the whole pipeline wholesale
    showToast(
      settingsOk
        ? 'Configuración importada'
        : 'Importado, pero los ajustes no se cargaron — reenfoca la ventana para reintentar',
      settingsOk ? 'ok' : 'error',
    );
  });
}
