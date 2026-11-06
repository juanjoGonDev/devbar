import type { Group } from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import type { ShowToast } from './toast.js';

/**
 * «Ocultar de la barra»: folds a group into the tray's «N oculto(s)». An
 * instant write like a reorder — it never goes through the draft — so the
 * persisted flag is copied into both snapshots and the pane stays clean.
 */
export async function setHiddenInTray(
  deps: { store: GroupStore; showToast: ShowToast; repaint(): void },
  group: Group,
  hidden: boolean,
): Promise<void> {
  let saved: Group | null;
  try {
    saved = await window.api.setGroupHiddenInTray(group.id, hidden);
  } catch {
    deps.showToast('No se pudo guardar el ajuste', 'error');
    return;
  }
  if (!saved) return;
  const fresh = saved;
  deps.store.setGroups(
    deps.store
      .getGroups()
      .map((g) =>
        g.id === fresh.id ? { ...g, hiddenInTray: fresh.hiddenInTray } : g,
      ),
  );
  deps.store.syncPersistedSlice(group.id, 'hiddenInTray');
  deps.repaint();
}
