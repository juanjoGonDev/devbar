import type { IconName } from '../icon.js';
import type { WorkflowTrigger } from '../../src/domain-types.js';

type TriggerKind = WorkflowTrigger['kind'];

/**
 * How each trigger kind is drawn wherever a workflow appears: its glyph, the
 * name on the canvas's trigger node, on the pill (breadcrumb and list) and
 * on the list's filter chip.
 * The colours live in CSS under `.is-startup` / `.is-schedule` / `.is-manual`.
 */
export const TRIGGER_META: Record<
  TriggerKind,
  { icon: IconName; node: string; pill: string; chip: string }
> = {
  startup: {
    icon: 'zap',
    node: 'Al iniciar',
    pill: 'Al arrancar',
    chip: 'Al arrancar',
  },
  schedule: {
    icon: 'clock',
    node: 'Programado',
    pill: 'Programado',
    chip: 'Programados',
  },
  manual: {
    icon: 'play',
    node: 'Manual',
    pill: 'Manual',
    chip: 'Manuales',
  },
};

/** What a brand-new (or a demoted startup) workflow gets. */
export const MANUAL_TRIGGER: WorkflowTrigger = {
  kind: 'manual',
  confirm: false,
};

/** Main's run outcomes worth a toast (a failed script shows on the row). */
export function runErrorText(error: string | undefined): string | null {
  if (!error || error === 'cancelled' || error.startsWith('scripts_failed'))
    return null;
  if (error === 'already_running') return 'Ya se está ejecutando';
  if (error === 'not_found') return 'Ese workflow ya no existe';
  if (error === 'not_ready') return 'Ese bloque aún no puede reintentarse';
  return error;
}

/**
 * A rejected IPC call's reason as main wrote it: Electron wraps it as
 * «Error invoking remote method 'x': Error: <reason>».
 */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(
    /^Error invoking remote method '[^']*': (?:\w*Error: )?/,
    '',
  );
}
