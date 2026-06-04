'use strict';

// ────────────────────── DOM references ────────────────────────────────
const groupsListEl = document.getElementById('groups-list');
const groupDetailEl = document.getElementById('group-detail');
const addGroupBtn = document.getElementById('add-group');
const iconPickerEl = document.getElementById('icon-picker');
const iconSearchEl = document.getElementById('icon-search');
const iconGridEl = document.getElementById('icon-grid');
const subDialog = document.getElementById('sub-dialog');
const subForm = document.getElementById('sub-form');
const subDialogTitle = document.getElementById('sub-dialog-title');
const toastEl = document.getElementById('toast');

const setAutostart = document.getElementById('set-autostart');
const setSilenceWarnings = document.getElementById('set-silence-warnings');
const setSilenceErrors = document.getElementById('set-silence-errors');
const setMaxLogLines = document.getElementById('set-max-log-lines');

// Sub-dialog fields
const sfIconBtn = document.getElementById('sf-icon-btn');
const sfName = document.getElementById('sf-name');
const sfCommand = document.getElementById('sf-command');
const sfArgs = document.getElementById('sf-args');
const sfEnvEditor = document.getElementById('sf-env-editor');
const sfInheritGroupEnvRow = document.getElementById('sf-inherit-group-env-row');
const sfInheritGroupEnv = document.getElementById('sf-inherit-group-env');
const sfCwd = document.getElementById('sf-cwd');
const sfWarn = document.getElementById('sf-warn');
const sfError = document.getElementById('sf-error');
const sfSilenceWarn = document.getElementById('sf-silence-warn');
const sfSilenceErr = document.getElementById('sf-silence-err');
const sfMaxLogLines = document.getElementById('sf-max-log-lines');
const cmdOnlyFields = document.getElementById('cmd-only-fields');

const DEFAULT_WARN = '\\bwarn(ing)?s?\\b';
const DEFAULT_ERROR = '\\berror(s)?\\b';

// ────────────────────── State ──────────────────────────────────────────
let allGroups = [];
let selectedGroupId = null;
let iconPickerCallback = null;   // fn(emoji) when user picks an icon
let subDialogCallback = null;    // fn(data) when sub-form submits
let subDialogMode = 'command';   // 'command' | 'action'

// ── Draft state ────────────────────────────────────────────────────────
// draftGroup: in-memory copy of the selected group being edited
// storedGroup: last-persisted snapshot (the "clean" baseline for dirty check)
let draftGroup = null;
let storedGroup = null;

function isDirty() {
  if (!storedGroup || !draftGroup) return false;
  return JSON.stringify(draftGroup) !== JSON.stringify(storedGroup);
}

function loadDraftFromStored(groupId) {
  const g = allGroups.find((x) => x.id === groupId);
  if (!g) { draftGroup = null; storedGroup = null; return; }
  storedGroup = JSON.parse(JSON.stringify(g));
  draftGroup = JSON.parse(JSON.stringify(g));
}

function mutateDraft(mut) {
  if (!draftGroup) return;
  mut(draftGroup);
  updateSaveBar();
}

function updateSaveBar() {
  const dirty = isDirty();
  const saveBtn = document.getElementById('detail-save');
  const discardBtn = document.getElementById('detail-discard');
  if (saveBtn) saveBtn.disabled = !dirty;
  if (discardBtn) discardBtn.disabled = !dirty;
}

// ────────────────────── Toast ──────────────────────────────────────────

function showToast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.style.display = 'none'; }, 4500);
}

// ────────────────────── Data helpers ──────────────────────────────────

function selectedGroup() {
  return allGroups.find((g) => g.id === selectedGroupId) || null;
}

/**
 * Build a reusable env editor widget.
 *
 * @param {HTMLElement} container  — element to render the editor into
 * @param {Array} initialEntries  — EnvEntry[] initial value
 * @param {object} opts  — currently unused, kept for API compat
 * @returns {{ getEntries: () => EnvEntry[] }}
 */
