import { byId } from './view.js';

/**
 * Every element of the linked panel, resolved in one place:
 * tests/renderer-dom-contract.test.ts checks each lookup against
 * renderer/remote.html.
 */

export function panelElements() {
  return {
    reconnecting: byId<HTMLElement>('reconnecting', HTMLElement),
    toast: byId<HTMLElement>('toast', HTMLElement),
    noticesTab: byId<HTMLButtonElement>('notices-tab', HTMLButtonElement),
    unreadBadge: byId<HTMLElement>('unread-badge', HTMLElement),
    groups: {
      hostName: byId<HTMLElement>('host-name', HTMLElement),
      hostStatus: byId<HTMLElement>('host-status', HTMLElement),
      stopAll: byId<HTMLButtonElement>('stop-all', HTMLButtonElement),
      errorChip: byId<HTMLElement>('error-chip', HTMLElement),
      warnChip: byId<HTMLElement>('warn-chip', HTMLElement),
      runPipeline: byId<HTMLButtonElement>('run-pipeline', HTMLButtonElement),
      pipelineLabel: byId<HTMLElement>('pipeline-label', HTMLElement),
      confirmBanner: byId<HTMLButtonElement>(
        'confirm-banner',
        HTMLButtonElement,
      ),
      confirmBannerTitle: byId<HTMLElement>(
        'confirm-banner-title',
        HTMLElement,
      ),
      confirmBannerSub: byId<HTMLElement>('confirm-banner-sub', HTMLElement),
      updateBanner: byId<HTMLButtonElement>('update-banner', HTMLButtonElement),
      updateBannerTitle: byId<HTMLElement>('update-banner-title', HTMLElement),
      empty: byId<HTMLElement>('groups-empty', HTMLElement),
      list: byId<HTMLElement>('groups', HTMLElement),
    },
    branches: {
      sheet: byId<HTMLDialogElement>('branch-sheet', HTMLDialogElement),
      status: byId<HTMLElement>('branch-status', HTMLElement),
      list: byId<HTMLUListElement>('branch-list', HTMLUListElement),
      close: byId<HTMLButtonElement>('branch-close', HTMLButtonElement),
    },
    logs: {
      process: byId<HTMLSelectElement>('log-process', HTMLSelectElement),
      countAll: byId<HTMLElement>('count-all', HTMLElement),
      countWarn: byId<HTMLElement>('count-warn', HTMLElement),
      countError: byId<HTMLElement>('count-error', HTMLElement),
      panel: byId<HTMLElement>('log-panel', HTMLElement),
      empty: byId<HTMLElement>('log-empty', HTMLElement),
      follow: byId<HTMLButtonElement>('log-follow', HTMLButtonElement),
      restart: byId<HTMLButtonElement>('log-restart', HTMLButtonElement),
      toggle: byId<HTMLButtonElement>('log-toggle', HTMLButtonElement),
    },
    notices: {
      markRead: byId<HTMLButtonElement>('mark-read', HTMLButtonElement),
      card: byId<HTMLElement>('confirm-card', HTMLElement),
      cardGroup: byId<HTMLElement>('confirm-card-group', HTMLElement),
      cardTitle: byId<HTMLElement>('confirm-card-title', HTMLElement),
      cardCommand: byId<HTMLElement>('confirm-card-command', HTMLElement),
      cardCancel: byId<HTMLButtonElement>(
        'confirm-card-cancel',
        HTMLButtonElement,
      ),
      cardRun: byId<HTMLButtonElement>('confirm-card-run', HTMLButtonElement),
      cardNote: byId<HTMLElement>('confirm-card-note', HTMLElement),
      empty: byId<HTMLElement>('notices-empty', HTMLElement),
      list: byId<HTMLElement>('notices', HTMLElement),
    },
    settings: {
      updateTitle: byId<HTMLElement>('update-title', HTMLElement),
      updateText: byId<HTMLElement>('update-text', HTMLElement),
      updateProgress: byId<HTMLProgressElement>(
        'update-progress',
        HTMLProgressElement,
      ),
      updateApply: byId<HTMLButtonElement>('update-apply', HTMLButtonElement),
      autostart: byId<HTMLInputElement>('set-autostart', HTMLInputElement),
      notifySuccess: byId<HTMLInputElement>(
        'set-notifySuccess',
        HTMLInputElement,
      ),
      silenceWarnings: byId<HTMLInputElement>(
        'set-silenceWarnings',
        HTMLInputElement,
      ),
      silenceErrors: byId<HTMLInputElement>(
        'set-silenceErrors',
        HTMLInputElement,
      ),
      rename: byId<HTMLButtonElement>('rename', HTMLButtonElement),
      deviceName: byId<HTMLElement>('device-name-value', HTMLElement),
      renameForm: byId<HTMLFormElement>('rename-form', HTMLFormElement),
      renameInput: byId<HTMLInputElement>('rename-input', HTMLInputElement),
      renameError: byId<HTMLElement>('rename-error', HTMLElement),
      renameCancel: byId<HTMLButtonElement>('rename-cancel', HTMLButtonElement),
      linkedOn: byId<HTMLElement>('device-linked', HTMLElement),
      unlink: byId<HTMLButtonElement>('unlink', HTMLButtonElement),
      footer: byId<HTMLElement>('connected-footer', HTMLElement),
      securityCode: byId<HTMLElement>('security-code', HTMLElement),
      securityStatus: byId<HTMLElement>('security-status', HTMLElement),
      rotateKeys: byId<HTMLButtonElement>('rotate-keys', HTMLButtonElement),
    },
    confirm: {
      dialog: byId<HTMLDialogElement>('confirm-dialog', HTMLDialogElement),
      group: byId<HTMLElement>('confirm-group', HTMLElement),
      title: byId<HTMLElement>('confirm-title', HTMLElement),
      command: byId<HTMLElement>('confirm-command', HTMLElement),
      run: byId<HTMLButtonElement>('confirm-run', HTMLButtonElement),
      cancel: byId<HTMLButtonElement>('confirm-cancel', HTMLButtonElement),
      footer: byId<HTMLElement>('confirm-footer', HTMLElement),
      closed: byId<HTMLElement>('confirm-closed', HTMLElement),
    },
  };
}

export type PanelElements = ReturnType<typeof panelElements>;
