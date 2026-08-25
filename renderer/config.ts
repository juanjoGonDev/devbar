import { attachDragHandlers } from './dnd-helper.js';
import { openChangelog } from './changelog.js';
import { wireModal } from './modal.js';
import { byId } from './dom.js';
import type {
  Action,
  Command,
  EnvEntry,
  Group,
  PreScript,
  PreStep,
  Schedule,
  ScheduleRule,
} from '../src/domain-types.js';
import { DEFAULT_MAX_LOG_LINES } from '../src/domain-types.js';
import type { IconBatteryItem, UpdateStatus } from '../src/ipc-contract.js';
import { installTooltips } from './tooltip.js';

type EditableItem = Command | Action | PreScript;
type SubKind = 'command' | 'action' | 'prescript';
interface SubFormData {
  icon: string | null;
  name: string;
  command: string;
  args: string[];
  env: EnvEntry[];
  inheritGroupEnv: boolean;
  cwd: string;
  warnRegex: string;
  errorRegex: string;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  maxLogLines: number | null;
  timeoutSecs: number | null;
  confirm: boolean;
  confirmSecs: number | null;
  confirmOnTimeout: 'confirm' | 'cancel';
  schedule: Schedule;
}
type SavedGroup = Group & { _autoStartEnforced?: boolean };
interface EnvSectionElement extends HTMLDivElement {
  _envEditor?: EnvEditorHandle;
}
interface EnvEditorHandle {
  getEntries(): EnvEntry[];
  setDisabled?(disabled: boolean): void;
}
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// ────────────────────── DOM references ────────────────────────────────
const groupsListEl = byId<HTMLElement>('groups-list', HTMLElement);
const groupDetailEl = byId<HTMLElement>('group-detail', HTMLElement);
const addGroupBtn = byId<HTMLButtonElement>('add-group', HTMLButtonElement);
const iconPickerEl = byId<HTMLDivElement>('icon-picker', HTMLDivElement);
const iconSearchEl = byId<HTMLInputElement>('icon-search', HTMLInputElement);
const iconGridEl = byId<HTMLElement>('icon-grid', HTMLElement);
const subDialog = byId<HTMLDialogElement>('sub-dialog', HTMLDialogElement);
const subForm = byId<HTMLFormElement>('sub-form', HTMLFormElement);
const subDialogTitle = byId<HTMLElement>('sub-dialog-title', HTMLElement);
const toastEl = byId<HTMLElement>('toast', HTMLElement);

const setAutostart = byId<HTMLInputElement>('set-autostart', HTMLInputElement);
const setSilenceWarnings = byId<HTMLInputElement>(
  'set-silence-warnings',
  HTMLInputElement,
);
const setSilenceErrors = byId<HTMLInputElement>(
  'set-silence-errors',
  HTMLInputElement,
);
const setMaxLogLines = byId<HTMLInputElement>(
  'set-max-log-lines',
  HTMLInputElement,
);
const setNotifySuccess = byId<HTMLInputElement>(
  'set-notify-success',
  HTMLInputElement,
);
const testNotifyBtn = byId<HTMLButtonElement>(
  'test-notification',
  HTMLButtonElement,
);

// Sub-dialog fields
const sfIconBtn = byId<HTMLButtonElement>('sf-icon-btn', HTMLButtonElement);
const sfName = byId<HTMLInputElement>('sf-name', HTMLInputElement);
const sfCommand = byId<HTMLInputElement>('sf-command', HTMLInputElement);
const sfArgs = byId<HTMLTextAreaElement>('sf-args', HTMLTextAreaElement);
const sfEnvEditor = byId<HTMLElement>('sf-env-editor', HTMLElement);
const sfInheritGroupEnvRow = byId<HTMLElement>(
  'sf-inherit-group-env-row',
  HTMLElement,
);
const sfInheritGroupEnv = byId<HTMLInputElement>(
  'sf-inherit-group-env',
  HTMLInputElement,
);
const sfCwd = byId<HTMLInputElement>('sf-cwd', HTMLInputElement);
const sfWarn = byId<HTMLInputElement>('sf-warn', HTMLInputElement);
const sfError = byId<HTMLInputElement>('sf-error', HTMLInputElement);
const sfSilenceWarn = byId<HTMLInputElement>(
  'sf-silence-warn',
  HTMLInputElement,
);
const sfSilenceErr = byId<HTMLInputElement>('sf-silence-err', HTMLInputElement);
const sfMaxLogLines = byId<HTMLInputElement>(
  'sf-max-log-lines',
  HTMLInputElement,
);
const cmdOnlyFields = byId<HTMLElement>('cmd-only-fields', HTMLElement);
const sfScheduleGroup = byId<HTMLElement>('sf-schedule-group', HTMLElement);
const sfScheduleEnabled = byId<HTMLInputElement>(
  'sf-schedule-enabled',
  HTMLInputElement,
);
const sfScheduleRules = byId<HTMLElement>('sf-schedule-rules', HTMLElement);
const sfScheduleAdd = byId<HTMLButtonElement>(
  'sf-schedule-add',
  HTMLButtonElement,
);
const sfScheduleDetails = byId<HTMLElement>('sf-schedule-details', HTMLElement);
// Monday-first display order → weekday index (Sun=0..Sat=6).
const DAY_CHIPS = [
  { label: 'L', d: 1 },
  { label: 'M', d: 2 },
  { label: 'X', d: 3 },
  { label: 'J', d: 4 },
  { label: 'V', d: 5 },
  { label: 'S', d: 6 },
  { label: 'D', d: 0 },
];