function buildEnvEditor(container, initialEntries, opts = {}) {
  let entries = (initialEntries || []).map((e) => ({ ...e }));

  function updateMasterToggle(masterInput) {
    if (!masterInput) return;
    if (entries.length === 0) {
      masterInput.checked = false;
      masterInput.indeterminate = false;
      masterInput.closest('label').style.opacity = '0.45';
      masterInput.closest('label').style.pointerEvents = 'none';
    } else {
      masterInput.closest('label').style.opacity = '';
      masterInput.closest('label').style.pointerEvents = '';
      const allOn = entries.every((e) => e.enabled);
      masterInput.checked = allOn;
      masterInput.indeterminate = !allOn && entries.some((e) => e.enabled);
    }
  }

  function render() {
    container.innerHTML = '';
    container.className = 'env-editor';

    // ── Master toggle row ──────────────────────────────────────────────
    const masterRow = document.createElement('div');
    masterRow.className = 'env-master-row';

    const masterLabel = document.createElement('label');
    masterLabel.className = 'toggle inline';
    masterLabel.style.cssText = 'margin:0; padding:2px 0;';
    const masterInput = document.createElement('input');
    masterInput.type = 'checkbox';
    masterInput.title = 'Activar/desactivar todas';
    masterLabel.appendChild(masterInput);
    const masterSpan = document.createElement('span');
    masterSpan.textContent = 'Activar todas';
    masterSpan.style.cssText = 'font-size:11px; color:var(--muted);';
    masterLabel.appendChild(masterSpan);
    masterRow.appendChild(masterLabel);
    container.appendChild(masterRow);

    updateMasterToggle(masterInput);

    masterInput.addEventListener('change', () => {
      const val = masterInput.checked;
      for (const e of entries) e.enabled = val;
      render();
    });

    // ── Hairline separator ─────────────────────────────────────────────
    const sep = document.createElement('div');
    sep.className = 'env-separator';
    container.appendChild(sep);

    // ── Entry rows ─────────────────────────────────────────────────────
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const row = document.createElement('div');
      row.className = 'env-entry';

      // Per-entry toggle switch
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'toggle inline';
      toggleLabel.style.cssText = 'margin:0; padding:0; flex-shrink:0;';
      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = !!entry.enabled;
      toggleInput.addEventListener('change', () => {
        entries[i].enabled = toggleInput.checked;
        updateMasterToggle(masterInput);
      });
      toggleLabel.appendChild(toggleInput);
      row.appendChild(toggleLabel);

      // Key input
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'env-key';
      keyInput.placeholder = 'KEY';
      keyInput.value = entry.key || '';
      keyInput.addEventListener('input', () => { entries[i].key = keyInput.value; });
      row.appendChild(keyInput);

      // Value input
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'env-value';
      valInput.placeholder = 'value';
      valInput.value = entry.value || '';
      valInput.addEventListener('input', () => { entries[i].value = valInput.value; });
      row.appendChild(valInput);

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'env-delete';
      delBtn.title = 'Eliminar';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        entries.splice(i, 1);
        render();
      });
      row.appendChild(delBtn);

      container.appendChild(row);
    }

    // ── Add button ─────────────────────────────────────────────────────
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'env-add-btn';
    addBtn.textContent = '+ Añadir variable';
    addBtn.addEventListener('click', () => {
      entries.push({ key: '', value: '', enabled: true });
      render();
      // Focus the last key input
      const rows = container.querySelectorAll('.env-entry');
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const keyEl = lastRow.querySelector('.env-key');
        if (keyEl) keyEl.focus();
      }
    });
    container.appendChild(addBtn);
  }

  render();

  return {
    getEntries: () => entries.map((e) => ({ ...e })),
    // setDisabled kept for API compat but is a no-op (env editor is always active now)
    setDisabled: (_disabled) => {},
  };
}

function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const idx = rest.indexOf('/');
    if (idx >= 0) return '~' + rest.slice(idx);
  }
  return p;
}

// ────────────────────── Groups list (left pane) ────────────────────────

async function loadGroups() {
  allGroups = await window.api.listGroups();
  renderGroupsList();
}

function renderGroupsList() {
  groupsListEl.innerHTML = '';
  if (!allGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'nav-empty muted';
    empty.textContent = 'Sin grupos. Pulsa + Añadir.';
    groupsListEl.appendChild(empty);
    return;
  }

  for (const group of allGroups) {
    const card = buildGroupNavCard(group);
    groupsListEl.appendChild(card);
  }

  // Attach drag-and-drop for group reordering
  attachDragHandlers(groupsListEl, async (orderedIds) => {
    await window.api.reorderGroups(orderedIds);
    await loadGroups();
  });

  // Only re-render detail when clean — preserve in-progress edits
  if (selectedGroupId && !isDirty()) renderGroupDetail();
}

