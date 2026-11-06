import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
} from '../../src/log-level-defaults.js';
import type {
  Action,
  Command,
  CommandLink,
  EnvEntry,
  PreScript,
  Schedule,
} from '../../src/domain-types.js';

/** The item the side sheet edits, and which kind it is. */
export type EditableItem = Command | Action | PreScript;
export type SubKind = 'command' | 'action' | 'prescript';

/** Everything the side sheet's fields hold, read in one go. */
export interface SubFormData {
  icon: string | null;
  iconColor: string | null;
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
  /** Commands only: what «abrir» opens. */
  link: CommandLink;
}

/**
 * Writes what the sheet holds through the IPC call of its kind. Returns the
 * saved pre-script (its id is needed to place it in a workflow), else null.
 */
export async function persistItem(
  data: SubFormData,
  item: EditableItem | null,
  kind: SubKind,
  groupId: string,
): Promise<PreScript | null> {
  if (kind === 'prescript') {
    return window.api.savePreScript(groupId, {
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
  }
  if (kind === 'command') {
    await window.api.saveCommand(groupId, {
      id: item ? item.id : undefined,
      icon: data.icon || null,
      iconColor: data.iconColor,
      name: data.name,
      command: data.command,
      args: data.args,
      env: data.env,
      cwd: data.cwd || null,
      warnRegex: data.warnRegex || DEFAULT_WARN_REGEX,
      errorRegex: data.errorRegex || DEFAULT_ERROR_REGEX,
      silenceWarnings: data.silenceWarnings,
      silenceErrors: data.silenceErrors,
      maxLogLines: data.maxLogLines,
      // Preserve existing autoStart — the toggle for it lives in the
      // commands list now, not in this sheet.
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
      link: data.link,
    });
    return null;
  }
  await window.api.saveAction(groupId, {
    id: item ? item.id : undefined,
    icon: data.icon || null,
    iconColor: data.iconColor,
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
  return null;
}
