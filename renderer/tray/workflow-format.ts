import type { WorkflowRunResult } from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

/**
 * What the tray's WORKFLOWS section lists, in which order, and the subtitle
 * under each row. Pure, so the wording is tested without a DOM.
 */

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DAY_MS = 86_400_000;

const pad2 = (value: number): string => String(value).padStart(2, '0');

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `hoy 23:30`, `ayer 09:05`, `mañana 08:00`, `jue 17:12` or `20/12 10:00`. */
export function formatWhen(ts: number, now: number): string {
  const date = new Date(ts);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY_MS);
  if (days === 0) return `hoy ${time}`;
  if (days === -1) return `ayer ${time}`;
  if (days === 1) return `mañana ${time}`;
  if (Math.abs(days) < 7) return `${WEEKDAYS[date.getDay()] ?? ''} ${time}`;
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} ${time}`;
}

const RESULT_TEXT: Record<WorkflowRunResult, string> = {
  success: 'correcto',
  warning: 'con avisos',
  error: 'falló',
  cancelled: 'cancelado',
};

/** Where a row goes: running first, then startup, manual, scheduled. */
function rank(entry: WorkflowEntry): number {
  if (entry.running) return 0;
  const order = { startup: 1, manual: 2, schedule: 3 } as const;
  return order[entry.workflow.trigger.kind];
}

function listed(entry: WorkflowEntry): boolean {
  if (entry.running) return true;
  const { workflow } = entry;
  return entry.scriptCount > 0 && workflow.enabled && workflow.showInTray;
}

/**
 * The enabled workflows shown in the tray — and anything running, whatever
 * its settings. A disabled workflow or one with nothing to run is left out.
 */
export function trayWorkflowEntries(
  entries: readonly WorkflowEntry[],
): WorkflowEntry[] {
  return entries
    .filter(listed)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The line under an idle row (a running one shows its progress instead). */
export function workflowSubtitle(entry: WorkflowEntry, now: number): string {
  const { workflow, lastRun } = entry;
  const last = lastRun
    ? `${formatWhen(lastRun.finishedAt, now)} · ${RESULT_TEXT[lastRun.result]}`
    : null;
  switch (workflow.trigger.kind) {
    case 'startup':
      return workflow.enabled ? 'Al arrancar' : 'Al arrancar · desactivado';
    case 'schedule':
      if (lastRun?.result === 'error')
        return `Programado · falló ${formatWhen(lastRun.finishedAt, now)}`;
      return entry.nextRunAt !== null
        ? `Programado · próxima ${formatWhen(entry.nextRunAt, now)}`
        : 'Programado';
    case 'manual':
      return last ? `Manual · ${last}` : 'Manual';
  }
}