function buildGroupNavCard(group) {
  const card = document.createElement('div');
  card.className = `nav-card ${group.id === selectedGroupId ? 'selected' : ''}`;
  card.dataset.id = group.id;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.title = 'Arrastra para reordenar';
  handle.textContent = '⋮⋮';
  card.appendChild(handle);

  const iconEl = document.createElement('span');
  iconEl.className = 'nav-icon';
  iconEl.textContent = group.icon || '📦';
  card.appendChild(iconEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'nav-name';
  nameEl.textContent = group.name || '(sin nombre)';
  card.appendChild(nameEl);

  card.addEventListener('click', async (e) => {
    if (e.target.closest('.drag-handle')) return;
    if (group.id === selectedGroupId) return;
    if (isDirty()) {
      const { choice } = await window.api.confirmDirty('nav-switch');
      if (choice === 'cancel') return;
      if (choice === 'save') {
        try {
          await window.api.saveGroup(draftGroup);
          await loadGroups();
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
          return;
        }
      }
      // 'discard' falls through
    }
    selectedGroupId = group.id;
    loadDraftFromStored(group.id);
    renderGroupsList();
    renderGroupDetail();
  });

  return card;
}

// ────────────────────── Group detail (right pane) ─────────────────────

function renderGroupDetail() {
  // Ensure draftGroup is initialised for the selected group if not already set
  if (selectedGroupId && (!draftGroup || draftGroup.id !== selectedGroupId)) {
    loadDraftFromStored(selectedGroupId);
  }

  const group = draftGroup;
  if (!group) {
    groupDetailEl.innerHTML = '<div class="detail-empty"><p class="muted">Selecciona un grupo para editarlo.</p></div>';
    return;
  }

  groupDetailEl.innerHTML = '';

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
    if (!isDirty()) return;
    draftGroup = JSON.parse(JSON.stringify(storedGroup));
    renderGroupDetail();
  });
  saveBar.appendChild(discardBarBtn);

  const saveBarBtn = document.createElement('button');
  saveBarBtn.id = 'detail-save';
  saveBarBtn.className = 'primary';
  saveBarBtn.textContent = 'Guardar';
  saveBarBtn.disabled = true;
  saveBarBtn.addEventListener('click', async () => {
    if (!isDirty()) return;
    if (!draftGroup.path) { showToast('El path no puede estar vacío', 'error'); return; }
    try {
      const savedGroup = await window.api.saveGroup(draftGroup);
      storedGroup = JSON.parse(JSON.stringify(savedGroup || draftGroup));
      const idx = allGroups.findIndex((g) => g.id === storedGroup.id);
      if (idx >= 0) allGroups[idx] = storedGroup;
      updateSaveBar();
      renderGroupsList();
      if (savedGroup && savedGroup._autoStartEnforced) {
        showToast('Grupo guardado · Auto-arranque desactivado al cambiar a single', 'ok');
      } else {
        showToast('Grupo guardado', 'ok');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });
  saveBar.appendChild(saveBarBtn);
  // (saveBar is appended at the very end of the pane so it can sit sticky-bottom.)

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
    openIconPicker(e.currentTarget, (emoji) => {
      iconBtn.textContent = emoji;
      mutateDraft((d) => { d.icon = emoji; });
    });
  });
  header.appendChild(iconBtn);

  // Name input
  const nameInput = document.createElement('input');
  nameInput.className = 'detail-name-input';
  nameInput.value = group.name || '';
  nameInput.placeholder = 'Nombre del grupo';
  nameInput.addEventListener('input', () => {
    mutateDraft((d) => { d.name = nameInput.value; });
  });
  header.appendChild(nameInput);

  groupDetailEl.appendChild(header);

  // ── Path field ───────────────────────────────────────────────────────
  const pathField = buildField('Path del grupo (cwd y git repo)', 'text', group.path || '', '/Users/yo/proyecto');
  pathField.className += ' detail-field';
  // Wrap the input in an input-with-action container and add folder picker
  const pathInput = pathField.querySelector('input');
  pathInput.addEventListener('input', () => {
    mutateDraft((d) => { d.path = pathInput.value.trim(); });
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
    if (!res.ok) { showToast(`Error: ${res.error || 'desconocido'}`, 'error'); return; }
    pathInput.value = res.path;
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  groupDetailEl.appendChild(pathField);

  // ── Mode toggle ──────────────────────────────────────────────────────
  const modeSection = document.createElement('div');
  modeSection.className = 'detail-section';
  const modeLabel = document.createElement('div');
  modeLabel.className = 'section-label';
  modeLabel.textContent = 'Modo';
  modeSection.appendChild(modeLabel);

  const modeRow = document.createElement('div');
  modeRow.className = 'mode-toggle-row';
  for (const m of ['multi', 'single']) {
    const lbl = document.createElement('label');
    lbl.className = 'mode-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `mode-${group.id}`;
    radio.value = m;
    radio.checked = (group.mode || 'multi') === m;
    radio.addEventListener('change', () => {
      if (radio.checked) mutateDraft((d) => { d.mode = m; });
    });
    lbl.appendChild(radio);
    lbl.appendChild(document.createTextNode(` ${m}`));
    modeRow.appendChild(lbl);
  }
  modeSection.appendChild(modeRow);
  groupDetailEl.appendChild(modeSection);

  // ── Silence flags ────────────────────────────────────────────────────
  const silenceSection = document.createElement('div');
  silenceSection.className = 'detail-section';
  const silenceLabel = document.createElement('div');
  silenceLabel.className = 'section-label';
  silenceLabel.textContent = 'Silenciar en este grupo';
  silenceSection.appendChild(silenceLabel);

  const muteWarnLbl = buildToggleLabel('Warnings', group.silenceWarnings, 'detail-silence-warn');
  const muteErrLbl = buildToggleLabel('Errors', group.silenceErrors, 'detail-silence-err');
  muteWarnLbl.querySelector('input').addEventListener('change', (e) => {
    mutateDraft((d) => { d.silenceWarnings = e.target.checked; });
  });
  muteErrLbl.querySelector('input').addEventListener('change', (e) => {
    mutateDraft((d) => { d.silenceErrors = e.target.checked; });
  });
  silenceSection.appendChild(muteWarnLbl);
  silenceSection.appendChild(muteErrLbl);
  groupDetailEl.appendChild(silenceSection);

  // ── Group env editor ──────────────────────────────────────────────────
  const groupEnvSection = document.createElement('div');
  groupEnvSection.className = 'detail-section';
  const groupEnvLabel = document.createElement('div');
  groupEnvLabel.className = 'section-label';
  groupEnvLabel.textContent = 'Variables de entorno';
  groupEnvSection.appendChild(groupEnvLabel);
  const groupEnvContainer = document.createElement('div');
  groupEnvSection.appendChild(groupEnvContainer);
  groupDetailEl.appendChild(groupEnvSection);
  // Build the editor — listen for input events bubbling out to detect changes
  const groupEnvEditor = buildEnvEditor(groupEnvContainer, group.env || []);
  groupEnvSection._envEditor = groupEnvEditor;
  groupEnvContainer.addEventListener('input', () => {
    mutateDraft((d) => { d.env = groupEnvEditor.getEntries(); });
  });
  groupEnvContainer.addEventListener('change', () => {
    mutateDraft((d) => { d.env = groupEnvEditor.getEntries(); });
  });

  // ── Commands sub-list ─────────────────────────────────────────────────
  buildSubList(group, 'command', groupDetailEl);

  // ── Actions sub-list ──────────────────────────────────────────────────
  buildSubList(group, 'action', groupDetailEl);

  // ── Action buttons ────────────────────────────────────────────────────
  const btnRow = document.createElement('div');
  btnRow.className = 'detail-btn-row';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'danger';
  deleteBtn.textContent = 'Borrar grupo';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`¿Borrar el grupo "${group.name}"? Se detendrán todos sus procesos.`)) return;
    await window.api.deleteGroup(group.id);
    selectedGroupId = null;
    draftGroup = null;
    storedGroup = null;
    await loadGroups();
    renderGroupDetail();
  });
  btnRow.appendChild(deleteBtn);

  groupDetailEl.appendChild(btnRow);

  // Append the sticky save bar AFTER all other pane content so its
  // sticky-bottom anchoring sits at the bottom of the scrolling viewport.
  groupDetailEl.appendChild(saveBar);

  // Apply initial save bar state
  updateSaveBar();
}

