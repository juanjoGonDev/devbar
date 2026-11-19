import { errorMessage } from './ipc-validators.js';
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
function applyReport(
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

/**
 * An apply for a surface that cannot show its result itself (the tray menu,
 * a notification button, the automatic install prompt): failures and "your
 * turn" steps become a banner through `report`. Never rejects.
 */
export async function applyAndReport(
  apply: () => Promise<ApplyUpdateResult>,
  currentPhase: () => UpdatePhase,
  report: (text: string) => void,
): Promise<void> {
  let res: ApplyUpdateResult;
  try {
    res = await apply();
  } catch (err) {
    res = { ok: false, error: errorMessage(err) };
    console.error(`[updates] no se pudo actualizar: ${res.error}`);
  }
  const text = applyReport(res, currentPhase());
  if (text) report(text);
}

export async function copyPhaseCommand(
  phase: UpdatePhase,
  copyText: (text: string) => Promise<void>,
): Promise<SimpleResult> {
  const command = 'command' in phase ? phase.command : null;
  if (!command) return { ok: false, error: 'no_command' };
  await copyText(command);
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

/**
 * The "ready to install" notice, for a linked phone's log only: on the desk
 * the install modal says it. Its call to action marks it as an update there.
 */
export function noticeReady(
  show: (
    title: string,
    body: string,
    options: { cta: { label: string; action: string }; logOnly: boolean },
  ) => void,
  title: string,
  version: string,
): void {
  show(title, `v${version} lista. Reinicia para instalarla.`, {
    cta: { label: 'Reiniciar e instalar', action: 'install-update' },
    logOnly: true,
  });
}