/** Render the 7 weekday chips into `container`, selecting `days`. */
function makeDayChips(container: HTMLElement, selected: number[]): void {
  const chosen = new Set(selected || []);
  container.innerHTML = '';
  for (const { label, d } of DAY_CHIPS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `day-chip${chosen.has(d) ? ' is-on' : ''}`;
    chip.textContent = label;
    chip.dataset.day = String(d);
    chip.setAttribute('aria-pressed', chosen.has(d) ? 'true' : 'false');
    chip.addEventListener('click', () => {
      const on = chip.classList.toggle('is-on');
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    container.appendChild(chip);
  }
}

/** Append one schedule-rule row (time + day chips + remove) to the editor. */
function addScheduleRuleRow(rule: ScheduleRule): void {
  const row = document.createElement('div');
  row.className = 'schedule-rule';

  const time = document.createElement('input');
  time.type = 'time';
  time.className = 'rule-time';
  time.value = (rule && rule.time) || '09:00';
  row.appendChild(time);

  const days = document.createElement('div');
  days.className = 'day-chips rule-days';
  makeDayChips(days, (rule && rule.days) || []);
  row.appendChild(days);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small-btn danger rule-remove';
  remove.textContent = '🗑';
  remove.title = 'Quitar este horario';
  remove.addEventListener('click', () => row.remove());
  row.appendChild(remove);

  sfScheduleRules.appendChild(row);
}

/** Read all schedule-rule rows back into [{ time, days }]. */
function readScheduleRules(): ScheduleRule[] {
  return [
    ...sfScheduleRules.querySelectorAll<HTMLElement>('.schedule-rule'),
  ].map((row) => ({
    time: row.querySelector<HTMLInputElement>('.rule-time')?.value || '09:00',
    days: [...row.querySelectorAll<HTMLElement>('.day-chip.is-on')]
      .map((chip) => Number(chip.dataset.day))
      .sort((a, b) => a - b),
  }));
}

/** One-line human summary of a schedule, e.g. "09:00 LMXJV · 14:00 todos". */
function summarizeSchedule(schedule: Schedule | null | undefined): string {
  const rules = (schedule && schedule.rules) || [];
  const name = (day: number): string =>
    ['D', 'L', 'M', 'X', 'J', 'V', 'S'][day] ?? '';
  return rules
    .map((r) => {
      const days =
        r.days && r.days.length ? r.days.map(name).join('') : 'todos';
      return `${r.time} ${days}`;
    })
    .join(' · ');
}

/**
 * Show + populate the schedule editor. Available for commands and actions,
 * hidden for pre-scripts (a prep step isn't a thing you run at a clock time).
 */
function setupSchedule(
  item: EditableItem | null | undefined,
  isPreScript: boolean,
): void {
  sfScheduleGroup.style.display = isPreScript ? 'none' : '';
  if (isPreScript) return;
  const sched: Schedule =
    item && 'schedule' in item ? item.schedule : { enabled: false, rules: [] };
  sfScheduleEnabled.checked = sched.enabled;
  {
    sfScheduleRules.innerHTML = '';
    const rules = Array.isArray(sched.rules) ? sched.rules : [];
    // Always show at least one row so there is something to fill in.
    (rules.length ? rules : [{ time: '09:00', days: [] }]).forEach(
      addScheduleRuleRow,
    );
  }
  const sync = () => {
    sfScheduleDetails.style.display = sfScheduleEnabled.checked ? '' : 'none';
  };
  sync();
  sfScheduleEnabled.onchange = sync;
}

sfScheduleAdd.addEventListener('click', () =>
  addScheduleRuleRow({ time: '09:00', days: [] }),
);
const sfTimeoutSecs = byId<HTMLInputElement>(
  'sf-timeout-secs',
  HTMLInputElement,
);
const sfTimeoutRow = byId<HTMLElement>('sf-timeout-row', HTMLElement);
const sfConfirmRow = byId<HTMLElement>('sf-confirm-row', HTMLElement);
const sfConfirm = byId<HTMLInputElement>('sf-confirm', HTMLInputElement);
const sfConfirmDetails = byId<HTMLElement>('sf-confirm-details', HTMLElement);
const sfConfirmOnTimeout = byId<HTMLSelectElement>(
  'sf-confirm-on-timeout',
  HTMLSelectElement,
);
const sfConfirmSecs = byId<HTMLInputElement>(
  'sf-confirm-secs',
  HTMLInputElement,
);

const DEFAULT_WARN = '\\bwarn(ing)?s?\\b';
const DEFAULT_ERROR = '\\berror(s)?\\b';

// ────────────────────── State ──────────────────────────────────────────
let allGroups: Group[] = [];
let selectedGroupId: string | null = null;
let iconPickerCallback: ((emoji: string) => void) | null = null;
let subDialogCallback: ((data: SubFormData) => unknown) | null = null;

// ── Draft state ────────────────────────────────────────────────────────
// draftGroup: in-memory copy of the selected group being edited
// storedGroup: last-persisted snapshot (the "clean" baseline for dirty check)
let draftGroup: Group | null = null;
let storedGroup: Group | null = null;

function isDirty(): boolean {
  if (!storedGroup || !draftGroup) return false;
  return JSON.stringify(draftGroup) !== JSON.stringify(storedGroup);
}

function loadDraftFromStored(groupId: string): void {
  const g = allGroups.find((x) => x.id === groupId);
  if (!g) {
    draftGroup = null;
    storedGroup = null;
    return;
  }
  storedGroup = structuredClone(g);
  draftGroup = structuredClone(g);
}

function mutateDraft(mut: (group: Group) => void): void {
  if (!draftGroup) return;
  mut(draftGroup);
  updateSaveBar();
}

function updateSaveBar(): void {
  const dirty = isDirty();
  const saveBtn = document.getElementById(
    'detail-save',
  ) as HTMLButtonElement | null;
  const discardBtn = document.getElementById(
    'detail-discard',
  ) as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = !dirty;
  if (discardBtn) discardBtn.disabled = !dirty;
}

/**
 * The single validated save path for the selected group's draft. Every place
 * that persists a group (save bar, group-switch "guardar", window-close
 * "guardar") MUST go through here so validation is consistent — otherwise the
 * discard-dialog "guardar" would smuggle an invalid group past the checks the
 * save bar enforces.
 *
 * Returns the saved group on success, or null if validation failed (the toast
 * is already shown; callers must abort any follow-up like switching or closing).
 * Throws only on an unexpected IPC error, which callers surface as a toast.
 */
async function saveDraft(): Promise<SavedGroup | null> {
  if (!draftGroup) return null;
  if (!draftGroup.path) {
    showToast('El path no puede estar vacío', 'error');
    return null;
  }
  const savedGroup = await window.api.saveGroup(draftGroup);
  const baseline = structuredClone(savedGroup || draftGroup);
  storedGroup = baseline;
  const idx = allGroups.findIndex((group) => group.id === baseline.id);
  if (idx >= 0) allGroups[idx] = baseline;
  return savedGroup || baseline;
}

// ────────────────────── Toast ──────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, kind = 'ok'): void {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.display = 'none';
  }, 4500);
}

// ────────────────────── Data helpers ──────────────────────────────────

/**
 * Build a reusable env editor widget.
 *
 * @param {HTMLElement} container  — element to render the editor into
 * @param {Array} initialEntries  — EnvEntry[] initial value
 * @param {object} opts  — currently unused, kept for API compat
 * @returns {{ getEntries: () => EnvEntry[] }}
 */