function buildField(labelText, type, value, placeholder) {
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

function buildToggleLabel(text, checked, cssClass) {
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

// ────────────────────── Sub-list (commands or actions) ─────────────────

function buildSubList(group, kind, parent) {
  const isCommand = kind === 'command';
  const items = isCommand ? (group.commands || []) : (group.actions || []);
  const sectionTitle = isCommand ? 'Comandos' : 'Acciones';
  const addLabel = isCommand ? '+ Añadir comando' : '+ Añadir acción';

  const section = document.createElement('div');
  section.className = 'detail-section';

  const headerRow = document.createElement('div');
  headerRow.className = 'sub-list-header';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'section-label';
  titleSpan.textContent = sectionTitle;
  headerRow.appendChild(titleSpan);
  const addBtn = document.createElement('button');
  addBtn.className = 'small-btn';
  addBtn.textContent = addLabel;
  addBtn.addEventListener('click', () => openSubDialog(null, kind, group.id));
  headerRow.appendChild(addBtn);
  section.appendChild(headerRow);

  const listEl = document.createElement('div');
  listEl.className = 'sub-item-list';
  listEl.dataset.kind = kind;
  listEl.dataset.groupId = group.id;

  for (const item of items) {
    listEl.appendChild(buildSubItemRow(item, kind, group.id));
  }

  section.appendChild(listEl);
  parent.appendChild(section);

  // DnD for sub-list
  attachDragHandlers(listEl, async (orderedIds) => {
    if (isCommand) {
      await window.api.reorderCommands(group.id, orderedIds);
    } else {
      await window.api.reorderActions(group.id, orderedIds);
    }
    await loadGroups();
    renderGroupDetail();
  });
}

function buildSubItemRow(item, kind, groupId) {
  const row = document.createElement('div');
  row.className = 'sub-item-row';
  row.dataset.id = item.id;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.title = 'Arrastra para reordenar';
  handle.textContent = '⋮⋮';
  row.appendChild(handle);

  if (item.icon) {
    const iconEl = document.createElement('span');
    iconEl.className = 'sub-icon';
    iconEl.textContent = item.icon;
    row.appendChild(iconEl);
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'sub-name';
  nameEl.textContent = item.name;
  row.appendChild(nameEl);

  const cmdSummary = document.createElement('span');
  cmdSummary.className = 'sub-cmd muted';
  cmdSummary.textContent = [item.command, ...(item.args || [])].join(' ');
  row.appendChild(cmdSummary);

  const actions = document.createElement('div');
  actions.className = 'sub-actions';

  // Auto-start toggle — only for commands (actions are one-shots and
  // not eligible for boot auto-start). Lives in the listing so single-
  // mode radio behaviour is obvious at a glance.
  if (kind === 'command') {
    const autoBtn = document.createElement('button');
    const isOn = !!item.autoStart;
    autoBtn.className = `small-btn autostart-toggle${isOn ? ' is-on' : ''}`;
    autoBtn.textContent = '⚡';
    autoBtn.title = isOn
      ? 'Auto-arranca con DevBar — click para desactivar'
      : 'Auto-arrancar al iniciar DevBar';
    autoBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      autoBtn.disabled = true;
      const res = await window.api.setCommandAutoStart(groupId, item.id, !isOn);
      autoBtn.disabled = false;
      if (res && res.ok === false) {
        showToast(`Error: ${res.error || 'desconocido'}`, 'error');
        return;
      }
      await loadGroups();
      renderGroupDetail();
    });
    actions.appendChild(autoBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.textContent = '✎';
  editBtn.title = 'Editar';
  editBtn.className = 'small-btn';
  editBtn.addEventListener('click', () => openSubDialog(item, kind, groupId));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑';
  delBtn.title = 'Borrar';
  delBtn.className = 'small-btn danger';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`¿Borrar "${item.name}"?`)) return;
    if (kind === 'command') {
      await window.api.deleteCommand(groupId, item.id);
    } else {
      await window.api.deleteAction(groupId, item.id);
    }
    await loadGroups();
    renderGroupDetail();
  });
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

