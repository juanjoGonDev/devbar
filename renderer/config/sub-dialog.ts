import { userIcon } from '../icon.js';
import { customIconIdOf } from '../../src/custom-icons.js';
import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
} from '../../src/log-level-defaults.js';
import { createIconColorControl } from './icon-color-control.js';
import { wireModal } from '../modal.js';
import { buildEnvEditor, type EnvEditorHandle } from './env-editor.js';
import type { ScheduleEditor } from './schedule-editor.js';
import type { Group, PreScript } from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import { errorMessage, type ShowToast } from './toast.js';
import { fillGroupTile } from '../pipeline/group-tile.js';
import { createSheetSections } from './sheet-sections.js';
import { paintSummaries } from './sheet-summaries.js';
import {
  persistItem,
  type EditableItem,
  type SubFormData,
  type SubKind,
} from './sub-dialog-save.js';

/** Every control the command/action/pre-script side sheet owns. */
export interface SubDialogElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  cancel: HTMLButtonElement;
  iconBtn: HTMLButtonElement;
  /** The header tile holding the icon button (commands and actions). */
  iconField: HTMLElement;
  /** The fixed header tile of a pre-script, which has no icon. */
  kindTile: HTMLElement;
  /** «COMANDO · <GRUPO>» above the title. */
  overline: HTMLElement;
  /** The folder the item runs in, under the command field. */
  cwdHint: HTMLElement;
  name: HTMLInputElement;
  command: HTMLInputElement;
  args: HTMLTextAreaElement;
  envEditor: HTMLElement;
  inheritGroupEnvRow: HTMLElement;
  inheritGroupEnv: HTMLInputElement;
  cwd: HTMLInputElement;
  cwdPick: HTMLButtonElement;
  warn: HTMLInputElement;
  error: HTMLInputElement;
  silenceWarn: HTMLInputElement;
  silenceErr: HTMLInputElement;
  maxLogLines: HTMLInputElement;
  timeoutRow: HTMLElement;
  timeoutSecs: HTMLInputElement;
  confirmRow: HTMLElement;
  confirm: HTMLInputElement;
  confirmDetails: HTMLElement;
  confirmOnTimeout: HTMLSelectElement;
  confirmSecs: HTMLInputElement;
  /** The "Grupo" select, shown only when creating from the canvas. */
  groupField: HTMLElement;
  group: HTMLSelectElement;
  groupTile: HTMLElement;
  /** "Se colocará en el workflow después de …", from a canvas "+". */
  pipelineNote: HTMLElement;
  pipelineNoteName: HTMLElement;
  submit: HTMLButtonElement;
  submitLabel: HTMLElement;
}

export interface SubDialogDeps {
  els: SubDialogElements;
  store: GroupStore;
  showToast: ShowToast;
  schedule: ScheduleEditor;
  openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (value: string) => void,
  ): void;
  loadGroups(): Promise<void>;
  renderGroupDetail(): void;
  refreshPipeline(): Promise<void>;
}

/** Creating a pre-script from the pipeline, which belongs to no group. */
interface NewPreScriptRequest {
  /** The groups offered by the "Grupo" select, in this order. */
  groups: readonly Group[];
  /** The one selected at first. */
  groupId: string;
  /** The node the new script will follow, for the placement note. */
  after: string | null;
  /** Runs once the script is saved and the groups are re-read. */
  onCreated: (groupId: string, script: PreScript) => void | Promise<void>;
}

export interface SubDialog {
  open(item: EditableItem | null, kind: SubKind, groupId: string): void;
  openNewPreScript(request: NewPreScriptRequest): void;
}

const KIND_LABELS: Record<SubKind, { kind: string; fresh: string }> = {
  command: { kind: 'Comando', fresh: 'Nuevo comando' },
  action: { kind: 'Acción', fresh: 'Nueva acción' },
  prescript: { kind: 'Pre-script', fresh: 'Nuevo pre-script' },
};

