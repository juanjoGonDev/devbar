import { icon } from '../icon.js';
import { buildGroupHeader, type GroupHeader } from './group-header.js';
import { duplicateOf } from './group-copy.js';
import { buildGroupTabs, type GroupTabId } from './group-tabs.js';
import { createDeviceMenu } from './remote-device-menu.js';
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

function buildField(
  labelText: string,
  type: string,
  value: string,
  placeholder = '',
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  wrap.appendChild(input);
  return wrap;
}

function buildToggleLabel(
  text: string,
  checked: boolean,
  cssClass: string,
): HTMLLabelElement {
  const lbl = document.createElement('label');
  lbl.className = 'toggle inline';
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = !!checked;
  chk.className = cssClass;
  lbl.appendChild(chk);
  const span = document.createElement('span');
  span.textContent = text;
  lbl.appendChild(span);
  return lbl;
}

export function createGroupDetail(deps: GroupDetailDeps): GroupDetail {
  const { store } = deps;
  const menu = createDeviceMenu();
  let header: GroupHeader | null = null;
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

  function buildPathField(group: Group, parent: HTMLElement): void {
    // ── Path field ───────────────────────────────────────────────────────
    const pathField = buildField(
      'Path del grupo (cwd y git repo)',
      'text',
      group.path || '',
      '/Users/yo/proyecto',
    );
    pathField.className += ' detail-field';
    // Wrap the input in an input-with-action container and add folder picker
    const pathInput = pathField.querySelector<HTMLInputElement>('input');
    if (!pathInput) throw new Error('Path field input missing');
    pathInput.addEventListener('input', () => {
      store.mutateDraft((d) => {
        d.path = pathInput.value.trim();
      });
      header?.setPath(pathInput.value.trim());
    });
    const pathPickerContainer = document.createElement('div');
    pathPickerContainer.className = 'input-with-action';
    pathField.replaceChild(pathPickerContainer, pathInput);
    pathPickerContainer.appendChild(pathInput);
    const grpPathPickBtn = document.createElement('button');
    grpPathPickBtn.type = 'button';
    grpPathPickBtn.id = 'grp-path-pick';
    grpPathPickBtn.className = 'icon-action-btn';
    grpPathPickBtn.title = 'Seleccionar carpeta…';
    grpPathPickBtn.setAttribute('aria-label', grpPathPickBtn.title);
    grpPathPickBtn.append(icon('folder-open'));
    pathPickerContainer.appendChild(grpPathPickBtn);
    grpPathPickBtn.addEventListener('click', async () => {
      const res = await window.api.pickFolder(pathInput.value || undefined);
      if (res.canceled) return;
      if (!res.ok) {
        deps.showToast(`Error: ${res.error || 'desconocido'}`, 'error');
        return;
      }
      if (!res.path) return;
      pathInput.value = res.path;
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    parent.appendChild(pathField);
  }

  function buildModeSection(group: Group, parent: HTMLElement): void {
    // ── Mode toggle ──────────────────────────────────────────────────────
    const modeSection = document.createElement('div');
    modeSection.className = 'detail-section';
    const modeLabel = document.createElement('div');
    modeLabel.className = 'section-label';
    modeLabel.textContent = 'Modo';
    modeSection.appendChild(modeLabel);

    const modeRow = document.createElement('div');
    modeRow.className = 'mode-toggle-row';
    for (const m of ['multi', 'single'] as const) {
      const lbl = document.createElement('label');
      lbl.className = 'mode-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `mode-${group.id}`;
      radio.value = m;
      radio.checked = (group.mode || 'multi') === m;
      radio.addEventListener('change', () => {
        if (radio.checked)
          store.mutateDraft((d) => {
            d.mode = m;
          });
      });
      lbl.appendChild(radio);
      lbl.appendChild(document.createTextNode(` ${m}`));
      modeRow.appendChild(lbl);
    }
    modeSection.appendChild(modeRow);
    parent.appendChild(modeSection);
  }

  function buildSilenceSection(group: Group, parent: HTMLElement): void {
    // ── Silence flags ────────────────────────────────────────────────────
    const silenceSection = document.createElement('div');
    silenceSection.className = 'detail-section';
    const silenceLabel = document.createElement('div');
    silenceLabel.className = 'section-label';
    silenceLabel.textContent = 'Silenciar en este grupo';
    silenceSection.appendChild(silenceLabel);

    const muteWarnLbl = buildToggleLabel(
      'Warnings',
      group.silenceWarnings,
      'detail-silence-warn',
    );
    const muteErrLbl = buildToggleLabel(
      'Errors',
      group.silenceErrors,
      'detail-silence-err',
    );
    muteWarnLbl
      .querySelector<HTMLInputElement>('input')
      ?.addEventListener('change', (event) => {
        const input = event.currentTarget as HTMLInputElement;
        store.mutateDraft((group) => {
          group.silenceWarnings = input.checked;
        });
      });
    muteErrLbl
      .querySelector<HTMLInputElement>('input')
      ?.addEventListener('change', (event) => {
        const input = event.currentTarget as HTMLInputElement;
        store.mutateDraft((group) => {
          group.silenceErrors = input.checked;
        });
      });
    silenceSection.appendChild(muteWarnLbl);
    silenceSection.appendChild(muteErrLbl);
    parent.appendChild(silenceSection);
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

  function buildWaitSection(group: Group, parent: HTMLElement): void {
    // ── Startup-workflow release timing (Group.waitForPipeline) ────────────
    // Decides WHEN this group's auto-start commands are released relative
    // to the startup workflow.
    const waitSection = document.createElement('div');
    waitSection.className = 'detail-section';
    const waitLbl = buildToggleLabel(
      'Esperar al workflow de arranque',
      group.waitForPipeline,
      'detail-wait-pipeline',
    );
    // The why lives in the tooltip: the pane stays a list of settings.
    waitLbl.title =
      'Arranca los comandos de este grupo cuando termina todo el workflow de arranque: un bloque de otro grupo puede reiniciar servicios compartidos (p. ej. Docker).';
    waitLbl
      .querySelector<HTMLInputElement>('input')
      ?.addEventListener('change', (event) => {
        const input = event.currentTarget as HTMLInputElement;
        store.mutateDraft((d) => {
          d.waitForPipeline = input.checked;
        });
      });
    waitSection.appendChild(waitLbl);
    parent.appendChild(waitSection);
  }

  function buildDeleteRow(group: Group, parent: HTMLElement): void {
    // ── Action buttons ────────────────────────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.className = 'detail-btn-row';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Borrar grupo';
    deleteBtn.addEventListener('click', () => void deleteGroup(group));
    btnRow.appendChild(deleteBtn);

    parent.appendChild(btnRow);
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

    const settings = tabs.panel('settings');
    buildPathField(group, settings);
    buildModeSection(group, settings);
    buildSilenceSection(group, settings);
    buildWaitSection(group, settings);
    buildDeleteRow(group, settings);

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
    refreshRuntime: () => header?.refreshRuntime(),
  };
}
