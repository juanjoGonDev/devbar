import type {
  McpAuditEntry,
  McpAuditSelection,
} from '../../src/ipc-contract/mcp-api.js';
import { para, type ActivityDialog } from './mcp-activity-ask.js';
import { NUMBER } from './mcp-activity-pager.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * What «Actividad» asks before it deletes entries or undoes changes, and the
 * calls that follow a yes: a selection, what the filters match or the whole
 * log go through «¿Eliminar N entradas?»; one change through «¿Deshacer este
 * cambio?», several through «¿Deshacer N cambios?». Every flow answers
 * whether anything changed, so the caller knows to read the log again.
 */

export interface BulkDeps {
  dialog: ActivityDialog;
  showToast: ShowToast;
}

/** «1 entrada», «1.284 entradas». */
export function plural(n: number, one: string, many: string): string {
  return `${NUMBER.format(n)} ${n === 1 ? one : many}`;
}

export function deletedToast(deps: BulkDeps, deleted: number): void {
  deps.showToast(
    plural(deleted, 'entrada eliminada', 'entradas eliminadas'),
    'ok',
  );
}

/** Deletes `selection` once the user says yes; true when it went through. */
export async function confirmDelete(
  deps: BulkDeps,
  selection: McpAuditSelection,
): Promise<boolean> {
  try {
    const { total, undoable } =
      await window.api.getMcpAuditSelectionInfo(selection);
    if (total === 0) return false;
    const body: Node[] = [
      para(
        'Se borran del historial para siempre. Las llamadas no se repiten ni se deshacen: solo desaparece su registro.',
      ),
    ];
    if (undoable > 0)
      body.push(
        para(
          `${plural(undoable, 'cambio', 'cambios')} con «Deshacer» ya no se ${undoable === 1 ? 'podrá' : 'podrán'} deshacer.`,
          'mcp-ask-warn',
        ),
      );
    const yes = await deps.dialog.ask({
      title: `¿Eliminar ${plural(total, 'entrada', 'entradas')}?`,
      body,
      ok: 'Eliminar',
      icon: 'trash-2',
      tone: 'danger',
    });
    if (!yes) return false;
    const { deleted } = await window.api.deleteMcpAudit(selection);
    deletedToast(deps, deleted);
    return true;
  } catch (err) {
    deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    return false;
  }
}

/** Undoes the selection's `count` changes once the user says yes. */
export async function confirmUndoMany(
  deps: BulkDeps,
  selection: McpAuditSelection,
  count: number,
): Promise<boolean> {
  const yes = await deps.dialog.ask({
    title: `¿Deshacer ${plural(count, 'cambio', 'cambios')}?`,
    body: [
      para(
        'Se restaura lo que cambió cada uno, del más reciente al más antiguo. El resto de la selección no se toca.',
      ),
    ],
    ok: `Deshacer ${NUMBER.format(count)}`,
    icon: 'undo-2',
    tone: 'info',
  });
  if (!yes) return false;
  try {
    const { undone, failed, errors } =
      await window.api.undoMcpChanges(selection);
    const done = plural(undone, 'cambio deshecho', 'cambios deshechos');
    if (failed === 0) deps.showToast(done, 'ok');
    else
      deps.showToast(
        `${undone > 0 ? `${done}. ` : ''}No se ${failed === 1 ? 'pudo' : 'pudieron'} deshacer ${plural(failed, 'cambio', 'cambios')}: ${(errors ?? []).join(' · ')}`,
        'error',
      );
    return undone > 0;
  } catch (err) {
    deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    return false;
  }
}

/**
 * The per-row «Deshacer»: asks, then undoes that one change; `busy` is told
 * while the undo runs (the button stays focusable until the user says yes).
 */
export async function confirmUndoOne(
  deps: BulkDeps,
  entry: McpAuditEntry,
  token: string,
  busy: (on: boolean) => void,
): Promise<boolean> {
  const what = entry.target ? `${entry.tool} · ${entry.target}` : entry.tool;
  const yes = await deps.dialog.ask({
    title: '¿Deshacer este cambio?',
    body: [
      para(what, 'mcp-ask-what'),
      para('Se restaura lo que había antes de este cambio.'),
    ],
    ok: 'Deshacer',
    icon: 'undo-2',
    tone: 'info',
  });
  if (!yes) return false;
  busy(true);
  try {
    const result = await window.api.undoMcpChange(token);
    if (result.ok) {
      deps.showToast(plural(1, 'cambio deshecho', 'cambios deshechos'), 'ok');
      return true;
    }
    deps.showToast(result.error ?? 'No se pudo deshacer.', 'error');
  } catch (err) {
    deps.showToast(`Error: ${errorMessage(err)}`, 'error');
  }
  busy(false);
  return false;
}
