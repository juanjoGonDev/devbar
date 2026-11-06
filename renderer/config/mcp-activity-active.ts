import type { McpAuditFacets } from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import {
  COLUMNS,
  columnOf,
  describeFilter,
  isDefaultSort,
  isFiltered,
  narrows,
  type ActivityState,
} from './mcp-activity-model.js';
import { NUMBER } from './mcp-activity-pager.js';

/**
 * The short summary beside the search over «Actividad». With nothing applied
 * it says how many calls the log keeps; otherwise «X de Y», plus one pill —
 * «2 filtros · orden» — while a column filter or a sort other than newest
 * first is on. The headers already show which column does what, so the pill
 * only counts them: its tooltip spells each one out, and its ✕ takes every
 * filter and the sort off (the search stays: it has its own ✕).
 */

export interface ActiveView {
  state: ActivityState;
  facets: McpAuditFacets | null;
  total: number;
  retained: number;
  /** How many days the log keeps. */
  days: number;
}

const CLEAR_LABEL = 'Quitar filtros y orden';

function text(className: string, value: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = value;
  return el;
}

/**
 * «Orden: Cliente (A → Z), Hora (Más reciente primero)»: each key in the
 * words its column menu uses. A tooltip is plain text, so no arrow icon.
 */
function sortLine(state: ActivityState): string {
  const keys = state.sort.map((each) => {
    const column = columnOf(each.key);
    return `${column.label} (${column[each.dir]})`;
  });
  return `Orden: ${keys.join(', ')}`;
}

function summaryPill(view: ActiveView, reset: () => void): HTMLSpanElement {
  const { state } = view;
  const filtered = COLUMNS.filter((column) => isFiltered(state, column.key));
  const sorted = !isDefaultSort(state.sort);
  const parts: string[] = [];
  if (filtered.length > 0)
    parts.push(
      filtered.length === 1 ? '1 filtro' : `${filtered.length} filtros`,
    );
  if (sorted) parts.push('orden');

  const pill = document.createElement('span');
  pill.className = 'act-pill';
  pill.append(icon('filter'), parts.join(' · '));
  pill.title = [
    ...filtered.map(
      (column) =>
        `${column.label}: ${describeFilter(state, column.key, view.facets)}`,
    ),
    ...(sorted ? [sortLine(state)] : []),
  ].join('\n');

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', CLEAR_LABEL);
  button.title = CLEAR_LABEL;
  button.append(icon('x'));
  button.addEventListener('click', reset);
  pill.append(button);
  return pill;
}

/** Whether a column filter or a sort other than newest first is on. */
function shaped(state: ActivityState): boolean {
  return (
    !isDefaultSort(state.sort) ||
    COLUMNS.some((column) => isFiltered(state, column.key))
  );
}

export function renderActive(
  container: HTMLElement,
  view: ActiveView,
  reset: () => void,
): void {
  const { state } = view;
  const items: HTMLElement[] = [text('spacer', '')];
  if (!narrows(state) && isDefaultSort(state.sort)) {
    items.push(
      text(
        'act-count',
        `${NUMBER.format(view.retained)} llamadas · ${view.days} ${view.days === 1 ? 'día' : 'días'}`,
      ),
    );
  } else {
    items.push(
      text(
        'act-count',
        `${NUMBER.format(view.total)} de ${NUMBER.format(view.retained)}`,
      ),
    );
    if (shaped(state)) items.push(summaryPill(view, reset));
  }
  container.replaceChildren(...items);
}
