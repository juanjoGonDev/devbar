import type { ApplyUpdateResult } from './assisted-update.js';
import type { UpdatePhase } from '../ipc-contract.js';

/**
 * The small user actions around an update phase, kept out of updater.ts:
 * turning an apply result into a banner for surfaces that cannot show it
 * (tray menu, notification button), and the "copy the command" / "open the
 * folder" buttons of a manual install. Each reads main's own phase — the
 * renderer never supplies a path or a command.
 */

export type SimpleResult = { ok: true } | { ok: false; error: string };

/**
 * The banner text an apply result deserves, or null when there is nothing to
 * say: a cancel, a flow already running, or a restart that is under way.
 */
export function applyReport(
  res: ApplyUpdateResult,
  phase: UpdatePhase,
): string | null {
  if (!res.ok)
    return res.cancelled || res.busy
      ? null
      : `No se pudo actualizar: ${res.error || 'desconocido'}`;
  if (phase.state === 'ready-to-install' && phase.install !== 'restart')
    return `v${phase.version} descargada. Instálala desde Configuración → Acerca de.`;
  return null;
}

export function copyPhaseCommand(
  phase: UpdatePhase,
  copyText: (text: string) => void,
): SimpleResult {
  const command = 'command' in phase ? phase.command : null;
  if (!command) return { ok: false, error: 'no_command' };
  copyText(command);
  return { ok: true };
}

export function showPhaseFile(
  phase: UpdatePhase,
  showItemInFolder: (target: string) => void,
): SimpleResult {
  if (!('path' in phase)) return { ok: false, error: 'no_file' };
  showItemInFolder(phase.path);
  return { ok: true };
}
