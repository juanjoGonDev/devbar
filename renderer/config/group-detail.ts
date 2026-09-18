import { buildEnvEditor, type EnvSectionElement } from './env-editor.js';
import type { Group } from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import type { SubLists } from './sub-lists.js';
import { errorMessage, type ShowToast } from './toast.js';

export interface GroupDetailDeps {
  /** The right pane (`#group-detail`). */
  detailEl: HTMLElement;
  store: GroupStore;
  showToast: ShowToast;
  subLists: SubLists;
  openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (emoji: string) => void,
  ): void;
  loadGroups(): Promise<void>;
  renderGroupsList(): void;
  refreshPipeline(): Promise<void>;
}

export interface GroupDetail {
  render(): void;
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

  function buildHeader(group: Group): void {
    // ── Header ──────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'detail-header';

    // Icon picker button
    const iconBtn = document.createElement('button');
    iconBtn.className = 'icon-btn';
    iconBtn.title = 'Cambiar icono';
    iconBtn.textContent = group.icon || '📦';
    iconBtn.dataset.groupId = group.id;
    iconBtn.addEventListener('click', (e) => {
      deps.openIconPicker(
        e.currentTarget as HTMLButtonElement,
        (emoji: string) => {
          iconBtn.textContent = emoji;
          store.mutateDraft((d) => {
            d.icon = emoji;
          });
        },
      );
    });
    header.appendChild(iconBtn);

    // Name input
    const nameInput = document.createElement('input');
    nameInput.className = 'detail-name-input';
    nameInput.value = group.name || '';
    nameInput.placeholder = 'Nombre del grupo';
    nameInput.addEventListener('input', () => {
      store.mutateDraft((d) => {
        d.name = nameInput.value;
      });
    });
    header.appendChild(nameInput);

    deps.detailEl.appendChild(header);
  }

  function buildPathField(group: Group): void {
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
    grpPathPickBtn.textContent = '📁';
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
    deps.detailEl.appendChild(pathField);
  }

  function buildModeSection(group: Group): void {
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
    deps.detailEl.appendChild(modeSection);
  }

  function buildSilenceSection(group: Group): void {
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
    deps.detailEl.appendChild(silenceSection);
  }

  function buildGroupEnvSection(group: Group): void {
    // ── Group env editor ──────────────────────────────────────────────────
    const groupEnvSection = document.createElement('div') as EnvSectionElement;
    groupEnvSection.className = 'detail-section';
    const groupEnvLabel = document.createElement('div');
    groupEnvLabel.className = 'section-label';
    groupEnvLabel.textContent = 'Variables de entorno';
    groupEnvSection.appendChild(groupEnvLabel);
    const groupEnvContainer = document.createElement('div');
    groupEnvSection.appendChild(groupEnvContainer);
    deps.detailEl.appendChild(groupEnvSection);
    // Build the editor — listen for input events bubbling out to detect changes
    const groupEnvEditor = buildEnvEditor(groupEnvContainer, group.env || []);
    groupEnvSection._envEditor = groupEnvEditor;
    groupEnvContainer.addEventListener('input', () => {
      store.mutateDraft((d) => {
        d.env = groupEnvEditor.getEntries();
      });
    });
    groupEnvContainer.addEventListener('change', () => {
      store.mutateDraft((d) => {
        d.env = groupEnvEditor.getEntries();
      });
    });
  }

  function buildWaitSection(group: Group): void {
    // ── Pipeline release timing (Group.waitForPipeline, default true) ──────
    // Placed right before the commands list, where each command's own
    // auto-start toggle lives — this setting decides WHEN this group's
    // auto-start commands are released relative to the pipeline.
    const waitSection = document.createElement('div');
    waitSection.className = 'detail-section';
    const waitLbl = buildToggleLabel(
      'Esperar a que termine todo el pipeline antes de arrancar',
      group.waitForPipeline,
      'detail-wait-pipeline',
    );
    waitLbl
      .querySelector<HTMLInputElement>('input')
      ?.addEventListener('change', (event) => {
        const input = event.currentTarget as HTMLInputElement;
        store.mutateDraft((d) => {
          d.waitForPipeline = input.checked;
        });
      });
    waitSection.appendChild(waitLbl);
    const waitHint = document.createElement('p');
    waitHint.className = 'help-text muted';
    waitHint.style.cssText = 'font-size:11px; margin:4px 0 8px;';
    waitHint.textContent =
      'Un paso posterior de OTRO grupo puede reiniciar servicios compartidos (p. ej. Docker). Desactívalo solo si este grupo es realmente independiente del resto del pipeline.';
    waitSection.appendChild(waitHint);
    deps.detailEl.appendChild(waitSection);
  }

  function buildDeleteRow(group: Group): void {
    // ── Action buttons ────────────────────────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.className = 'detail-btn-row';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Borrar grupo';
    deleteBtn.addEventListener('click', async () => {
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
      await deps.refreshPipeline(); // deleting a group prunes its refs from the pipeline
    });
    btnRow.appendChild(deleteBtn);

    deps.detailEl.appendChild(btnRow);
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
    if (!group) {
      deps.detailEl.innerHTML =
        '<div class="detail-empty"><p class="muted">Selecciona un grupo para editarlo.</p></div>';
      if (saveBarHost) saveBarHost.innerHTML = '';
      return;
    }

    deps.detailEl.innerHTML = '';

    const saveBar = buildSaveBar();
    // (saveBar is appended at the very end of the pane so it can sit sticky-bottom.)

    buildHeader(group);
    buildPathField(group);
    buildModeSection(group);
    buildSilenceSection(group);
    buildGroupEnvSection(group);

    // ── Pre-scripts library (definitions only — order lives in "Pipeline") ──
    deps.subLists.buildPreScriptsLibrary(group, deps.detailEl);

    buildWaitSection(group);

    // ── Commands sub-list ─────────────────────────────────────────────────
    deps.subLists.buildSubList(group, 'command', deps.detailEl);

    // ── Actions sub-list ──────────────────────────────────────────────────
    deps.subLists.buildSubList(group, 'action', deps.detailEl);

    buildDeleteRow(group);

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

  return { render: renderGroupDetail };
}
