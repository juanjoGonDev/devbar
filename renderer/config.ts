import './report-uncaught.js';
import { byId } from './dom.js';
import { openChangelog } from './changelog.js';
import { createWorkflowsSection } from './workflows/section.js';
import { installTooltips } from './tooltip.js';
import { initTheme } from './theme.js';
import { hydrateIcons } from './icon.js';
import { createToast, errorMessage } from './config/toast.js';
import { createScheduleEditor } from './config/schedule-editor.js';
import { createIconPicker } from './config/icon-picker.js';
import { watchCustomIcons } from './custom-icons.js';
import { createGroupStore } from './config/group-store.js';
import { createGroupsList } from './config/groups-list.js';
import { createGroupsSplitter } from './config/groups-splitter.js';
import { createGroupDetail } from './config/group-detail.js';
import { createSubLists } from './config/sub-lists.js';
import { createSubDialog } from './config/sub-dialog.js';
import { subDialogElements } from './config/sub-dialog-elements.js';
import { createSidebarNav } from './config/sidebar-nav.js';
import { createSettingsPane } from './config/settings-pane.js';
import { wireBackupButtons } from './config/backup-pane.js';
import { wireUpdatesPane } from './config/updates-pane.js';
import { aboutVersionLine } from './config/about-pane.js';
import { showReleaseNotes } from './config/about-notes.js';
import { createRemotePane } from './config/remote-pane.js';
import { remoteElements } from './config/remote-elements.js';
initTheme();
hydrateIcons(document);

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
const toastEl = byId<HTMLElement>('toast', HTMLElement);
const subDialogEls = subDialogElements();

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
const setShowHiddenWorkflowsFold = byId<HTMLInputElement>(
  'set-show-hidden-workflows-fold',
  HTMLInputElement,
);
const setShowHiddenGroupsFold = byId<HTMLInputElement>(
  'set-show-hidden-groups-fold',
  HTMLInputElement,
);
const testNotifyBtn = byId<HTMLButtonElement>(
  'test-notification',
  HTMLButtonElement,
);
const resetTrayPositionBtn = byId<HTMLButtonElement>(
  'reset-tray-position-config',
  HTMLButtonElement,
);
const autostartHint = byId<HTMLElement>('autostart-hint', HTMLElement);
const notifHint = byId<HTMLElement>('notif-hint', HTMLElement);
const openNotifSettingsBtn = byId<HTMLButtonElement>(
  'open-notification-settings',
  HTMLButtonElement,
);

const configNav = byId<HTMLElement>('config-nav', HTMLElement);
const windowTitleEl = byId<HTMLElement>('window-title', HTMLElement);
const navCollapse = byId<HTMLButtonElement>('nav-collapse', HTMLButtonElement);
const groupsCollapse = byId<HTMLButtonElement>(
  'groups-collapse',
  HTMLButtonElement,
);
const groupsTwoPane = byId<HTMLElement>('groups-two-pane', HTMLElement);
const groupsSplitterEl = byId<HTMLElement>('groups-splitter', HTMLElement);
const workflowsListEl = byId<HTMLElement>('workflows-list-root', HTMLElement);
const workflowsEditorEl = byId<HTMLElement>(
  'prescripts-pipeline-root',
  HTMLElement,
);
const workflowsBadgeEl = byId<HTMLElement>('workflows-badge', HTMLElement);

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
const aboutVersionEl = byId<HTMLElement>('about-version', HTMLElement);

// ────────────────────── Wiring ─────────────────────────────────────────
// Set once below — disjoint state from the group draft, per the workflow
// editor's decoupling contract.
let workflows: ReturnType<typeof createWorkflowsSection> | null = null;

/** Re-reads the open workflow from main, where referential-integrity pruning
 * already ran — called after a group-side save that can affect a workflow
 * (deleting a group or a pre-script definition prunes its refs). */
async function refreshPipeline(): Promise<void> {
  if (workflows) await workflows.refresh();
}

const showToast = createToast(toastEl);

const iconPicker = createIconPicker({
  picker: iconPickerEl,
  search: iconSearchEl,
  grid: iconGridEl,
  dialog: subDialogEls.els.dialog,
});
const openIconPicker = (
  anchorEl: HTMLElement,
  onSelect: (value: string) => void,
): void => iconPicker.open(anchorEl, onSelect);
// Uploaded icons: every `img:<id>` on screen repaints in place, and an open
// picker re-lists the library.
watchCustomIcons(() => iconPicker.refresh());

const schedule = createScheduleEditor(subDialogEls.schedule);

const store = createGroupStore({
  showToast,
  renderGroupDetail: () => groupDetail.render(),
});

const groupsSplitter = createGroupsSplitter({
  twoPane: groupsTwoPane,
  pane: groupsListEl.parentElement ?? groupsListEl,
  handle: groupsSplitterEl,
  listEl: groupsListEl,
});

const groupsList = createGroupsList({
  listEl: groupsListEl,
  store,
  showToast,
  renderGroupDetail: () => groupDetail.render(),
  onRendered: () => groupsSplitter.refresh(),
});
const loadGroups = () => groupsList.load();

const subDialog = createSubDialog({
  els: subDialogEls.els,
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
  onWorkflows: () => workflows?.showList(),
});

// ────────────────────── Add group ──────────────────────────────────────

addGroupBtn.addEventListener('click', async () => {
  const newGroup = {
    name: 'Nuevo grupo',
    icon: 'package',
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
    showHiddenGroupsFold: setShowHiddenGroupsFold,
    showHiddenWorkflowsFold: setShowHiddenWorkflowsFold,
    notifHint,
    openNotifSettings: openNotifSettingsBtn,
    testNotify: testNotifyBtn,
    resetTrayPosition: resetTrayPositionBtn,
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

createRemotePane(remoteElements(), showToast);

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

// Captured in a `const` rather than read back off the mutable `workflows`
// module binding: a `let` narrowed non-null by this very assignment is not
// guaranteed to stay narrowed inside the async callback below.
const section = createWorkflowsSection({
  listHost: workflowsListEl,
  editorHost: workflowsEditorEl,
  badge: workflowsBadgeEl,
  getGroups: () => store.getGroups(),
  showToast,
  editScript: (groupId, script) => subDialog.open(script, 'prescript', groupId),
  createScript: (request) => subDialog.openNewPreScript(request),
});
workflows = section;
// The list and the editor resolve every ref against `allGroups`, which
// `loadGroups()` only fills once `listGroups()` resolves. Reading before
// that renders perfectly valid refs as "Referencia rota".
void loadGroups().then(() => section.load());

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
      // `arch` is a static preload value; anything else means an older
      // preload that does not publish it.
      const arch: unknown = window.api.arch;
      aboutVersionEl.textContent = aboutVersionLine(
        v,
        window.api.platform,
        typeof arch === 'string' ? arch : undefined,
      );
      if (v) void showReleaseNotes(v);
    })
    .catch(() => {
      /* leave the label empty on failure */
    });
}

installTooltips();
