import { buildGroupHeader, type GroupHeader } from './group-header.js';
import { duplicateOf } from './group-copy.js';
import {
  buildGroupSettingsTab,
  type GroupSettingsTab,
} from './group-settings-tab.js';
import { buildGroupTabs, type GroupTabId } from './group-tabs.js';
import type { DeviceMenu } from './remote-device-menu.js';
import type { GroupRuntime } from './group-runtime.js';
import { buildEnvEditor, type EnvSectionElement } from './env-editor.js';
import { setHiddenInTray } from './group-visibility.js';
import type { Group } from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import type { SubLists } from './sub-lists.js';
import { errorMessage, type ShowToast } from './toast.js';

export interface GroupDetailDeps {
  /** The right pane (`#group-detail`). */
  detailEl: HTMLElement;
  store: GroupStore;
  runtime: GroupRuntime;
  /** The one «⋯» menu of the pane, shared with its lists. */
  menu: DeviceMenu;
  showToast: ShowToast;
  subLists: SubLists;
  openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (value: string) => void,
  ): void;
  loadGroups(): Promise<void>;
  renderGroupsList(): void;
  refreshPipeline(): Promise<void>;
}

export interface GroupDetail {
  render(): void;
  /** Repaints only what main reports live, leaving any edit in progress. */
  refreshRuntime(): void;
}