function buildEnvEditor(
  container: HTMLElement,
  initialEntries: EnvEntry[],
  _opts: Record<string, never> = {},
): EnvEditorHandle {
  const entries = (initialEntries || []).map((e) => ({ ...e }));

  function updateMasterToggle(masterInput: HTMLInputElement | null): void {
    if (!masterInput) return;
    if (entries.length === 0) {
      masterInput.checked = false;
      masterInput.indeterminate = false;
      const label = masterInput.closest<HTMLElement>('label');
      if (label) {
        label.style.opacity = '0.45';
        label.style.pointerEvents = 'none';
      }
    } else {
      const label = masterInput.closest<HTMLElement>('label');
      if (label) {
        label.style.opacity = '';
        label.style.pointerEvents = '';
      }
      const allOn = entries.every((e) => e.enabled);
      masterInput.checked = allOn;
      masterInput.indeterminate = !allOn && entries.some((e) => e.enabled);
    }
  }

  function render(): void {
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
      if (!entry) continue;
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
        entry.enabled = toggleInput.checked;
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
      keyInput.addEventListener('input', () => {
        entry.key = keyInput.value;
      });
      row.appendChild(keyInput);

      // Value input
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'env-value';
      valInput.placeholder = 'value';
      valInput.value = entry.value || '';
      valInput.addEventListener('input', () => {
        entry.value = valInput.value;
      });
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
      const rows = container.querySelectorAll<HTMLElement>('.env-entry');
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const keyEl = lastRow.querySelector<HTMLInputElement>('.env-key');
        if (keyEl) keyEl.focus();
      }
    });
    container.appendChild(addBtn);
  }

  render();

  return {
    getEntries: () => entries.map((e) => ({ ...e })),
    // setDisabled kept for API compat but is a no-op (env editor is always active now)
    setDisabled: (_disabled: boolean) => {},
  };
}

// ────────────────────── Groups list (left pane) ────────────────────────

async function loadGroups(): Promise<void> {
  allGroups = await window.api.listGroups();
  renderGroupsList();
}

function renderGroupsList(): void {
  groupsListEl.innerHTML = '';
  if (!allGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'nav-empty muted';
    empty.textContent = 'Sin grupos. Pulsa + Añadir.';
    groupsListEl.appendChild(empty);
    return;
  }

  // Land on something editable instead of an empty panel telling you to pick.
  // Only when nothing is selected and nothing is half-edited, so a refresh
  // mid-edit never yanks the user off their own draft.
  if (!selectedGroupId && !isDirty() && allGroups[0]) {
    selectedGroupId = allGroups[0].id;
    loadDraftFromStored(selectedGroupId);
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

function buildGroupNavCard(group: Group): HTMLElement {
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
    if (e.target instanceof HTMLElement && e.target.closest('.drag-handle'))
      return;
    if (group.id === selectedGroupId) return;
    if (isDirty()) {
      const { choice } = await window.api.confirmDirty('nav-switch');
      if (choice === 'cancel') return;
      if (choice === 'save') {
        try {
          const saved = await saveDraft();
          if (!saved) return; // empty path — abort switch, stay on this group
          await loadGroups();
        } catch (err) {
          showToast(`Error: ${errorMessage(err)}`, 'error');
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

function renderGroupDetail(): void {
  // Ensure draftGroup is initialised for the selected group if not already set
  if (selectedGroupId && (!draftGroup || draftGroup.id !== selectedGroupId)) {
    loadDraftFromStored(selectedGroupId);
  }

  const group = draftGroup;
  const saveBarHost = document.getElementById('group-save-bar');
  if (!group) {
    groupDetailEl.innerHTML =
      '<div class="detail-empty"><p class="muted">Selecciona un grupo para editarlo.</p></div>';
    if (saveBarHost) saveBarHost.innerHTML = '';
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
    if (storedGroup) draftGroup = structuredClone(storedGroup);
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
    try {
      const savedGroup = await saveDraft();
      if (!savedGroup) return; // validation failed — toast already shown
      updateSaveBar();
      renderGroupsList();
      if (savedGroup._autoStartEnforced) {
        showToast(
          'Grupo guardado · Auto-arranque desactivado al cambiar a single',
          'ok',
        );
      } else {
        showToast('Grupo guardado', 'ok');
      }
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
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
    openIconPicker(e.currentTarget as HTMLButtonElement, (emoji: string) => {
      iconBtn.textContent = emoji;
      mutateDraft((d) => {
        d.icon = emoji;
      });
    });
  });
  header.appendChild(iconBtn);

  // Name input
  const nameInput = document.createElement('input');
  nameInput.className = 'detail-name-input';
  nameInput.value = group.name || '';
  nameInput.placeholder = 'Nombre del grupo';
  nameInput.addEventListener('input', () => {
    mutateDraft((d) => {
      d.name = nameInput.value;
    });
  });
  header.appendChild(nameInput);

  groupDetailEl.appendChild(header);

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
    mutateDraft((d) => {
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
      showToast(`Error: ${res.error || 'desconocido'}`, 'error');
      return;
    }
    if (!res.path) return;
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
        mutateDraft((d) => {
          d.mode = m;
        });
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
      mutateDraft((group) => {
        group.silenceWarnings = input.checked;
      });
    });
  muteErrLbl
    .querySelector<HTMLInputElement>('input')
    ?.addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      mutateDraft((group) => {
        group.silenceErrors = input.checked;
      });
    });
  silenceSection.appendChild(muteWarnLbl);
  silenceSection.appendChild(muteErrLbl);
  groupDetailEl.appendChild(silenceSection);

  // ── Group env editor ──────────────────────────────────────────────────
  const groupEnvSection = document.createElement('div') as EnvSectionElement;
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
    mutateDraft((d) => {
      d.env = groupEnvEditor.getEntries();
    });
  });
  groupEnvContainer.addEventListener('change', () => {
    mutateDraft((d) => {
      d.env = groupEnvEditor.getEntries();
    });
  });

  // ── Pre-scripts section ───────────────────────────────────────────────
  buildPreStepsSection(group, groupDetailEl);

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
    if (
      !confirm(
        `¿Borrar el grupo "${group.name}"? Se detendrán todos sus procesos.`,
      )
    )
      return;
    await window.api.deleteGroup(group.id);
    selectedGroupId = null;
    draftGroup = null;
    storedGroup = null;
    await loadGroups();
    renderGroupDetail();
  });
  btnRow.appendChild(deleteBtn);

  groupDetailEl.appendChild(btnRow);

  // The save bar lives OUTSIDE the editor pane (below the whole two-pane
  // block) so it reads as a footer for the Grupos view, not part of the
  // scrolling editor.
  if (saveBarHost) {
    saveBarHost.innerHTML = '';
    saveBarHost.appendChild(saveBar);
  }

  // Apply initial save bar state
  updateSaveBar();
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