// ────────────────────── Sub-dialog (command/action) ────────────────────

// Module-level ref so the submit handler can read the current editor state
let _sfEnvEditorHandle = null;

function openSubDialog(item, kind, groupId) {
  subDialogMode = kind;
  const isCommand = kind === 'command';
  subDialogTitle.textContent = item
    ? `Editar ${isCommand ? 'comando' : 'acción'}: ${item.name}`
    : `Nuevo ${isCommand ? 'comando' : 'acción'}`;

  // Icon button
  sfIconBtn.textContent = (item && item.icon) || (isCommand ? '⚙️' : '🪄');
  sfIconBtn.onclick = (e) => {
    openIconPicker(e.currentTarget, (emoji) => {
      sfIconBtn.textContent = emoji;
    });
  };

  sfName.value = item ? item.name : '';
  sfCommand.value = item ? item.command : '';
  sfArgs.value = item ? (item.args || []).join('\n') : '';

  // Action-only: inheritGroupEnv toggle
  if (!isCommand) {
    sfInheritGroupEnvRow.style.display = '';
    sfInheritGroupEnv.checked = item ? !!item.inheritGroupEnv : false;
  } else {
    sfInheritGroupEnvRow.style.display = 'none';
  }

  // (auto-start lives in the commands list, not in this dialog.)

  // Build env editor — always interactive (no dimming)
  const initialEnv = item ? (item.env || []) : [];
  _sfEnvEditorHandle = buildEnvEditor(sfEnvEditor, initialEnv);

  // Command-only fields
  cmdOnlyFields.style.display = isCommand ? '' : 'none';
  if (isCommand) {
    sfCwd.value = item ? (item.cwd || '') : '';
    sfWarn.value = item ? (item.warnRegex || DEFAULT_WARN) : DEFAULT_WARN;
    sfError.value = item ? (item.errorRegex || DEFAULT_ERROR) : DEFAULT_ERROR;
    sfSilenceWarn.checked = !!(item && item.silenceWarnings);
    sfSilenceErr.checked = !!(item && item.silenceErrors);
    if (sfMaxLogLines) sfMaxLogLines.value = (item && item.maxLogLines != null) ? item.maxLogLines : '';
  }

  subDialogCallback = async (data) => {
    try {
      if (isCommand) {
        const payload = {
          id: item ? item.id : undefined,
          icon: data.icon || null,
          name: data.name,
          command: data.command,
          args: data.args,
          env: data.env,
          cwd: data.cwd || null,
          warnRegex: data.warnRegex || DEFAULT_WARN,
          errorRegex: data.errorRegex || DEFAULT_ERROR,
          silenceWarnings: data.silenceWarnings,
          silenceErrors: data.silenceErrors,
          maxLogLines: data.maxLogLines,
          // Preserve existing autoStart — the toggle for it lives in the
          // commands list now, not in this dialog.
          autoStart: item ? !!item.autoStart : false,
          // Preserve silenced patterns
          silencedPatterns: item ? item.silencedPatterns : { warn: [], error: [] },
        };
        await window.api.saveCommand(groupId, payload);
      } else {
        const payload = {
          id: item ? item.id : undefined,
          icon: data.icon || null,
          name: data.name,
          command: data.command,
          args: data.args,
          env: data.env,
          inheritGroupEnv: data.inheritGroupEnv,
        };
        await window.api.saveAction(groupId, payload);
      }

      // Refresh allGroups silently (no full re-render)
      await loadGroups();

      // Merge the saved command/action slice back into draftGroup and storedGroup
      // so the sub-list reflects the updated item while parent-level edits are preserved.
      if (draftGroup && draftGroup.id === groupId) {
        const fresh = allGroups.find((g) => g.id === groupId);
        if (fresh) {
          const slice = isCommand ? 'commands' : 'actions';
          const freshSlice = JSON.parse(JSON.stringify(fresh[slice] || []));
          // Sync storedGroup slice so dirty check reflects new sub-item state
          storedGroup[slice] = freshSlice;
          // Sync draftGroup slice — preserves parent-level field edits
          draftGroup[slice] = freshSlice;
        }
        // Re-render from draftGroup (parent edits preserved)
        renderGroupDetail();
      } else {
        // No draft active — fall back to full reload
        renderGroupDetail();
      }

      showToast(`${isCommand ? 'Comando' : 'Acción'} guardado`, 'ok');
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  subDialog.showModal();
}

// ── Sub-dialog folder picker for cwd field ─────────────────────────────
const sfCwdPickBtn = document.getElementById('sf-cwd-pick');
sfCwdPickBtn.addEventListener('click', async () => {
  const res = await window.api.pickFolder(sfCwd.value || undefined);
  if (res.canceled) return;
  if (!res.ok) { showToast(`Error: ${res.error || 'desconocido'}`, 'error'); return; }
  sfCwd.value = res.path;
  sfCwd.dispatchEvent(new Event('input', { bubbles: true }));
});

subForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const args = sfArgs.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const maxLogLinesStr = sfMaxLogLines ? sfMaxLogLines.value : '';
  const maxLogLines = maxLogLinesStr === '' ? null : (Number(maxLogLinesStr) || null);
  const data = {
    icon: sfIconBtn ? sfIconBtn.textContent : null,
    name: sfName.value.trim(),
    command: sfCommand.value.trim(),
    args,
    env: _sfEnvEditorHandle ? _sfEnvEditorHandle.getEntries() : [],
    inheritGroupEnv: sfInheritGroupEnv.checked,
    cwd: sfCwd.value.trim(),
    warnRegex: sfWarn.value.trim(),
    errorRegex: sfError.value.trim(),
    silenceWarnings: sfSilenceWarn.checked,
    silenceErrors: sfSilenceErr.checked,
    maxLogLines,
  };
  subDialog.close();
  if (subDialogCallback) await subDialogCallback(data);
});