export function createGroupDetail(deps: GroupDetailDeps): GroupDetail {
  const { store } = deps;
  const { menu } = deps;
  let header: GroupHeader | null = null;
  let settingsTab: GroupSettingsTab | null = null;
  /** The open tab, kept across groups and repaints while the window lives. */
  let activeTab: GroupTabId = 'processes';

  function buildSaveBar(): HTMLElement {
    // ── Save bar (sticky, shown when dirty) ─────────────────────────────
    const saveBar = document.createElement('div');
    saveBar.className = 'save-bar';
    saveBar.id = 'save-bar';

    const saveBarMsg = document.createElement('span');
    saveBarMsg.className = 'save-bar-message';
    saveBarMsg.textContent = 'Cambios sin guardar';
    saveBar.appendChild(saveBarMsg);

    const discardBarBtn = document.createElement('button');
    discardBarBtn.id = 'detail-discard';
    discardBarBtn.className = 'ghost';
    discardBarBtn.textContent = 'Descartar';
    discardBarBtn.disabled = true;
    discardBarBtn.addEventListener('click', () => {
      if (!store.isDirty()) return;
      store.discardDraft();
      renderGroupDetail();
    });
    saveBar.appendChild(discardBarBtn);

    const saveBarBtn = document.createElement('button');
    saveBarBtn.id = 'detail-save';
    saveBarBtn.className = 'primary';
    saveBarBtn.textContent = 'Guardar';
    saveBarBtn.disabled = true;
    saveBarBtn.addEventListener('click', async () => {
      if (!store.isDirty()) return;
      try {
        const savedGroup = await store.saveDraft();
        if (!savedGroup) return; // validation failed — toast already shown
        store.updateSaveBar();
        deps.renderGroupsList();
        if (savedGroup._autoStartEnforced) {
          deps.showToast(
            'Grupo guardado · Auto-arranque desactivado al cambiar a single',
            'ok',
          );
        } else {
          deps.showToast('Grupo guardado', 'ok');
        }
      } catch (err) {
        deps.showToast(`Error: ${errorMessage(err)}`, 'error');
      }
    });
    saveBar.appendChild(saveBarBtn);
    return saveBar;
  }

  /** «Visible en la barra»: an instant write, outside the draft. */
  function toggleVisibility(stored: Group, visible: boolean): void {
    void setHiddenInTray(
      {
        store,
        showToast: deps.showToast,
        repaint: () => {
          deps.renderGroupsList();
          renderGroupDetail();
        },
      },
      stored,
      visible,
    );
  }

  /**
   * «Duplicar»: a new group from what is on disk, never the half-edited
   * draft (see `duplicateOf`).
   */
  async function duplicateGroup(group: Group): Promise<void> {
    const stored = store.getGroups().find((g) => g.id === group.id) ?? group;
    const copy = duplicateOf(stored);
    try {
      const saved = await window.api.saveGroup(copy);
      // Unsaved edits stay where they are: only a clean pane follows the copy.
      if (!store.isDirty()) {
        store.setSelectedId(saved.id);
        store.clearDraft();
      }
      await deps.loadGroups();
      renderGroupDetail();
      deps.showToast('Grupo duplicado', 'ok');
    } catch (err) {
      deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    }
  }

  async function deleteGroup(group: Group): Promise<void> {
    if (
      !confirm(
        `¿Borrar el grupo "${group.name}"? Se detendrán todos sus procesos.`,
      )
    )
      return;
    const res = await window.api.deleteGroup(group.id);
    if (!res.ok) {
      // The main side aborts the deletion when a running command cannot
      // be stopped — surface why and leave the group visible for a retry
      // (same contract as the sub-item deletion handler).
      deps.showToast(res.error || 'No se pudo borrar el grupo', 'error');
      return;
    }
    store.setSelectedId(null);
    store.clearDraft();
    await deps.loadGroups();
    renderGroupDetail();
    await deps.refreshPipeline(); // deleting a group prunes its refs from every workflow
  }

  function buildGroupEnvSection(
    group: Group,
    parent: HTMLElement,
    onCount: (count: number) => void,
  ): void {
    // ── Group env editor ──────────────────────────────────────────────────
    const groupEnvSection = document.createElement('div') as EnvSectionElement;
    groupEnvSection.className = 'detail-section';
    const groupEnvLabel = document.createElement('div');
    groupEnvLabel.className = 'section-label';
    groupEnvLabel.textContent = 'Variables de entorno';
    groupEnvSection.appendChild(groupEnvLabel);
    const groupEnvContainer = document.createElement('div');
    groupEnvSection.appendChild(groupEnvContainer);
    parent.appendChild(groupEnvSection);
    // Build the editor — listen for input events bubbling out to detect changes
    const groupEnvEditor = buildEnvEditor(groupEnvContainer, group.env || []);
    groupEnvSection._envEditor = groupEnvEditor;
    // Typing, toggling, adding and deleting all land here: the add and
    // delete buttons re-render the editor without an input event, so a click
    // is synced too (the dirty check compares, so a no-op click stays clean).
    const sync = (): void => {
      const entries = groupEnvEditor.getEntries();
      store.mutateDraft((d) => {
        d.env = entries;
      });
      onCount(entries.length);
    };
    for (const type of ['input', 'change', 'click'])
      groupEnvContainer.addEventListener(type, sync);
  }

  function renderGroupDetail(): void {
    // Ensure draftGroup is initialised for the selected group if not already set
    const selectedGroupId = store.getSelectedId();
    if (
      selectedGroupId &&
      (!store.getDraft() || store.getDraft()?.id !== selectedGroupId)
    ) {
      store.loadDraftFromStored(selectedGroupId);
    }

    const group = store.getDraft();
    const saveBarHost = document.getElementById('group-save-bar');
    menu.close();
    if (!group) {
      header = null;
      deps.detailEl.innerHTML =
        '<div class="detail-empty"><p class="muted">Selecciona un grupo para editarlo.</p></div>';
      if (saveBarHost) saveBarHost.innerHTML = '';
      return;
    }

    deps.detailEl.innerHTML = '';

    const saveBar = buildSaveBar();
    // (saveBar is appended at the very end of the pane so it can sit sticky-bottom.)

    header = buildGroupHeader(group, {
      store,
      runtime: deps.runtime,
      menu,
      openIconPicker: (anchor, onSelect) =>
        deps.openIconPicker(anchor, onSelect),
      toggleVisibility,
      onRename: (value) => settingsTab?.setName(value),
      duplicate: (g) => void duplicateGroup(g),
      remove: (g) => void deleteGroup(g),
    });
    const tabs = buildGroupTabs(activeTab, (id) => {
      activeTab = id;
    });
    header.append(tabs.list);
    deps.detailEl.append(header.el, ...tabs.panels());
    tabs.setCount('processes', group.commands.length + group.actions.length);
    tabs.setCount('prescripts', group.preScripts.length);
    tabs.setCount('env', group.env.length);

    const processes = tabs.panel('processes');
    deps.subLists.buildSubList(group, 'command', processes);
    deps.subLists.buildSubList(group, 'action', processes);

    // Definitions only — their order lives in «Workflows».
    deps.subLists.buildPreScriptsLibrary(group, tabs.panel('prescripts'));

    buildGroupEnvSection(group, tabs.panel('env'), (count) =>
      tabs.setCount('env', count),
    );

    settingsTab = buildGroupSettingsTab(group, tabs.panel('settings'), {
      store,
      showToast: deps.showToast,
      onRename: (value) => header?.setName(value),
      onPath: (value) => header?.setPath(value),
      toggleVisibility,
      remove: (g) => void deleteGroup(g),
    });

    // The save bar lives OUTSIDE the editor pane (below the whole two-pane
    // block) so it reads as a footer for the Grupos view, not part of the
    // scrolling editor.
    if (saveBarHost) {
      saveBarHost.innerHTML = '';
      saveBarHost.appendChild(saveBar);
    }

    // Apply initial save bar state
    store.updateSaveBar();
  }

  return {
    render: renderGroupDetail,
    refreshRuntime: () => {
      header?.refreshRuntime();
      const selected = store.getSelectedId();
      if (selected) deps.subLists.refreshRunning(selected, deps.detailEl);
    },
  };
}
