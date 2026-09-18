import './report-uncaught.js';
import { byId } from './dom.js';
import { openChangelog } from './changelog.js';
import { initPipelineEditor } from './pipeline-editor.js';
import { installTooltips } from './tooltip.js';
import { initTheme } from './theme.js';
import { createToast, errorMessage } from './config/toast.js';
import { createScheduleEditor } from './config/schedule-editor.js';
import { createIconPicker } from './config/icon-picker.js';
import { createGroupStore } from './config/group-store.js';
import { createGroupsList } from './config/groups-list.js';
import { createGroupDetail } from './config/group-detail.js';
import { createSubLists } from './config/sub-lists.js';
import { createSubDialog } from './config/sub-dialog.js';
import { createSidebarNav } from './config/sidebar-nav.js';
import { createSettingsPane } from './config/settings-pane.js';
import { wireBackupButtons } from './config/backup-pane.js';
import { wireUpdatesPane } from './config/updates-pane.js';
initTheme();

// ────────────────────── DOM references ────────────────────────────────
// Every `byId` assertion in this window lives here: it runs at load time and
// throws on a tag mismatch, and `tests/renderer-dom-contract.test.ts`
// cross-checks this file against `config.html`. Extracted modules take their
// elements as arguments rather than looking them up again.
const groupsListEl = byId<HTMLElement>('groups-list', HTMLElement);
const groupDetailEl = byId<HTMLElement>('group-detail', HTMLElement);
const addGroupBtn = byId<HTMLButtonElement>('add-group', HTMLButtonElement);
const iconPickerEl = byId<HTMLDivElement>('icon-picker', HTMLDivElement);
const iconSearchEl = byId<HTMLInputElement>('icon-search', HTMLInputElement);
const iconGridEl = byId<HTMLElement>('icon-grid', HTMLElement);
const subDialogEl = byId<HTMLDialogElement>('sub-dialog', HTMLDialogElement);
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
const autostartHint = byId<HTMLElement>('autostart-hint', HTMLElement);
const notifHint = byId<HTMLElement>('notif-hint', HTMLElement);
const openNotifSettingsBtn = byId<HTMLButtonElement>(
  'open-notification-settings',
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
const sfCwdPickBtn = byId<HTMLButtonElement>('sf-cwd-pick', HTMLButtonElement);
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
const subCancelBtn = byId<HTMLButtonElement>('sub-cancel', HTMLButtonElement);

const configNav = byId<HTMLElement>('config-nav', HTMLElement);
const windowTitleEl = byId<HTMLElement>('window-title', HTMLElement);
const navCollapse = byId<HTMLButtonElement>('nav-collapse', HTMLButtonElement);
const groupsCollapse = byId<HTMLButtonElement>(
  'groups-collapse',
  HTMLButtonElement,
);
const groupsTwoPane = byId<HTMLElement>('groups-two-pane', HTMLElement);

const exportConfigBtn = byId<HTMLButtonElement>(
  'export-config',
  HTMLButtonElement,
);
const importConfigBtn = byId<HTMLButtonElement>(
  'import-config',
  HTMLButtonElement,
);

const checkUpdatesBtn = byId<HTMLButtonElement>(
  'check-updates',
  HTMLButtonElement,
);
const applyUpdateBtn = byId<HTMLButtonElement>(
  'apply-update',
  HTMLButtonElement,
);
const updateStatusEl = byId<HTMLElement>('update-status', HTMLElement);

// ────────────────────── Wiring ─────────────────────────────────────────
// Set once below — disjoint state from the group draft, per the pipeline
// editor's decoupling contract.
let pipelineEditor: ReturnType<typeof initPipelineEditor> | null = null;

/** Re-reads the pipeline from main, where referential-integrity pruning
 * already ran — called after a group-side save that can affect the global
 * pipeline (deleting a group or a pre-script definition prunes its refs). */
async function refreshPipeline(): Promise<void> {
  if (pipelineEditor) await pipelineEditor.refresh();
}

const showToast = createToast(toastEl);

const iconPicker = createIconPicker({
  picker: iconPickerEl,
  search: iconSearchEl,
  grid: iconGridEl,
  dialog: subDialogEl,
});
const openIconPicker = (
  anchorEl: HTMLElement,
  onSelect: (emoji: string) => void,
): void => iconPicker.open(anchorEl, onSelect);

const schedule = createScheduleEditor({
  group: sfScheduleGroup,
  enabled: sfScheduleEnabled,
  rules: sfScheduleRules,
  add: sfScheduleAdd,
  details: sfScheduleDetails,
});

const store = createGroupStore({
  showToast,
  renderGroupDetail: () => groupDetail.render(),
});

const groupsList = createGroupsList({
  listEl: groupsListEl,
  store,
  showToast,
  renderGroupDetail: () => groupDetail.render(),
});
const loadGroups = () => groupsList.load();

const subDialog = createSubDialog({
  els: {
    dialog: subDialogEl,
    form: subForm,
    title: subDialogTitle,
    cancel: subCancelBtn,
    iconBtn: sfIconBtn,
    name: sfName,
    command: sfCommand,
    args: sfArgs,
    envEditor: sfEnvEditor,
    inheritGroupEnvRow: sfInheritGroupEnvRow,
    inheritGroupEnv: sfInheritGroupEnv,
    cwd: sfCwd,
    cwdPick: sfCwdPickBtn,
    warn: sfWarn,
    error: sfError,
    silenceWarn: sfSilenceWarn,
    silenceErr: sfSilenceErr,
    maxLogLines: sfMaxLogLines,
    cmdOnlyFields,
    timeoutRow: sfTimeoutRow,
    timeoutSecs: sfTimeoutSecs,
    confirmRow: sfConfirmRow,
    confirm: sfConfirm,
    confirmDetails: sfConfirmDetails,
    confirmOnTimeout: sfConfirmOnTimeout,
    confirmSecs: sfConfirmSecs,
  },
  store,
  showToast,
  schedule,
  openIconPicker,
  loadGroups,
  renderGroupDetail: () => groupDetail.render(),
  refreshPipeline,
});

const subLists = createSubLists({
  store,
  showToast,
  openSubDialog: (item, kind, groupId) => subDialog.open(item, kind, groupId),
  loadGroups,
  renderGroupDetail: () => groupDetail.render(),
  refreshPipeline,
});

const groupDetail = createGroupDetail({
  detailEl: groupDetailEl,
  store,
  showToast,
  subLists,
  openIconPicker,
  loadGroups,
  renderGroupsList: () => groupsList.render(),
  refreshPipeline,
});

createSidebarNav({
  nav: configNav,
  windowTitle: windowTitleEl,
  navCollapse,
  groupsCollapse,
  groupsTwoPane,
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
    store.setSelectedId(saved.id);
    await loadGroups();
    groupDetail.render();
  } catch (err) {
    showToast(`Error: ${errorMessage(err)}`, 'error');
  }
});