// ────────────────────── Pre-steps section ────────────────────────────────

/**
 * Build the Pre-scripts section and append it to `parent`.
 * Placed between the group env editor and the Commands section.
 */
function buildPreStepsSection(group: Group, parent: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'detail-section presteps-section';

  const headerRow = document.createElement('div');
  headerRow.className = 'sub-list-header';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'section-label';
  titleSpan.textContent = 'Pre-scripts';
  headerRow.appendChild(titleSpan);

  const addStepBtn = document.createElement('button');
  addStepBtn.className = 'small-btn';
  addStepBtn.textContent = '+ Añadir paso';
  addStepBtn.addEventListener('click', async () => {
    await window.api.savePreStep(group.id, { mode: 'parallel', scripts: [] });
    await loadGroups();
    renderGroupDetail();
  });
  headerRow.appendChild(addStepBtn);
  section.appendChild(headerRow);

  const helpText = document.createElement('p');
  helpText.className = 'help-text muted';
  helpText.style.cssText = 'font-size:11px; margin:4px 0 8px;';
  helpText.textContent =
    'Se ejecutan antes de iniciar los comandos auto-start. Cada paso puede correr en paralelo o en serie.';
  section.appendChild(helpText);

  // ── Auto-run toggle ───────────────────────────────────────────────────
  // When ON, pre-scripts auto-run ONLY when DevBar was launched by macOS
  // at login (system boot), not on every manual app restart. Default OFF.
  const autoRunLbl = buildToggleLabel(
    'Ejecutar automáticamente al arrancar el Mac',
    !!group.preScriptsAutoRun,
    'detail-prestep-autorun',
  );
  autoRunLbl
    .querySelector<HTMLInputElement>('input')
    ?.addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      mutateDraft((draft) => {
        draft.preScriptsAutoRun = input.checked;
      });
    });
  const autoRunHint = document.createElement('small');
  autoRunHint.className = 'muted';
  autoRunHint.style.cssText =
    'display:block; margin:2px 0 8px 42px; font-size:10px;';
  autoRunHint.textContent =
    'Solo dispara cuando DevBar abre como Login Item del sistema; no en relanzados manuales.';
  section.appendChild(autoRunLbl);
  section.appendChild(autoRunHint);

  const steps = group.preSteps || [];

  if (steps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'prestep-empty';
    empty.textContent = 'Sin pasos. Pulsa «+ Añadir paso» para comenzar.';
    section.appendChild(empty);
    parent.appendChild(section);
    return;
  }

  const stepsRoot = document.createElement('div');
  stepsRoot.className = 'presteps-list';

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    if (!step) continue;
    const card = buildPreStepCard(group, step, si + 1);
    stepsRoot.appendChild(card);
  }

  section.appendChild(stepsRoot);

  // Step-level DnD
  attachDragHandlers(stepsRoot, async (orderedIds) => {
    await window.api.reorderPreSteps(group.id, orderedIds);
    await loadGroups();
    renderGroupDetail();
  });

  parent.appendChild(section);
}

function buildPreStepCard(
  group: Group,
  step: PreStep,
  stepNumber: number,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'prestep-card';
  card.dataset.id = step.id;

  // ── Header ───────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'prestep-card-header';

  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.draggable = true;
  dragHandle.title = 'Arrastra para reordenar';
  dragHandle.textContent = '⋮⋮';
  header.appendChild(dragHandle);

  const stepLabel = document.createElement('span');
  stepLabel.className = 'step-label';
  stepLabel.textContent = `Paso ${stepNumber}`;
  header.appendChild(stepLabel);

  // Mode toggle (segmented control)
  const modeToggle = document.createElement('div');
  modeToggle.className = 'prestep-mode-toggle';
  modeToggle.setAttribute('role', 'group');
  modeToggle.setAttribute('aria-label', 'Modo de ejecución');

  for (const mode of ['parallel', 'serial'] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-btn';
    btn.textContent = mode === 'parallel' ? 'Paralelo ⇉' : 'Serie →';
    btn.setAttribute('aria-pressed', String(step.mode === mode));
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.savePreStep(group.id, { ...step, mode });
      await loadGroups();
      renderGroupDetail();
    });
    modeToggle.appendChild(btn);
  }
  header.appendChild(modeToggle);

  // Spacer
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  header.appendChild(spacer);

  // Delete step button
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'small-btn danger';
  delBtn.title = 'Eliminar paso';
  delBtn.textContent = '×';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`¿Eliminar el paso ${stepNumber}?`)) return;
    await window.api.deletePreStep(group.id, step.id);
    await loadGroups();
    renderGroupDetail();
  });
  header.appendChild(delBtn);

  card.appendChild(header);

  // ── Script list ───────────────────────────────────────────────────────
  const scriptList = document.createElement('ul');
  scriptList.className = 'prescript-list';
  scriptList.dataset.dndScope = `script-${step.id}`;

  for (const script of step.scripts || []) {
    scriptList.appendChild(buildPreScriptRow(group, step, script));
  }
  card.appendChild(scriptList);

  // Script-level DnD (scoped to this step — no cross-step drag)
  attachDragHandlers(scriptList, async (orderedIds) => {
    await window.api.reorderPreScripts(group.id, step.id, orderedIds);
    await loadGroups();
    renderGroupDetail();
  });

  // Add script button
  const addScriptBtn = document.createElement('button');
  addScriptBtn.type = 'button';
  addScriptBtn.className = 'small-btn';
  addScriptBtn.textContent = '+ Añadir script';
  addScriptBtn.style.marginTop = '4px';
  addScriptBtn.addEventListener('click', () => {
    openSubDialog(null, 'prescript', group.id, step.id);
  });
  card.appendChild(addScriptBtn);

  return card;
}

function buildPreScriptRow(
  group: Group,
  step: PreStep,
  script: PreScript,
): HTMLElement {
  const li = document.createElement('li');
  li.className = 'prescript-row';
  li.dataset.id = script.id;

  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.draggable = true;
  dragHandle.title = 'Arrastra para reordenar';
  dragHandle.textContent = '⋮';
  li.appendChild(dragHandle);

  const nameEl = document.createElement('strong');
  nameEl.textContent = script.name || 'Unnamed';
  li.appendChild(nameEl);

  const cmdEl = document.createElement('code');
  cmdEl.textContent = [script.command, ...(script.args || [])].join(' ');
  li.appendChild(cmdEl);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  li.appendChild(spacer);

  const editBtn = document.createElement('button');
  editBtn.textContent = '✎';
  editBtn.title = 'Editar';
  editBtn.className = 'small-btn';
  editBtn.addEventListener('click', () =>
    openSubDialog(script, 'prescript', group.id, step.id),
  );
  li.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑';
  delBtn.title = 'Borrar';
  delBtn.className = 'small-btn danger';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`¿Borrar "${script.name}"?`)) return;
    await window.api.deletePreScript(group.id, step.id, script.id);
    await loadGroups();
    renderGroupDetail();
  });
  li.appendChild(delBtn);

  return li;
}