document.getElementById('sub-cancel').addEventListener('click', (e) => {
  e.preventDefault();
  subDialog.close();
});

// Wire fake traffic-light close buttons on all <dialog> elements
document.querySelectorAll('.fake-traffic-lights .light.close').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = btn.closest('dialog');
    if (d && d.open) d.close();
  });
});

// ────────────────────── Icon picker ────────────────────────────────────

let allIcons = [];

// Load the battery from the main process (single source of truth).
// Render an empty grid until it resolves, then re-render.
window.api.getIconBattery().then((battery) => {
  allIcons = battery || [];
  renderIconGrid(iconSearchEl.value || '');
}).catch(() => {
  // If IPC fails (e.g., test environment), allIcons stays []
});

function renderIconGrid(filter) {
  iconGridEl.innerHTML = '';
  const q = (filter || '').toLowerCase().trim();
  const filtered = q
    ? allIcons.filter((i) => {
        if (i.emoji.startsWith(q)) return true;
        if (i.label.toLowerCase().includes(q)) return true;
        if (i.keywords && i.keywords.some((k) => k.includes(q))) return true;
        return false;
      })
    : allIcons;
  for (const item of filtered) {
    const btn = document.createElement('button');
    btn.className = 'icon-cell';
    btn.title = item.label;
    btn.textContent = item.emoji;
    btn.addEventListener('click', () => {
      if (iconPickerCallback) iconPickerCallback(item.emoji);
      closeIconPicker();
    });
    iconGridEl.appendChild(btn);
  }
}

