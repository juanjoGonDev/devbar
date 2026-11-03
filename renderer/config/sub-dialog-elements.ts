import { byId } from '../dom.js';
import type { ScheduleEditorElements } from './schedule-editor.js';
import type { SubDialogElements } from './sub-dialog.js';

/**
 * Every control of the command / action / pre-script side sheet and its
 * schedule block, resolved in one place: config.ts calls this once, and
 * tests/renderer-dom-contract.test.ts checks each assertion against
 * config.html.
 */
export function subDialogElements(): {
  els: SubDialogElements;
  schedule: ScheduleEditorElements;
} {
  return {
    els: {
      dialog: byId<HTMLDialogElement>('sub-dialog', HTMLDialogElement),
      form: byId<HTMLFormElement>('sub-form', HTMLFormElement),
      title: byId<HTMLElement>('sub-dialog-title', HTMLElement),
      cancel: byId<HTMLButtonElement>('sub-cancel', HTMLButtonElement),
      iconBtn: byId<HTMLButtonElement>('sf-icon-btn', HTMLButtonElement),
      iconField: byId<HTMLElement>('sf-icon-field', HTMLElement),
      kindTile: byId<HTMLElement>('sf-kind-tile', HTMLElement),
      overline: byId<HTMLElement>('sf-overline', HTMLElement),
      cwdHint: byId<HTMLElement>('sf-cwd-hint', HTMLElement),
      name: byId<HTMLInputElement>('sf-name', HTMLInputElement),
      command: byId<HTMLInputElement>('sf-command', HTMLInputElement),
      args: byId<HTMLTextAreaElement>('sf-args', HTMLTextAreaElement),
      envEditor: byId<HTMLElement>('sf-env-editor', HTMLElement),
      inheritGroupEnvRow: byId<HTMLElement>(
        'sf-inherit-group-env-row',
        HTMLElement,
      ),
      inheritGroupEnv: byId<HTMLInputElement>(
        'sf-inherit-group-env',
        HTMLInputElement,
      ),
      cwd: byId<HTMLInputElement>('sf-cwd', HTMLInputElement),
      cwdPick: byId<HTMLButtonElement>('sf-cwd-pick', HTMLButtonElement),
      warn: byId<HTMLInputElement>('sf-warn', HTMLInputElement),
      error: byId<HTMLInputElement>('sf-error', HTMLInputElement),
      silenceWarn: byId<HTMLInputElement>('sf-silence-warn', HTMLInputElement),
      silenceErr: byId<HTMLInputElement>('sf-silence-err', HTMLInputElement),
      maxLogLines: byId<HTMLInputElement>('sf-max-log-lines', HTMLInputElement),
      timeoutRow: byId<HTMLElement>('sf-timeout-row', HTMLElement),
      timeoutSecs: byId<HTMLInputElement>('sf-timeout-secs', HTMLInputElement),
      confirmRow: byId<HTMLElement>('sf-confirm-row', HTMLElement),
      confirm: byId<HTMLInputElement>('sf-confirm', HTMLInputElement),
      confirmDetails: byId<HTMLElement>('sf-confirm-details', HTMLElement),
      confirmOnTimeout: byId<HTMLSelectElement>(
        'sf-confirm-on-timeout',
        HTMLSelectElement,
      ),
      confirmSecs: byId<HTMLInputElement>('sf-confirm-secs', HTMLInputElement),
      groupField: byId<HTMLElement>('sf-group-field', HTMLElement),
      group: byId<HTMLSelectElement>('sf-group', HTMLSelectElement),
      groupTile: byId<HTMLElement>('sf-group-tile', HTMLElement),
      pipelineNote: byId<HTMLElement>('sf-pipeline-note', HTMLElement),
      pipelineNoteName: byId<HTMLElement>('sf-pipeline-note-name', HTMLElement),
      submit: byId<HTMLButtonElement>('sf-submit', HTMLButtonElement),
      submitLabel: byId<HTMLElement>('sf-submit-label', HTMLElement),
      submitKey: byId<HTMLElement>('sf-submit-key', HTMLElement),
      deleteBtn: byId<HTMLButtonElement>('sf-delete', HTMLButtonElement),
      link: {
        modes: [
          byId<HTMLInputElement>('sf-link-mode-auto', HTMLInputElement),
          byId<HTMLInputElement>('sf-link-mode-custom', HTMLInputElement),
          byId<HTMLInputElement>('sf-link-mode-none', HTMLInputElement),
        ],
        autoPane: byId<HTMLElement>('sf-link-auto', HTMLElement),
        customPane: byId<HTMLElement>('sf-link-custom', HTMLElement),
        nonePane: byId<HTMLElement>('sf-link-none', HTMLElement),
        detected: byId<HTMLElement>('sf-link-detected', HTMLElement),
        prefix: byId<HTMLElement>('sf-link-prefix', HTMLElement),
        path: byId<HTMLInputElement>('sf-link-path', HTMLInputElement),
        url: byId<HTMLInputElement>('sf-link-url', HTMLInputElement),
        urlError: byId<HTMLElement>('sf-link-url-error', HTMLElement),
      },
    },
    schedule: {
      group: byId<HTMLElement>('sf-schedule-group', HTMLElement),
      enabled: byId<HTMLInputElement>('sf-schedule-enabled', HTMLInputElement),
      rules: byId<HTMLElement>('sf-schedule-rules', HTMLElement),
      add: byId<HTMLButtonElement>('sf-schedule-add', HTMLButtonElement),
      details: byId<HTMLElement>('sf-schedule-details', HTMLElement),
    },
  };
}