// ────────────────────── Sub-list (commands or actions) ─────────────────

function buildSubList(
  group: Group,
  kind: 'command' | 'action',
  parent: HTMLElement,
): void {
  const isCommand = kind === 'command';
  const items = isCommand ? group.commands || [] : group.actions || [];
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

function buildSubItemRow(
  item: Command | Action,
  kind: 'command' | 'action',
  groupId: string,
): HTMLElement {
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
  if (kind === 'command' && 'autoStart' in item) {
    const autoBtn = document.createElement('button');
    const isOn = item.autoStart;
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

  // Schedule indicator — commands and actions. Click opens the editor where the
  // schedule lives.
  if (
    (kind === 'command' || kind === 'action') &&
    item.schedule &&
    item.schedule.enabled &&
    (item.schedule.rules || []).length > 0
  ) {
    const schedBtn = document.createElement('button');
    schedBtn.className = 'small-btn schedule-badge is-on';
    schedBtn.textContent = '🕐';
    schedBtn.title = `Programado: ${summarizeSchedule(item.schedule)} — click para editar`;
    schedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSubDialog(item, kind, groupId);
    });
    actions.appendChild(schedBtn);
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

// ────────────────────── Sub-dialog (command/action/prescript) ──────────────

// Module-level ref so the submit handler can read the current editor state
let _sfEnvEditorHandle: EnvEditorHandle | null = null;
let _sfPreStepId: string | null = null;

function openSubDialog(
  item: EditableItem | null,
  kind: SubKind,
  groupId: string,
  stepId?: string,
): void {
  _sfPreStepId = stepId || null;
  const isCommand = kind === 'command';
  const isPreScript = kind === 'prescript';
  subDialogTitle.textContent = item
    ? `Editar ${isCommand ? 'comando' : isPreScript ? 'pre-script' : 'acción'}: ${item.name}`
    : `Nuevo ${isCommand ? 'comando' : isPreScript ? 'pre-script' : 'acción'}`;

  // Icon button — hidden for prescripts (they don't have icons)
  const sfIconField = document.querySelector<HTMLElement>('.sf-icon-field');
  if (sfIconField) sfIconField.style.display = isPreScript ? 'none' : '';
  sfIconBtn.textContent =
    (item && 'icon' in item ? item.icon : null) || (isCommand ? '⚙️' : '🪄');
  sfIconBtn.onclick = (e) => {
    openIconPicker(e.currentTarget as HTMLButtonElement, (emoji: string) => {
      sfIconBtn.textContent = emoji;
    });
  };

  sfName.value = item ? item.name : '';
  sfCommand.value = item ? item.command : '';
  sfArgs.value = item ? (item.args || []).join('\n') : '';

  // Action and prescript: inheritGroupEnv toggle
  if (!isCommand) {
    sfInheritGroupEnvRow.style.display = '';
    sfInheritGroupEnv.checked =
      item && 'inheritGroupEnv' in item ? item.inheritGroupEnv : false;
  } else {
    sfInheritGroupEnvRow.style.display = 'none';
  }

  // (auto-start lives in the commands list, not in this dialog.)

  // Build env editor — always interactive (no dimming)
  const initialEnv = item ? item.env || [] : [];
  _sfEnvEditorHandle = buildEnvEditor(sfEnvEditor, initialEnv);

  // PreScript-only: timeout field
  if (sfTimeoutRow) sfTimeoutRow.style.display = isPreScript ? '' : 'none';
  if (sfTimeoutSecs)
    sfTimeoutSecs.value =
      item && 'timeoutMs' in item && item.timeoutMs
        ? String(Math.round(item.timeoutMs / 1000))
        : '';

  // Confirmation gate — available for commands, actions and pre-scripts.
  if (sfConfirmRow) sfConfirmRow.style.display = '';
  if (sfConfirm) {
    sfConfirm.checked = !!(item && item.confirm);
    if (sfConfirmOnTimeout) {
      sfConfirmOnTimeout.value = item?.confirmOnTimeout || 'cancel';
    }
    if (sfConfirmSecs) {
      sfConfirmSecs.value =
        item && item.confirmSecs != null ? String(item.confirmSecs) : '';
    }
    if (sfConfirmDetails) {
      sfConfirmDetails.style.display = sfConfirm.checked ? '' : 'none';
    }
    sfConfirm.onchange = () => {
      if (sfConfirmDetails) {
        sfConfirmDetails.style.display = sfConfirm.checked ? '' : 'none';
      }
    };
  }

  // Command-only fields — hidden for actions and prescripts
  cmdOnlyFields.style.display = isCommand ? '' : 'none';
  if (isCommand) {
    const command = item && 'cwd' in item ? item : null;
    sfCwd.value = command?.cwd || '';
    sfWarn.value = command?.warnRegex || DEFAULT_WARN;
    sfError.value = command?.errorRegex || DEFAULT_ERROR;
    sfSilenceWarn.checked = command?.silenceWarnings ?? false;
    sfSilenceErr.checked = command?.silenceErrors ?? false;
    sfMaxLogLines.value =
      command?.maxLogLines != null ? String(command.maxLogLines) : '';
  }

  // Schedule editor — commands and actions, not pre-scripts.
  setupSchedule(item, isPreScript);

  subDialogCallback = async (rawData: unknown) => {
    const data = rawData as SubFormData;
    try {
      if (isPreScript) {
        const payload = {
          id: item ? item.id : undefined,
          name: data.name,
          command: data.command,
          args: data.args,
          env: data.env,
          inheritGroupEnv: data.inheritGroupEnv,
          timeoutMs: data.timeoutSecs ? data.timeoutSecs * 1000 : null,
          confirm: data.confirm,
          confirmSecs: data.confirmSecs,
          confirmOnTimeout: data.confirmOnTimeout,
        };
        if (!_sfPreStepId) throw new Error('Missing pre-step id');
        await window.api.savePreScript(groupId, _sfPreStepId, payload);
      } else if (isCommand) {
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
          autoStart: item && 'autoStart' in item ? item.autoStart : false,
          schedule: data.schedule,
          confirm: data.confirm,
          confirmSecs: data.confirmSecs,
          confirmOnTimeout: data.confirmOnTimeout,
          // Preserve silenced patterns
          silencedPatterns:
            item && 'silencedPatterns' in item
              ? item.silencedPatterns
              : { warn: [], error: [] },
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
          schedule: data.schedule,
          confirm: data.confirm,
          confirmSecs: data.confirmSecs,
          confirmOnTimeout: data.confirmOnTimeout,
        };
        await window.api.saveAction(groupId, payload);
      }

      // Refresh allGroups silently (no full re-render)
      await loadGroups();

      // Merge the saved command/action/prescript slice back into draftGroup and storedGroup
      // so the sub-list reflects the updated item while parent-level edits are preserved.
      if (draftGroup && draftGroup.id === groupId) {
        const fresh = allGroups.find((g) => g.id === groupId);
        if (fresh) {
          if (storedGroup) {
            if (isPreScript) {
              const freshSlice = structuredClone(fresh.preSteps);
              storedGroup.preSteps = freshSlice;
              draftGroup.preSteps = structuredClone(freshSlice);
            } else if (isCommand) {
              const freshSlice = structuredClone(fresh.commands);
              storedGroup.commands = freshSlice;
              draftGroup.commands = structuredClone(freshSlice);
            } else {
              const freshSlice = structuredClone(fresh.actions);
              storedGroup.actions = freshSlice;
              draftGroup.actions = structuredClone(freshSlice);
            }
          }
        }
        // Re-render from draftGroup (parent edits preserved)
        renderGroupDetail();
      } else {
        // No draft active — fall back to full reload
        renderGroupDetail();
      }

      showToast(
        `${isCommand ? 'Comando' : isPreScript ? 'Pre-script' : 'Acción'} guardado`,
        'ok',
      );
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
    }
  };

  subDialog.showModal();
}

// ── Sub-dialog folder picker for cwd field ─────────────────────────────
const sfCwdPickBtn = byId<HTMLButtonElement>('sf-cwd-pick', HTMLButtonElement);
sfCwdPickBtn.addEventListener('click', async () => {
  const res = await window.api.pickFolder(sfCwd.value || undefined);
  if (res.canceled) return;
  if (!res.ok) {
    showToast(`Error: ${res.error || 'desconocido'}`, 'error');
    return;
  }
  if (!res.path) return;
  sfCwd.value = res.path;
  sfCwd.dispatchEvent(new Event('input', { bubbles: true }));
});

subForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const args = sfArgs.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const maxLogLinesStr = sfMaxLogLines ? sfMaxLogLines.value : '';
  const maxLogLines =
    maxLogLinesStr === '' ? null : Number(maxLogLinesStr) || null;
  const timeoutSecsStr = sfTimeoutSecs ? sfTimeoutSecs.value.trim() : '';
  const timeoutSecs = timeoutSecsStr ? parseInt(timeoutSecsStr, 10) : null;
  const confirmSecsStr = sfConfirmSecs ? sfConfirmSecs.value.trim() : '';
  const confirmSecs = confirmSecsStr ? parseInt(confirmSecsStr, 10) : null;
  const data: SubFormData = {
    icon: sfIconBtn.textContent,
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
    timeoutSecs,
    confirm: sfConfirm.checked,
    confirmSecs,
    confirmOnTimeout:
      sfConfirmOnTimeout.value === 'confirm' ? 'confirm' : 'cancel',
    schedule: {
      enabled: sfScheduleEnabled.checked,
      rules: readScheduleRules(),
    },
  };
  subDialog.close();
  if (subDialogCallback) await subDialogCallback(data);
});