function openIconPicker(anchorEl, onSelect) {
  iconPickerCallback = onSelect;
  iconSearchEl.value = '';
  renderIconGrid('');

  // Reparent the picker: if the sub-dialog is open it lives in the top layer,
  // so the picker must also be inside the dialog to appear above the backdrop.
  // Otherwise keep it at body level. The picker uses position:fixed so
  // top/left are always viewport-relative regardless of parent.
  if (subDialog.open) {
    if (iconPickerEl.parentElement !== subDialog) {
      subDialog.appendChild(iconPickerEl);
    }
  } else {
    if (iconPickerEl.parentElement !== document.body) {
      document.body.appendChild(iconPickerEl);
    }
  }

  iconPickerEl.removeAttribute('hidden');
  // Position below anchor using viewport-relative coords (works with position:fixed)
  const rect = anchorEl.getBoundingClientRect();
  iconPickerEl.style.top = `${rect.bottom + 4}px`;
  iconPickerEl.style.left = `${rect.left}px`;
  iconSearchEl.focus();
}

function closeIconPicker() {
  iconPickerEl.setAttribute('hidden', '');
  iconPickerCallback = null;
}

iconSearchEl.addEventListener('input', () => renderIconGrid(iconSearchEl.value));
document.addEventListener('click', (e) => {
  if (!iconPickerEl.hidden && !iconPickerEl.contains(e.target) && !e.target.closest('.icon-btn')) {
    closeIconPicker();
  }
});

// ────────────────────── Add group ──────────────────────────────────────

