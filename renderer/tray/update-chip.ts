import { latestWins } from '../latest-wins.js';
import type { UpdatePhase, UpdateStatus } from '../../src/ipc-contract.js';

/**
 * The popover's update cues: the red dot on the version chip while an update
 * is pending (same cue as the menubar mark and config), and a short label
 * beside it while the update downloads, installs or has failed — the popover
 * is often the only surface open when the user clicked "update" in it.
 */

function markVersionUpdate(status: UpdateStatus): void {
  const el = document.getElementById('app-version');
  if (!el) return;
  const version = status && status.available ? status.available.version : null;
  el.classList.toggle('has-update', !!version);
  el.title = version
    ? `v${version} disponible — ver changelog`
    : 'Ver changelog';
}

function phaseLabel(
  phase: UpdatePhase,
): { text: string; title: string } | null {
  switch (phase.state) {
    case 'downloading':
      return {
        text: phase.total
          ? `Descargando ${Math.floor((phase.received / phase.total) * 100)} %`
          : 'Descargando…',
        title: `Descargando v${phase.version}`,
      };
    case 'verifying':
      return { text: 'Verificando…', title: `Verificando v${phase.version}` };
    case 'installing':
      return { text: 'Instalando…', title: `Instalando v${phase.version}` };
    case 'check-failed':
    case 'download-failed':
    case 'verify-failed':
    case 'install-failed':
      return { text: 'Actualización fallida', title: phase.reason };
    default:
      return null;
  }
}

function showPhase(phase: UpdatePhase): void {
  const el = document.getElementById('update-progress-label');
  if (!el) return;
  const label = phaseLabel(phase);
  el.hidden = label === null;
  el.textContent = label?.text ?? '';
  el.title = label?.title ?? '';
}

export function wireUpdateChip(): void {
  if (!window.api.getUpdateStatus) return;
  const pushedUpdateStatus = latestWins();
  const initialUpdateStatus = pushedUpdateStatus.claim();
  let phasePushed = false;
  window.api
    .getUpdateStatus()
    .then((status) => {
      // Same race as the group states: a pushed status that landed first
      // would be undone here, dropping the dot from the version chip until
      // the next check hours later.
      if (initialUpdateStatus()) {
        markVersionUpdate(status);
        if (status?.phase && !phasePushed) showPhase(status.phase);
      }
    })
    .catch(() => {});
  window.api.onUpdateStatus((status) => {
    pushedUpdateStatus.invalidate();
    markVersionUpdate(status);
  });
  window.api.onUpdatePhase((phase) => {
    phasePushed = true;
    showPhase(phase);
  });
}