byId<HTMLButtonElement>('sub-cancel', HTMLButtonElement).addEventListener(
  'click',
  (e) => {
    e.preventDefault();
    subDialog.close();
  },
);

// Shared modal chrome (honest × / Esc / backdrop) for the command editor.
wireModal(subDialog);

// ────────────────────── Sidebar navigation ─────────────────────────────
const configNav = byId<HTMLElement>('config-nav', HTMLElement);
const navItems = [...document.querySelectorAll<HTMLElement>('.nav-item')];
const sections = [...document.querySelectorAll<HTMLElement>('.config-section')];

const windowTitleEl = byId<HTMLElement>('window-title', HTMLElement);

function showSection(target: string | undefined): void {
  navItems.forEach((b) =>
    b.classList.toggle('active', b.dataset.target === target),
  );
  sections.forEach((s) =>
    s.classList.toggle('active', s.dataset.section === target),
  );
  // The section name lives in the title bar now. Take it from the nav item so
  // there is exactly one place where a section is named.
  const active = navItems.find((b) => b.dataset.target === target);
  const label =
    active?.querySelector<HTMLElement>('.nav-label')?.textContent?.trim() ?? '';
  if (label) {
    windowTitleEl.textContent = label;
    document.title = `DevBar — ${label}`;
  }
  try {
    if (target) localStorage.setItem('config-section', target);
  } catch {
    /* localStorage unavailable — session-only nav is fine */
  }
}

navItems.forEach((b) =>
  b.addEventListener('click', () => showSection(b.dataset.target)),
);

// Dev-only simulation panel. Both the module and its IPC handlers are stripped
// from packaged builds, so this stays inert there.
void (async () => {
  if (!(await window.api.isDev())) return;
  const content = document.querySelector<HTMLElement>('.config-content');
  if (!content) return;
  try {
    const { mountDevPanel } = await import('./dev/dev-panel.js');
    const { navButton, section } = mountDevPanel(configNav, content);
    navItems.push(navButton);
    sections.push(section);
    navButton.addEventListener('click', () => showSection('dev'));
  } catch {
    /* panel absent — nothing to mount */
  }
})();