addGroupBtn.addEventListener('click', async () => {
  const newGroup = {
    name: 'Nuevo grupo',
    icon: '📦',
    path: '',
    mode: 'multi',
    silenceWarnings: false,
    silenceErrors: false,
    commands: [],
    actions: [],
  };
  try {
    const saved = await window.api.saveGroup(newGroup);
    selectedGroupId = saved.id;
    await loadGroups();
    renderGroupDetail();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// ────────────────────── Settings ───────────────────────────────────────

async function loadSettings() {
  const s = await window.api.getSettings();
  setAutostart.checked = !!s.autostart;
  setSilenceWarnings.checked = !!s.silenceWarnings;
  setSilenceErrors.checked = !!s.silenceErrors;
  if (setMaxLogLines) setMaxLogLines.value = s.maxLogLines != null ? s.maxLogLines : 2000;
}

async function persistSettings() {
  const maxLogLinesRaw = setMaxLogLines ? setMaxLogLines.value : '';
  const maxLogLines = maxLogLinesRaw === '' ? 2000 : (Number(maxLogLinesRaw) || 2000);
  await window.api.saveSettings({
    autostart: setAutostart.checked,
    silenceWarnings: setSilenceWarnings.checked,
    silenceErrors: setSilenceErrors.checked,
    maxLogLines,
  });
  showToast('Ajustes guardados', 'ok');
}

setAutostart.addEventListener('change', persistSettings);
setSilenceWarnings.addEventListener('change', persistSettings);
setSilenceErrors.addEventListener('change', persistSettings);
if (setMaxLogLines) {
  setMaxLogLines.addEventListener('change', persistSettings);
  setMaxLogLines.addEventListener('blur', persistSettings);
}

// ────────────────────── Backup / Restore ───────────────────────────────

(function wireBackupButtons() {
  const exportBtn = document.getElementById('export-config');
  const importBtn = document.getElementById('import-config');

  exportBtn.addEventListener('click', async () => {
    let res;
    try {
      res = await window.api.exportConfig();
    } catch (err) {
      showToast(`Error al exportar: ${err.message}`, 'error');
      return;
    }
    if (res.canceled) return;
    if (res.ok) {
      showToast(`Exportado en ${res.path}`, 'ok');
    } else {
      showToast(`Error al exportar: ${res.error}`, 'error');
    }
  });

  importBtn.addEventListener('click', async () => {
    let picked;
    try {
      picked = await window.api.importConfig();
    } catch (err) {
      showToast(`Error al importar: ${err.message}`, 'error');
      return;
    }
    if (picked.canceled) return;
    if (!picked.ok) {
      showToast(`Error: ${picked.error}`, 'error');
      return;
    }

    let confirmed;
    try {
      confirmed = await window.api.confirmImport({ preview: picked.preview });
    } catch (err) {
      showToast(`Error al confirmar: ${err.message}`, 'error');
      return;
    }
    if (!confirmed.confirmed) return;

    let applied;
    try {
      applied = await window.api.applyImportedConfig({ token: picked.token });
    } catch (err) {
      showToast(`Error al aplicar: ${err.message}`, 'error');
      return;
    }
    if (!applied.ok) {
      showToast(`Error al aplicar: ${applied.error}`, 'error');
      return;
    }

    // Reload the UI to reflect the newly imported config
    await loadSettings();
    await loadGroups();
    selectedGroupId = null;
    renderGroupDetail();
    showToast('Configuración importada', 'ok');
  });
})();

// ────────────────────── Live updates ───────────────────────────────────

window.api.onUpdate(async () => {
  await loadGroups(); // refreshes allGroups + nav via renderGroupsList
  if (!selectedGroupId) return;
  if (isDirty()) {
    // Pane has unsaved edits — do NOT overwrite draftGroup.
    // The nav has already re-rendered via renderGroupsList inside loadGroups.
    return;
  }
  // Clean pane: re-sync draft from freshest stored data and re-render.
  loadDraftFromStored(selectedGroupId);
  renderGroupDetail();
});

// ────────────────────── Window close guard ────────────────────────────

let _closingGuard = false;

if (window.api.onConfigCloseRequested) {
  window.api.onConfigCloseRequested(async () => {
    if (_closingGuard) return;
    if (!isDirty()) {
      window.api.confirmCloseConfig();
      return;
    }
    _closingGuard = true;
    let choice;
    try {
      const result = await window.api.confirmDirty('window-close');
      choice = result.choice;
    } catch (_) {
      choice = 'cancel';
    }
    if (choice === 'cancel') {
      _closingGuard = false;
      return;
    }
    if (choice === 'save') {
      try {
        await window.api.saveGroup(draftGroup);
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
        _closingGuard = false;
        return;
      }
    }
    // Nullify draft to prevent re-entry check on the next close event
    draftGroup = null;
    storedGroup = null;
    window.api.confirmCloseConfig();
  });
}

// ────────────────────── Init ───────────────────────────────────────────

loadSettings();
loadGroups();

// App version label next to the page title.
if (window.api && window.api.getAppVersion) {
  window.api.getAppVersion()
    .then((v) => {
      const el = document.getElementById('app-version');
      if (el && v) el.textContent = `v${v}`;
    })
    .catch(() => { /* leave the label empty on failure */ });
}
