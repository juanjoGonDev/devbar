import { wireModal } from '../modal.js';
import { buildEnvEditor, type EnvEditorHandle } from './env-editor.js';
import type { ScheduleEditor } from './schedule-editor.js';
import type {
  Action,
  Command,
  EnvEntry,
  PreScript,
  Schedule,
} from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import { errorMessage, type ShowToast } from './toast.js';

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

/** Every control the command/action/pre-script editor owns. */
interface SubDialogElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  cancel: HTMLButtonElement;
  iconBtn: HTMLButtonElement;
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
  cmdOnlyFields: HTMLElement;
  timeoutRow: HTMLElement;
  timeoutSecs: HTMLInputElement;
  confirmRow: HTMLElement;
  confirm: HTMLInputElement;
  confirmDetails: HTMLElement;
  confirmOnTimeout: HTMLSelectElement;
  confirmSecs: HTMLInputElement;
}

export interface SubDialogDeps {
  els: SubDialogElements;
  store: GroupStore;
  showToast: ShowToast;
  schedule: ScheduleEditor;
  openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (emoji: string) => void,
  ): void;
  loadGroups(): Promise<void>;
  renderGroupDetail(): void;
  refreshPipeline(): Promise<void>;
}

const DEFAULT_WARN = '\\bwarn(ing)?s?\\b';
const DEFAULT_ERROR = '\\berror(s)?\\b';

export interface SubDialog {
  open(item: EditableItem | null, kind: SubKind, groupId: string): void;
}

export function createSubDialog(deps: SubDialogDeps): SubDialog {
  const { els, store } = deps;
  let subDialogCallback: ((data: SubFormData) => unknown) | null = null;
  // Module-level ref so the submit handler can read the current editor state
  let envEditorHandle: EnvEditorHandle | null = null;

  function fillCommonFields(item: EditableItem | null, kind: SubKind): void {
    const isCommand = kind === 'command';
    const isPreScript = kind === 'prescript';
    els.title.textContent = item
      ? `Editar ${isCommand ? 'comando' : isPreScript ? 'pre-script' : 'acción'}: ${item.name}`
      : isCommand
        ? 'Nuevo comando'
        : isPreScript
          ? 'Nuevo pre-script'
          : 'Nueva acción';

    // Icon button — hidden for prescripts (they don't have icons)
    const sfIconField = document.querySelector<HTMLElement>('.sf-icon-field');
    if (sfIconField) sfIconField.style.display = isPreScript ? 'none' : '';
    els.iconBtn.textContent =
      (item && 'icon' in item ? item.icon : null) || (isCommand ? '⚙️' : '🪄');
    els.iconBtn.onclick = (e) => {
      deps.openIconPicker(
        e.currentTarget as HTMLButtonElement,
        (emoji: string) => {
          els.iconBtn.textContent = emoji;
        },
      );
    };

    els.name.value = item ? item.name : '';
    els.command.value = item ? item.command : '';
    els.args.value = item ? (item.args || []).join('\n') : '';

    // Action and prescript: inheritGroupEnv toggle
    if (!isCommand) {
      els.inheritGroupEnvRow.style.display = '';
      els.inheritGroupEnv.checked =
        item && 'inheritGroupEnv' in item ? item.inheritGroupEnv : false;
    } else {
      els.inheritGroupEnvRow.style.display = 'none';
    }

    // (auto-start lives in the commands list, not in this dialog.)

    // Build env editor — always interactive (no dimming)
    const initialEnv = item ? item.env || [] : [];
    envEditorHandle = buildEnvEditor(els.envEditor, initialEnv);
  }

  function fillGateFields(item: EditableItem | null, kind: SubKind): void {
    const isCommand = kind === 'command';
    const isPreScript = kind === 'prescript';

    // PreScript-only: timeout field
    if (els.timeoutRow)
      els.timeoutRow.style.display = isPreScript ? '' : 'none';
    if (els.timeoutSecs)
      els.timeoutSecs.value =
        item && 'timeoutMs' in item && item.timeoutMs
          ? String(Math.round(item.timeoutMs / 1000))
          : '';

    // Confirmation gate — available for commands, actions and pre-scripts.
    if (els.confirmRow) els.confirmRow.style.display = '';
    if (els.confirm) {
      els.confirm.checked = !!(item && item.confirm);
      if (els.confirmOnTimeout) {
        els.confirmOnTimeout.value = item?.confirmOnTimeout || 'cancel';
      }
      if (els.confirmSecs) {
        els.confirmSecs.value =
          item && item.confirmSecs != null ? String(item.confirmSecs) : '';
      }
      if (els.confirmDetails) {
        els.confirmDetails.style.display = els.confirm.checked ? '' : 'none';
      }
      els.confirm.onchange = () => {
        if (els.confirmDetails) {
          els.confirmDetails.style.display = els.confirm.checked ? '' : 'none';
        }
      };
    }

    // Command-only fields — hidden for actions and prescripts
    els.cmdOnlyFields.style.display = isCommand ? '' : 'none';
    if (isCommand) {
      const command = item && 'cwd' in item ? item : null;
      els.cwd.value = command?.cwd || '';
      els.warn.value = command?.warnRegex || DEFAULT_WARN;
      els.error.value = command?.errorRegex || DEFAULT_ERROR;
      els.silenceWarn.checked = command?.silenceWarnings ?? false;
      els.silenceErr.checked = command?.silenceErrors ?? false;
      els.maxLogLines.value =
        command?.maxLogLines != null ? String(command.maxLogLines) : '';
    }
  }

  async function persistItem(
    data: SubFormData,
    item: EditableItem | null,
    kind: SubKind,
    groupId: string,
  ): Promise<void> {
    if (kind === 'prescript') {
      await window.api.savePreScript(groupId, {
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
      });
      return;
    }
    if (kind === 'command') {
      await window.api.saveCommand(groupId, {
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
      });
      return;
    }
    await window.api.saveAction(groupId, {
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
    });
  }

  function makeSubmitCallback(
    item: EditableItem | null,
    kind: SubKind,
    groupId: string,
  ): (data: SubFormData) => Promise<void> {
    const isCommand = kind === 'command';
    const isPreScript = kind === 'prescript';
    return async (data: SubFormData) => {
      try {
        await persistItem(data, item, kind, groupId);

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

  function openSubDialog(
    item: EditableItem | null,
    kind: SubKind,
    groupId: string,
  ): void {
    fillCommonFields(item, kind);
    fillGateFields(item, kind);

    // Schedule editor — commands and actions, not pre-scripts.
    deps.schedule.setup(item, kind === 'prescript');

    subDialogCallback = makeSubmitCallback(item, kind, groupId);

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
      icon: els.iconBtn.textContent,
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

  // Shared modal chrome (honest × / Esc / backdrop) for the command editor.
  wireModal(els.dialog);

  return { open: openSubDialog };
}