const navCollapse = byId<HTMLButtonElement>('nav-collapse', HTMLButtonElement);
function setNavCollapsed(on: boolean): void {
  configNav.classList.toggle('collapsed', on);
  navCollapse.textContent = on ? '▨' : '◧';
  try {
    localStorage.setItem('config-nav-collapsed', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
navCollapse.addEventListener('click', () =>
  setNavCollapsed(!configNav.classList.contains('collapsed')),
);

// Restore persisted nav state.
try {
  const saved = localStorage.getItem('config-section');
  if (saved && navItems.some((b) => b.dataset.target === saved)) {
    showSection(saved);
  }
  setNavCollapsed(localStorage.getItem('config-nav-collapsed') === '1');
} catch {
  /* ignore */
}

const aboutGithub = document.getElementById('about-github');
if (aboutGithub) {
  aboutGithub.addEventListener('click', () =>
    window.api.openExternal('https://github.com/juanjoGonDev/devbar'),
  );
}

// Collapsible groups list (focus the editor by hiding the list).
const groupsCollapse = byId<HTMLButtonElement>(
  'groups-collapse',
  HTMLButtonElement,
);
const groupsTwoPane = byId<HTMLElement>('groups-two-pane', HTMLElement);
function setGroupsListCollapsed(on: boolean): void {
  groupsTwoPane.classList.toggle('list-collapsed', on);
  // Same glyph and same semantics as the logs window's sidebar toggle: it
  // shows which side is folded rather than which way you are travelling.
  groupsCollapse.textContent = on ? '▨' : '◧';
  try {
    localStorage.setItem('groups-list-collapsed', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
if (groupsCollapse && groupsTwoPane) {
  groupsCollapse.addEventListener('click', () =>
    setGroupsListCollapsed(!groupsTwoPane.classList.contains('list-collapsed')),
  );
  try {
    setGroupsListCollapsed(
      localStorage.getItem('groups-list-collapsed') === '1',
    );
  } catch {
    /* ignore */
  }
}

// Deep-link from the tray version chip: jump to "Acerca de" + open changelog.
if (window.api.onConfigGoto) {
  window.api.onConfigGoto((target) => {
    if (target === 'about' || target === 'about-changelog')
      showSection('about');
    if (target === 'about-changelog') {
      const el = document.getElementById('app-version');
      openChangelog(el ? el.textContent.replace(/^v/, '') : '');
    }
  });
}

// ────────────────────── Icon picker ────────────────────────────────────

let allIcons: readonly IconBatteryItem[] = [];

// Load the battery from the main process (single source of truth).
// Render an empty grid until it resolves, then re-render.
window.api
  .getIconBattery()
  .then((battery) => {
    allIcons = battery || [];
    renderIconGrid(iconSearchEl.value || '');
  })
  .catch(() => {
    // If IPC fails (e.g., test environment), allIcons stays []
  });

// macOS-style category order + Spanish headers (data stays English-keyed).
const ICON_GROUP_ORDER = [
  'Smileys & Emotion',
  'People & Body',
  'Animals & Nature',
  'Food & Drink',
  'Travel & Places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
] as const;
type IconGroup = (typeof ICON_GROUP_ORDER)[number] | 'Recientes';
const ICON_GROUP_LABELS: Record<IconGroup, string> = {
  'Smileys & Emotion': 'Caras y emociones',
  'People & Body': 'Personas',
  'Animals & Nature': 'Animales y naturaleza',
  'Food & Drink': 'Comida y bebida',
  'Travel & Places': 'Viajes y lugares',
  Activities: 'Actividades',
  Objects: 'Objetos',
  Symbols: 'Símbolos',
  Flags: 'Banderas',
  Recientes: 'Recientes',
};

const RECENT_ICONS_KEY = 'devbar.recentIcons';
const RECENT_ICONS_MAX = 20;

function getRecentIcons(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(RECENT_ICONS_KEY) || '[]',
    ) as unknown;
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .slice(0, RECENT_ICONS_MAX)
      : [];
  } catch {
    return [];
  }
}

function pushRecentIcon(emoji: string): void {
  const next = [emoji, ...getRecentIcons().filter((e) => e !== emoji)].slice(
    0,
    RECENT_ICONS_MAX,
  );
  try {
    localStorage.setItem(RECENT_ICONS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — recents just won't persist */
  }
}

function makeIconCell(item: IconBatteryItem): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'icon-cell';
  btn.title = item.label;
  btn.textContent = item.emoji;
  btn.addEventListener('click', () => {
    pushRecentIcon(item.emoji);
    if (iconPickerCallback) iconPickerCallback(item.emoji);
    closeIconPicker();
  });
  return btn;
}

// Representative glyph per tab (macOS-style).
const ICON_GROUP_TAB: Record<IconGroup, string> = {
  Recientes: '🕘',
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐶',
  'Food & Drink': '🍎',
  'Travel & Places': '🚗',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '❤️',
  Flags: '🏳️',
};

let activeIconGroup: IconGroup = 'Smileys & Emotion';

function iconsInGroup(group: IconGroup): IconBatteryItem[] {
  if (group === 'Recientes') {
    return getRecentIcons()
      .map((e) => allIcons.find((i) => i.emoji === e))
      .filter((item): item is IconBatteryItem => item !== undefined);
  }
  return allIcons.filter((i) => i.group === group);
}

// Tabs to show: Recents (only if any) + the macOS categories that have icons.
function availableIconTabs(): IconGroup[] {
  const tabs: IconGroup[] = [];
  if (getRecentIcons().length) tabs.push('Recientes');
  for (const g of ICON_GROUP_ORDER) {
    if (allIcons.some((i) => i.group === g)) tabs.push(g);
  }
  return tabs;
}

function renderIconTabs() {
  const tabsEl = document.getElementById('icon-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  for (const g of availableIconTabs()) {
    const btn = document.createElement('button');
    btn.className = 'icon-tab' + (g === activeIconGroup ? ' is-active' : '');
    btn.textContent = ICON_GROUP_TAB[g] || '•';
    btn.title = ICON_GROUP_LABELS[g] || g;
    btn.dataset.group = g;
    btn.addEventListener('click', () => {
      activeIconGroup = g;
      iconSearchEl.value = '';
      // Toggle active class in place — do NOT rebuild the tab bar here, or the
      // clicked button detaches mid-click and the outside-click handler treats
      // it as a click outside the picker and closes it.
      for (const t of tabsEl.querySelectorAll<HTMLElement>('.icon-tab')) {
        t.classList.toggle('is-active', t.dataset.group === g);
      }
      renderIconGrid('');
    });
    tabsEl.appendChild(btn);
  }
}

function renderIconGrid(filter: string): void {
  iconGridEl.innerHTML = '';
  const q = (filter || '').toLowerCase().trim();

  // Searching: flat results across ALL categories.
  const items = q
    ? allIcons.filter(
        (i) =>
          i.emoji.startsWith(q) ||
          i.label.toLowerCase().includes(q) ||
          (i.keywords && i.keywords.some((k) => k.includes(q))),
      )
    : iconsInGroup(activeIconGroup);

  const grid = document.createElement('div');
  grid.className = 'icon-grid';
  for (const item of items) grid.appendChild(makeIconCell(item));
  iconGridEl.appendChild(grid);
}

function openIconPicker(
  anchorEl: HTMLElement,
  onSelect: (emoji: string) => void,
): void {
  iconPickerCallback = onSelect;
  iconSearchEl.value = '';
  const tabs = availableIconTabs();
  activeIconGroup = tabs[0] || ICON_GROUP_ORDER[0];
  renderIconTabs();
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

function closeIconPicker(): void {
  iconPickerEl.setAttribute('hidden', '');
  iconPickerCallback = null;
}

iconSearchEl.addEventListener('input', () =>
  renderIconGrid(iconSearchEl.value),
);
document.addEventListener('click', (e) => {
  if (
    !iconPickerEl.hidden &&
    !(e.target instanceof Node && iconPickerEl.contains(e.target)) &&
    !(e.target instanceof Element && e.target.closest('.icon-btn'))
  ) {
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
    showToast(`Error: ${errorMessage(err)}`, 'error');
  }
});

// ────────────────────── Settings ───────────────────────────────────────

async function loadSettings() {
  const s = await window.api.getSettings();
  setAutostart.checked = !!s.autostart;
  setSilenceWarnings.checked = !!s.silenceWarnings;
  setSilenceErrors.checked = !!s.silenceErrors;
  if (setMaxLogLines)
    setMaxLogLines.value = String(
      s.maxLogLines != null ? s.maxLogLines : DEFAULT_MAX_LOG_LINES,
    );
  if (setNotifySuccess) setNotifySuccess.checked = s.notifySuccess !== false;
}

if (testNotifyBtn) {
  testNotifyBtn.addEventListener('click', async () => {
    await window.api.testNotification();
    showToast('Banner de prueba mostrado', 'ok');
  });
}

async function persistSettings() {
  const maxLogLinesRaw = setMaxLogLines ? setMaxLogLines.value : '';
  const maxLogLines =
    maxLogLinesRaw === ''
      ? DEFAULT_MAX_LOG_LINES
      : Number(maxLogLinesRaw) || DEFAULT_MAX_LOG_LINES;
  await window.api.saveSettings({
    autostart: setAutostart.checked,
    silenceWarnings: setSilenceWarnings.checked,
    silenceErrors: setSilenceErrors.checked,
    maxLogLines,
    notifySuccess: setNotifySuccess ? setNotifySuccess.checked : true,
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
if (setNotifySuccess)
  setNotifySuccess.addEventListener('change', persistSettings);

// ────────────────────── Backup / Restore ───────────────────────────────

(function wireBackupButtons() {
  const exportBtn = byId<HTMLButtonElement>('export-config', HTMLButtonElement);
  const importBtn = byId<HTMLButtonElement>('import-config', HTMLButtonElement);

  exportBtn.addEventListener('click', async () => {
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

  importBtn.addEventListener('click', async () => {
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
        const saved = await saveDraft();
        if (!saved) {
          // empty path — don't close; let the user fix it first
          _closingGuard = false;
          return;
        }
      } catch (err) {
        showToast(`Error: ${errorMessage(err)}`, 'error');
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

// ────────────────────── Updates ─────────────────────────────────────────

const checkUpdatesBtn = byId<HTMLButtonElement>(
  'check-updates',
  HTMLButtonElement,
);
const applyUpdateBtn = byId<HTMLButtonElement>(
  'apply-update',
  HTMLButtonElement,
);
const updateStatusEl = byId<HTMLElement>('update-status', HTMLElement);
let _currentVersion = '';

function renderUpdateStatus(s: UpdateStatus): void {
  if (!s || !updateStatusEl) return;
  if (s.currentVersion) _currentVersion = s.currentVersion;
  const last = s.lastCheckAt
    ? new Date(s.lastCheckAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'nunca';
  const ready = Boolean(
    s.available && s.staged && s.staged.version === s.available.version,
  );
  updateStatusEl.textContent = !s.available
    ? `Al día · última búsqueda ${last}`
    : ready
      ? `v${s.available.version} descargada, lista para instalar · última búsqueda ${last}`
      : `Actualización v${s.available.version} disponible · última búsqueda ${last}`;
  if (applyUpdateBtn) {
    if (s.available) {
      applyUpdateBtn.style.display = '';
      applyUpdateBtn.textContent = ready
        ? `Reiniciar e instalar v${s.available.version}`
        : `Actualizar a v${s.available.version}`;
    } else {
      applyUpdateBtn.style.display = 'none';
    }
  }
  // Same red dot as the tray, on the version chip in the sidebar.
  const versionEl = document.getElementById('app-version');
  if (versionEl) {
    versionEl.classList.toggle('has-update', !!s.available);
    versionEl.title = s.available
      ? `v${s.available.version} disponible — ver changelog`
      : 'Ver changelog';
  }
}

if (applyUpdateBtn) {
  applyUpdateBtn.addEventListener('click', async () => {
    applyUpdateBtn.disabled = true;
    let quitting = false;
    try {
      const res = await window.api.applyUpdate();
      if (res && res.ok)
        showToast(
          res.inPlace
            ? 'Instalando y reiniciando…'
            : 'Descargando actualización…',
          'ok',
        );
      else if (res && !res.cancelled)
        showToast(
          `No se pudo actualizar: ${res.error || 'desconocido'}`,
          'error',
        );
      quitting = Boolean(res && res.quitting);
    } finally {
      // App is about to quit to install — leave the button disabled.
      if (!quitting) applyUpdateBtn.disabled = false;
    }
  });
}

if (checkUpdatesBtn) {
  checkUpdatesBtn.addEventListener('click', async () => {
    checkUpdatesBtn.disabled = true;
    const prev = checkUpdatesBtn.textContent;
    checkUpdatesBtn.textContent = 'Buscando…';
    try {
      renderUpdateStatus(await window.api.checkForUpdates());
    } finally {
      checkUpdatesBtn.textContent = prev;
      checkUpdatesBtn.disabled = false;
    }
  });
}

if (window.api && window.api.getUpdateStatus) {
  window.api
    .getUpdateStatus()
    .then(renderUpdateStatus)
    .catch(() => {});
  // Live refresh from the automatic 5-minute checks.
  window.api.onUpdateStatus(renderUpdateStatus);
}

// ────────────────────── Init ───────────────────────────────────────────

loadSettings();
loadGroups();

// App version label next to the page title.
if (window.api && window.api.getAppVersion) {
  window.api
    .getAppVersion()
    .then((v) => {
      const el = document.getElementById('app-version');
      if (el && v) {
        el.textContent = `v${v}`;
        el.addEventListener('click', () => openChangelog(v));
      }
    })
    .catch(() => {
      /* leave the label empty on failure */
    });
}

installTooltips();
