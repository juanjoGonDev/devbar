import { latestWins } from '../latest-wins.js';
import type { UpdateStatus } from '../../src/ipc-contract.js';
import type { ShowToast } from './toast.js';

export interface UpdatesPaneElements {
  checkBtn: HTMLButtonElement;
  applyBtn: HTMLButtonElement;
  status: HTMLElement;
}

export function wireUpdatesPane(
  els: UpdatesPaneElements,
  showToast: ShowToast,
): void {
  let _currentVersion = '';

  function renderUpdateStatus(s: UpdateStatus): void {
    if (!s || !els.status) return;
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
    els.status.textContent = !s.available
      ? `Al día · última búsqueda ${last}`
      : ready
        ? `v${s.available.version} descargada, lista para instalar · última búsqueda ${last}`
        : `Actualización v${s.available.version} disponible · última búsqueda ${last}`;
    if (els.applyBtn) {
      if (s.available) {
        els.applyBtn.style.display = '';
        els.applyBtn.textContent = ready
          ? `Reiniciar e instalar v${s.available.version}`
          : `Actualizar a v${s.available.version}`;
      } else {
        els.applyBtn.style.display = 'none';
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

  if (els.applyBtn) {
    els.applyBtn.addEventListener('click', async () => {
      els.applyBtn.disabled = true;
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
        if (!quitting) els.applyBtn.disabled = false;
      }
    });
  }

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
        if (initialUpdateStatus()) renderUpdateStatus(status);
      })
      .catch(() => {});
    // Live refresh from the automatic 5-minute checks.
    window.api.onUpdateStatus((status) => {
      freshestStatus.invalidate();
      renderUpdateStatus(status);
    });
  }
}
