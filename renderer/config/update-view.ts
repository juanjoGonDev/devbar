import type { UpdatePhase, UpdateStatus } from '../../src/ipc-contract.js';

/**
 * What the Updates pane shows for one status + phase: the status line, the
 * main button, the progress bar and the manual-install help. Pure, so every
 * phase's wording is decided in one place; `updates-pane.ts` only paints it.
 */

/** Colour and glyph of the About card's round status badge. */
type UpdateBadge = 'ok' | 'available' | 'busy' | 'error';

export interface UpdateView {
  badge: UpdateBadge;
  /** One-line headline next to the badge; `text` is the detail under it. */
  title: string;
  text: string;
  /** Null hides the button. */
  apply: { label: string; disabled: boolean } | null;
  /** Percent 0–100, null for an unknown size, undefined for no bar. */
  progress?: number | null;
  help: { text: string; command: string | null; folder: boolean } | null;
}

const MB = 1024 * 1024;

type Headline = Pick<UpdateView, 'badge' | 'title'>;
const UP_TO_DATE: Headline = { badge: 'ok', title: 'Estás al día' };
const AVAILABLE: Headline = {
  badge: 'available',
  title: 'Actualización disponible',
};
const READY: Headline = { badge: 'available', title: 'Lista para instalar' };
const CHECKING: Headline = {
  badge: 'busy',
  title: 'Buscando actualizaciones',
};
const UPDATING: Headline = { badge: 'busy', title: 'Actualizando DevBar' };
const CHECK_FAILED: Headline = {
  badge: 'error',
  title: 'No se pudo comprobar',
};
const FAILED: Headline = { badge: 'error', title: 'No se pudo actualizar' };

function megabytes(bytes: number): string {
  return (bytes / MB).toLocaleString('es-ES', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function folderOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return cut > 0 ? file.slice(0, cut) : file;
}

export function describeUpdate(
  status: UpdateStatus,
  phase: UpdatePhase,
  /** "hoy a las 14:41" and the like; null when nothing was ever checked. */
  lastCheck: string | null,
): UpdateView {
  const lastCheckSuffix = lastCheck ? ` · última búsqueda ${lastCheck}` : '';
  const version = status.available?.version ?? null;
  // A phase about an older release (the check since found a newer one) says
  // nothing about the release on offer now.
  const current =
    'version' in phase && phase.version !== version
      ? ({ state: 'idle' } as const)
      : phase;
  const offer = (label: string, disabled = false): UpdateView['apply'] =>
    version ? { label, disabled } : null;
  const retry = offer('Reintentar');
  const busy = offer(`Actualizar a v${version}`, true);

  switch (current.state) {
    case 'checking':
      return {
        ...CHECKING,
        text: 'Buscando actualizaciones…',
        apply: offer(`Actualizar a v${version}`),
        help: null,
      };
    case 'check-failed':
      return {
        ...CHECK_FAILED,
        text: `No se pudo comprobar: ${current.reason}${version ? ` · v${version} disponible` : ''}`,
        apply: offer(`Actualizar a v${version}`),
        help: null,
      };
    case 'downloading': {
      const { received, total } = current;
      const percent = total ? Math.floor((received / total) * 100) : null;
      return {
        ...UPDATING,
        text:
          percent === null || !total
            ? `Descargando v${current.version} — ${megabytes(received)} MB`
            : `Descargando v${current.version} — ${percent} % (${megabytes(received)} / ${megabytes(total)} MB)`,
        apply: busy,
        progress: percent,
        help: null,
      };
    }
    case 'download-failed':
      return {
        ...FAILED,
        text: `No se pudo descargar v${current.version}: ${current.reason}`,
        apply: retry,
        help: null,
      };
    case 'verifying':
      return {
        ...UPDATING,
        text: `Verificando la integridad de v${current.version}…`,
        apply: busy,
        help: null,
      };
    case 'verify-failed':
      return {
        ...FAILED,
        text: `La descarga de v${current.version} no superó la verificación: ${current.reason}`,
        apply: retry,
        help: null,
      };
    case 'ready-to-install':
      if (current.install === 'package')
        return {
          ...READY,
          text: `v${current.version} descargada y verificada.`,
          apply: offer('Instalar ahora'),
          help: {
            text: 'Instalar ahora pedirá tu contraseña para instalar el paquete y DevBar se reiniciará. También puedes instalarlo a mano desde una terminal:',
            command: current.command,
            folder: true,
          },
        };
      if (current.install === 'manual')
        return {
          ...READY,
          text: `v${current.version} descargada en ${folderOf(current.path)}.`,
          apply: null,
          help: current.command
            ? {
                text: 'Instálala desde una terminal con este comando y vuelve a abrir DevBar:',
                command: current.command,
                folder: true,
              }
            : {
                text: 'Cierra DevBar y abre la nueva AppImage desde esa carpeta (ya es ejecutable). Puedes moverla a donde tenías la anterior.',
                command: null,
                folder: true,
              },
        };
      break;
    case 'installing':
      return {
        ...UPDATING,
        text: `Instalando v${current.version}… Confirma la contraseña en el diálogo del sistema.`,
        apply: busy,
        help: null,
      };
    case 'install-failed':
      return {
        ...FAILED,
        text: `No se pudo instalar v${current.version}: ${current.reason}`,
        apply: retry,
        help: {
          text: current.command
            ? 'Puedes instalarla a mano desde una terminal:'
            : `El archivo sigue en ${folderOf(current.path)}.`,
          command: current.command,
          folder: true,
        },
      };
    case 'restarting':
      return {
        ...UPDATING,
        text: `Reiniciando para instalar v${current.version}…`,
        apply: busy,
        help: null,
      };
    default:
      break;
  }
  // idle / available / a staged restart.
  const ready =
    (current.state === 'ready-to-install' && current.install === 'restart') ||
    Boolean(status.staged && version && status.staged.version === version);
  if (!version)
    return {
      ...UP_TO_DATE,
      // The headline already says "al día"; the detail only dates it.
      text: lastCheck
        ? `Última búsqueda ${lastCheck}`
        : 'Aún no se ha buscado ninguna actualización',
      apply: null,
      help: null,
    };
  return ready
    ? {
        ...READY,
        text: `v${version} descargada, lista para instalar${lastCheckSuffix}`,
        apply: offer(`Reiniciar e instalar v${version}`),
        help: null,
      }
    : {
        ...AVAILABLE,
        text: `Actualización v${version} disponible${lastCheckSuffix}`,
        apply: offer(`Actualizar a v${version}`),
        help: null,
      };
}