export function createSubDialog(deps: SubDialogDeps): SubDialog {
  const { els, store } = deps;
  let subDialogCallback: ((data: SubFormData) => unknown) | null = null;
  // Module-level ref so the submit handler can read the current editor state
  let envEditorHandle: EnvEditorHandle | null = null;
  // Default icon of the kind being edited, for repaints from the colour segment.
  let defaultIcon: 'terminal' | 'wand-sparkles' = 'terminal';
  // What the sheet is editing, for the live header, hint and badges.
  let current: {
    kind: SubKind;
    isNew: boolean;
    group: () => Group | null;
  } = { kind: 'command', isNew: true, group: () => null };
  const sections = createSheetSections(els.dialog);
  const paintIcon = (): void => {
    const value = els.iconBtn.dataset.value || defaultIcon;
    els.iconBtn.replaceChildren(
      userIcon(value, defaultIcon, colorControl.value()),
    );
    colorControl.setImage(customIconIdOf(value) !== null);
  };
  // Built once around the icon button; each open() loads the item's colour.
  const colorControl = createIconColorControl(els.iconBtn, paintIcon);

  /** The group as the pane holds it: the draft when it is the one open. */
  function groupById(groupId: string): Group | null {
    const draft = store.getDraft();
    if (draft && draft.id === groupId) return draft;
    return store.getGroups().find((group) => group.id === groupId) ?? null;
  }

  /** Header, cwd hint and badges, from what the fields hold right now. */
  function refreshLive(): void {
    const { kind, isNew } = current;
    const labels = KIND_LABELS[kind];
    const group = current.group();
    els.overline.textContent = group
      ? `${labels.kind} · ${group.name}`
      : labels.kind;
    els.title.textContent =
      els.name.value.trim() || (isNew ? labels.fresh : 'Sin nombre');
    const cwd = kind === 'command' ? els.cwd.value.trim() : '';
    els.cwdHint.textContent = cwd || group?.path || '';

    paintSummaries(sections, kind, readFormData());
  }

  function fillCommonFields(item: EditableItem | null, kind: SubKind): void {
    const isCommand = kind === 'command';
    const isPreScript = kind === 'prescript';
    els.dialog.setAttribute(
      'aria-label',
      item
        ? `Editar ${KIND_LABELS[kind].kind.toLowerCase()}`
        : KIND_LABELS[kind].fresh,
    );

    // The header tile picks the icon; pre-scripts have none, so they get a
    // fixed tile instead.
    els.iconField.hidden = isPreScript;
    els.kindTile.hidden = !isPreScript;
    defaultIcon = isCommand ? 'terminal' : 'wand-sparkles';
    const setIcon = (value: string): void => {
      // The button shows the icon; the stored value rides in a data
      // attribute, since the glyph's text is a private-use codepoint.
      els.iconBtn.dataset.value = value;
      paintIcon();
    };
    colorControl.set(item && 'iconColor' in item ? item.iconColor : null);
    setIcon((item && 'icon' in item ? item.icon : null) || defaultIcon);
    els.iconBtn.onclick = (e) => {
      deps.openIconPicker(e.currentTarget as HTMLButtonElement, setIcon);
    };

    els.name.value = item ? item.name : '';
    els.command.value = item ? item.command : '';
    els.args.value = item ? (item.args || []).join('\n') : '';

    // Actions and pre-scripts can inherit the group's variables.
    els.inheritGroupEnvRow.hidden = isCommand;
    els.inheritGroupEnv.checked =
      !isCommand && item && 'inheritGroupEnv' in item
        ? item.inheritGroupEnv
        : false;

    // (auto-start lives in the commands list, not in this sheet.)

    const initialEnv = item ? item.env || [] : [];
    envEditorHandle = buildEnvEditor(els.envEditor, initialEnv);
  }

  function fillGateFields(item: EditableItem | null, kind: SubKind): void {
    const isCommand = kind === 'command';
    const isPreScript = kind === 'prescript';

    // Pre-scripts only: the timeout.
    els.timeoutRow.hidden = !isPreScript;
    els.timeoutSecs.value =
      item && 'timeoutMs' in item && item.timeoutMs
        ? String(Math.round(item.timeoutMs / 1000))
        : '';

    // Confirmation gate — commands, actions and pre-scripts alike.
    els.confirm.checked = !!(item && item.confirm);
    els.confirmOnTimeout.value = item?.confirmOnTimeout || 'cancel';
    els.confirmSecs.value =
      item && item.confirmSecs != null ? String(item.confirmSecs) : '';
    const syncConfirm = (): void => {
      els.confirmDetails.style.display = els.confirm.checked ? '' : 'none';
    };
    syncConfirm();
    els.confirm.onchange = syncConfirm;

    // «Logs y detección» — commands only; the sections decide visibility.
    const command = isCommand && item && 'cwd' in item ? item : null;
    els.cwd.value = command?.cwd || '';
    els.warn.value = command?.warnRegex || DEFAULT_WARN_REGEX;
    els.error.value = command?.errorRegex || DEFAULT_ERROR_REGEX;
    els.silenceWarn.checked = command?.silenceWarnings ?? false;
    els.silenceErr.checked = command?.silenceErrors ?? false;
    els.maxLogLines.value =
      command?.maxLogLines != null ? String(command.maxLogLines) : '';
  }

  function makeSubmitCallback(
    item: EditableItem | null,
    kind: SubKind,
    resolveGroupId: () => string,
    onCreated?: NewPreScriptRequest['onCreated'],
  ): (data: SubFormData) => Promise<void> {
    const isCommand = kind === 'command';
    const isPreScript = kind === 'prescript';
    return async (data: SubFormData) => {
      // Read before the save: the select is only shown for this one flow.
      const groupId = resolveGroupId();
      try {
        const saved = await persistItem(data, item, kind, groupId);

        // Refresh allGroups silently (no full re-render)
        await deps.loadGroups();

        // Merge the saved command/action/prescript slice back into draftGroup
        // and storedGroup so the sub-list reflects the updated item while
        // parent-level edits are preserved.
        store.adoptSavedSlice(
          groupId,
          isPreScript ? 'preScripts' : isCommand ? 'commands' : 'actions',
        );
        // Re-render from draftGroup (parent edits preserved); with no draft
        // active this is the same full reload the old code fell back to.
        deps.renderGroupDetail();

        if (onCreated && saved) await onCreated(groupId, saved);

        // A rename/edit here changes what the pipeline's own script rows
        // display (name, command, timeout) — refresh it too.
        if (isPreScript) await deps.refreshPipeline();

        deps.showToast(
          isCommand
            ? 'Comando guardado'
            : isPreScript
              ? 'Pre-script guardado'
              : 'Acción guardada',
          'ok',
        );
      } catch (err) {
        deps.showToast(`Error: ${errorMessage(err)}`, 'error');
      }
    };
  }

  /** The chrome only the create-from-pipeline flow shows, on or off. */
  function showCreateChrome(request: NewPreScriptRequest | null): void {
    els.groupField.hidden = request === null;
    els.pipelineNote.hidden = request?.after == null;
    els.pipelineNoteName.textContent = request?.after ?? '';
    els.submitLabel.textContent = request ? 'Crear' : 'Guardar';
    if (!request) return;
    els.group.replaceChildren(
      ...request.groups.map((group) => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        return option;
      }),
    );
    els.group.value = request.groupId;
    const paintTile = (): void => {
      fillGroupTile(
        els.groupTile,
        request.groups.find((group) => group.id === els.group.value) ?? null,
      );
      refreshLive();
    };
    els.group.onchange = paintTile;
    paintTile();
  }

  function fill(item: EditableItem | null, kind: SubKind): void {
    fillCommonFields(item, kind);
    fillGateFields(item, kind);
    // Schedule editor — commands and actions, not pre-scripts.
    deps.schedule.setup(item, kind === 'prescript');
    sections.show(kind);
  }

  function openSubDialog(
    item: EditableItem | null,
    kind: SubKind,
    groupId: string,
  ): void {
    current = { kind, isNew: item === null, group: () => groupById(groupId) };
    fill(item, kind);
    showCreateChrome(null);
    refreshLive();
    subDialogCallback = makeSubmitCallback(item, kind, () => groupId);
    els.dialog.showModal();
  }

  function openNewPreScript(request: NewPreScriptRequest): void {
    current = {
      kind: 'prescript',
      isNew: true,
      group: () =>
        request.groups.find((group) => group.id === els.group.value) ?? null,
    };
    fill(null, 'prescript');
    showCreateChrome(request);
    refreshLive();
    subDialogCallback = makeSubmitCallback(
      null,
      'prescript',
      () => els.group.value || request.groupId,
      request.onCreated,
    );
    els.dialog.showModal();
  }

  function readFormData(): SubFormData {
    const args = els.args.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const maxLogLinesStr = els.maxLogLines ? els.maxLogLines.value : '';
    const maxLogLines =
      maxLogLinesStr === '' ? null : Number(maxLogLinesStr) || null;
    const timeoutSecsStr = els.timeoutSecs ? els.timeoutSecs.value.trim() : '';
    const timeoutSecs = timeoutSecsStr ? parseInt(timeoutSecsStr, 10) : null;
    const confirmSecsStr = els.confirmSecs ? els.confirmSecs.value.trim() : '';
    const confirmSecs = confirmSecsStr ? parseInt(confirmSecsStr, 10) : null;
    return {
      icon: els.iconBtn.dataset.value || null,
      // Kept even under an image (which it cannot tint), so switching back
      // to a glyph brings the colour back.
      iconColor: colorControl.value(),
      name: els.name.value.trim(),
      command: els.command.value.trim(),
      args,
      env: envEditorHandle ? envEditorHandle.getEntries() : [],
      inheritGroupEnv: els.inheritGroupEnv.checked,
      cwd: els.cwd.value.trim(),
      warnRegex: els.warn.value.trim(),
      errorRegex: els.error.value.trim(),
      silenceWarnings: els.silenceWarn.checked,
      silenceErrors: els.silenceErr.checked,
      maxLogLines,
      timeoutSecs,
      confirm: els.confirm.checked,
      confirmSecs,
      confirmOnTimeout:
        els.confirmOnTimeout.value === 'confirm' ? 'confirm' : 'cancel',
      schedule: deps.schedule.readSchedule(),
    };
  }

  // ── Sub-dialog folder picker for cwd field ─────────────────────────────
  els.cwdPick.addEventListener('click', async () => {
    const res = await window.api.pickFolder(els.cwd.value || undefined);
    if (res.canceled) return;
    if (!res.ok) {
      deps.showToast(`Error: ${res.error || 'desconocido'}`, 'error');
      return;
    }
    if (!res.path) return;
    els.cwd.value = res.path;
    els.cwd.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Every edit refreshes the live title, cwd hint and section badges.
  els.form.addEventListener('input', refreshLive);
  els.form.addEventListener('change', refreshLive);
  els.form.addEventListener('click', (e) => {
    // Env rows and schedule chips change state through buttons.
    if (e.target instanceof Element && e.target.closest('button'))
      refreshLive();
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = readFormData();
    els.dialog.close();
    if (subDialogCallback) await subDialogCallback(data);
  });

  els.cancel.addEventListener('click', (e) => {
    e.preventDefault();
    els.dialog.close();
  });

  // Shared modal chrome (honest × / Esc / backdrop) for the side sheet.
  wireModal(els.dialog);

  return { open: openSubDialog, openNewPreScript };
}
