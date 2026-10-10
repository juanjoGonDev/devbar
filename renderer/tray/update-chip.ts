import { latestWins } from '../latest-wins.js';
import type { UpdatePhase, UpdateStatus } from '../../src/ipc-contract.js';
import { showToast } from './host.js';
import {
  paintStrip,
  stripIcon,
  stripIconButton,
  stripProgress,
  stripSpan,
  stripTextButton,
} from './strip.js';

/**
 * The popover's update cues: the red dot on the version chip while an update
 * is pending (same cue as the menubar mark and config), and a slim strip
 * under the header row while the update downloads, installs or has failed —
 * the popover is often the only surface open when the user clicked "update"
 * in it.
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

/** Identifies one phase, so a dismissed one stays dismissed when re-pushed. */
function phaseKey(phase: UpdatePhase): string {
  return JSON.stringify([
    phase.state,
    'version' in phase ? phase.version : null,
    'reason' in phase ? phase.reason : null,
  ]);
}

/** The same calls config's "Reintentar" uses: check again, or apply again. */
async function retry(phase: UpdatePhase): Promise<void> {
  if (phase.state === 'check-failed') {
    await window.api.checkForUpdates();
    return;
  }
  const res = await window.api.applyUpdate();
  // Progress and outcome arrive as phase pushes; only an error nobody else
  // shows gets a toast (same rule as the config window's updates pane).
  if (res && !res.ok && !res.cancelled && !res.busy)
    showToast(
      `No se pudo actualizar: ${typeof res.error === 'string' && res.error ? res.error : 'desconocido'}`,
      'error',
    );
}

let dismissedKey: string | null = null;

function stripContent(phase: UpdatePhase): {
  children: Node[];
  title: string;
} | null {
  switch (phase.state) {
    case 'downloading': {
      const percent = phase.total
        ? Math.floor((phase.received / phase.total) * 100)
        : null;
      return {
        title: `Descargando v${phase.version}`,
        children:
          percent === null
            ? [
                stripIcon('download', 'strip-muted'),
                stripSpan('strip-title', 'Descargando…'),
                stripProgress(null),
              ]
            : [
                stripIcon('download', 'strip-muted'),
                stripSpan('strip-title', 'Descargando'),
                stripSpan('strip-spacer'),
                stripSpan('strip-muted', `${percent} %`),
                stripProgress(percent),
              ],
      };
    }
    case 'verifying':
      return {
        title: `Verificando v${phase.version}`,
        children: [
          stripIcon('shield-check', 'strip-muted'),
          stripSpan('strip-title', 'Verificando…'),
          stripProgress(null),
        ],
      };
    case 'installing':
      return {
        title: `Instalando v${phase.version}`,
        children: [
          stripIcon('package', 'strip-muted'),
          stripSpan('strip-title', 'Instalando…'),
          stripProgress(null),
        ],
      };
    case 'check-failed':
    case 'download-failed':
    case 'verify-failed':
    case 'install-failed':
      return {
        title: '',
        children: [
          stripIcon('triangle-alert', 'strip-warn'),
          stripSpan('strip-title', 'Actualización fallida'),
          stripSpan('strip-detail', phase.reason, phase.reason),
          stripTextButton('Reintentar', () => void retry(phase)),
          stripIconButton('prestep-cancel', 'x', 'Descartar', () => {
            dismissedKey = phaseKey(phase);
            showPhase(phase);
          }),
        ],
      };
    default:
      return null;
  }
}

function showPhase(phase: UpdatePhase): void {
  const el = document.getElementById('update-strip');
  if (!el) return;
  const key = phaseKey(phase);
  // A dismissal holds only for the phase it dismissed.
  if (dismissedKey !== key) dismissedKey = null;
  const content = dismissedKey === null ? stripContent(phase) : null;
  el.title = content?.title ?? '';
  paintStrip(el, content?.children ?? null);
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
