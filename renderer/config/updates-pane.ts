import { latestWins } from '../latest-wins.js';
import { describeUpdate } from './update-view.js';
import type { UpdatePhase, UpdateStatus } from '../../src/ipc-contract.js';
import type { ShowToast } from './toast.js';

export interface UpdatesPaneElements {
  checkBtn: HTMLButtonElement;
  applyBtn: HTMLButtonElement;
  status: HTMLElement;
}

/**
 * The Updates pane: the status line, the main button and — for the steps the
 * user has to take (a Linux package, a manual install, a failed install) —
 * the command and the folder. Everything it shows comes from main's update
 * phase (`updates:phase` pushes), so a download reports its progress while it
 * runs and a failure stays on screen with its reason.
 */
export function wireUpdatesPane(
  els: UpdatesPaneElements,
  showToast: ShowToast,
): void {
  const byId = <T extends HTMLElement>(
    id: string,
    ctor: new () => T,
  ): T | null => {
    const found = document.getElementById(id);
    return found instanceof ctor ? found : null;
  };
  const progress = byId('update-progress', HTMLProgressElement);
  const help = byId('update-help', HTMLElement);
  const helpText = byId('update-help-text', HTMLElement);
  const command = byId('update-command', HTMLElement);
  const copyBtn = byId('update-copy-command', HTMLButtonElement);
  const folderBtn = byId('update-open-folder', HTMLButtonElement);

  let lastStatus: UpdateStatus | null = null;
  let phase: UpdatePhase = { state: 'idle' };
  /** A pushed phase is fresher than the one in a pending boot read. */
  let phasePushed = false;

  function render(): void {
    const s = lastStatus;
    if (!s || !els.status) return;
    const last = s.lastCheckAt
      ? new Date(s.lastCheckAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'nunca';
    const view = describeUpdate(s, phase, last);
    els.status.textContent = view.text;
    if (els.applyBtn) {
      els.applyBtn.style.display = view.apply ? '' : 'none';
      if (view.apply) {
        els.applyBtn.textContent = view.apply.label;
        els.applyBtn.disabled = view.apply.disabled;
      }
    }
    if (progress) {
      progress.hidden = view.progress === undefined;
      if (typeof view.progress === 'number') progress.value = view.progress;
      else progress.removeAttribute('value'); // indeterminate
    }
    if (help) help.hidden = view.help === null;
    if (helpText) helpText.textContent = view.help?.text ?? '';
    if (command) {
      command.textContent = view.help?.command ?? '';
      command.hidden = !view.help?.command;
    }
    if (copyBtn) copyBtn.hidden = !view.help?.command;
    if (folderBtn) folderBtn.hidden = !view.help?.folder;
    // Same red dot as the tray, on the version chip in the sidebar.
    const versionEl = document.getElementById('app-version');
    if (versionEl) {
      versionEl.classList.toggle('has-update', !!s.available);
      versionEl.title = s.available
        ? `v${s.available.version} disponible — ver changelog`
        : 'Ver changelog';
    }
  }

  function renderUpdateStatus(s: UpdateStatus, keepPushedPhase = false): void {
    if (!s) return;
    lastStatus = s;
    if (s.phase && !(keepPushedPhase && phasePushed)) phase = s.phase;
    render();
  }

  if (els.applyBtn) {
    els.applyBtn.addEventListener('click', async () => {
      els.applyBtn.disabled = true;
      let quitting = false;
      try {
        const res = await window.api.applyUpdate();
        // Progress and outcome arrive as phase pushes; only a restart (the
        // window is about to close) and an error nobody else shows get a toast.
        if (res && res.ok && res.inPlace)
          showToast('Instalando y reiniciando…', 'ok');
        else if (res && !res.ok && !res.cancelled && !res.busy)
          showToast(
            `No se pudo actualizar: ${res.error || 'desconocido'}`,
            'error',
          );
        quitting = Boolean(res && res.quitting);
      } finally {
        // App is about to quit to install — leave the button disabled.
        if (!quitting) {
          els.applyBtn.disabled = false;
          render();
        }
      }
    });
  }

  if (copyBtn)
    copyBtn.addEventListener('click', async () => {
      const res = await window.api.copyUpdateCommand();
      if (res.ok) showToast('Comando copiado', 'ok');
      else showToast('No se pudo copiar el comando', 'error');
    });
  if (folderBtn)
    folderBtn.addEventListener('click', async () => {
      const res = await window.api.showUpdateDownload();
      if (!res.ok) showToast('No se pudo abrir la carpeta', 'error');
    });

  /** Retires an older in-flight read whenever a fresher status lands. */
  const freshestStatus = latestWins();

  if (els.checkBtn) {
    els.checkBtn.addEventListener('click', async () => {
      els.checkBtn.disabled = true;
      const prev = els.checkBtn.textContent;
      els.checkBtn.textContent = 'Buscando…';
      try {
        const status = await window.api.checkForUpdates();
        // A check the user asked for is the freshest answer there is, so it
        // retires the boot read the same way a push does — otherwise that
        // older read landing last announces "al día" over the update this
        // very check just found.
        freshestStatus.invalidate();
        renderUpdateStatus(status);
      } finally {
        els.checkBtn.textContent = prev;
        els.checkBtn.disabled = false;
      }
    });
  }

  if (window.api && window.api.getUpdateStatus) {
    const initialUpdateStatus = freshestStatus.claim();
    window.api
      .getUpdateStatus()
      .then((status) => {
        // The automatic check can broadcast while this read is still pending;
        // applying the older status on top would announce "al día" over an
        // update main is already holding.
        if (initialUpdateStatus()) renderUpdateStatus(status, true);
      })
      .catch(() => {});
    // Live refresh from the automatic 5-minute checks.
    window.api.onUpdateStatus((status) => {
      freshestStatus.invalidate();
      renderUpdateStatus(status);
    });
    window.api.onUpdatePhase((next) => {
      phase = next;
      phasePushed = true;
      render();
    });
  }
}