const settings = createSettingsPane(
  {
    autostart: setAutostart,
    autostartHint,
    silenceWarnings: setSilenceWarnings,
    silenceErrors: setSilenceErrors,
    maxLogLines: setMaxLogLines,
    notifySuccess: setNotifySuccess,
    notifHint,
    openNotifSettings: openNotifSettingsBtn,
    testNotify: testNotifyBtn,
  },
  showToast,
);

wireBackupButtons({
  exportBtn: exportConfigBtn,
  importBtn: importConfigBtn,
  store,
  showToast,
  loadSettings: () => settings.load(),
  loadGroups,
  renderGroupDetail: () => groupDetail.render(),
  refreshPipeline,
});

// ────────────────────── Live updates ───────────────────────────────────

window.api.onUpdate(async () => {
  await loadGroups(); // refreshes allGroups + nav via renderGroupsList
  const selectedGroupId = store.getSelectedId();
  if (!selectedGroupId) return;
  if (store.isDirty()) {
    // Pane has unsaved edits — do NOT overwrite draftGroup.
    // The nav has already re-rendered via renderGroupsList inside loadGroups.
    return;
  }
  // Clean pane: re-sync draft from freshest stored data and re-render.
  store.loadDraftFromStored(selectedGroupId);
  groupDetail.render();
});

// ────────────────────── Window close guard ────────────────────────────

let _closingGuard = false;

if (window.api.onConfigCloseRequested) {
  window.api.onConfigCloseRequested(async () => {
    if (_closingGuard) return;
    if (!store.isDirty()) {
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
        const saved = await store.saveDraft();
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
    store.clearDraft();
    window.api.confirmCloseConfig();
  });
}

// ────────────────────── Updates ─────────────────────────────────────────

wireUpdatesPane(
  {
    checkBtn: checkUpdatesBtn,
    applyBtn: applyUpdateBtn,
    status: updateStatusEl,
  },
  showToast,
);

// ────────────────────── Init ───────────────────────────────────────────

void settings.load();

// Captured in a `const` rather than read back off the mutable `pipelineEditor`
// module binding: a `let` narrowed non-null by this very assignment is not
// guaranteed to stay narrowed inside the async callback below.
const editor = initPipelineEditor(
  byId('prescripts-pipeline-root', HTMLElement),
  { getGroups: () => store.getGroups(), showToast },
);
pipelineEditor = editor;
// The editor resolves every ref against `allGroups`, which `loadGroups()`
// only fills once `listGroups()` resolves. Refreshing before that renders
// perfectly valid refs as "Referencia rota".
void loadGroups().then(() => editor.refresh());

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
