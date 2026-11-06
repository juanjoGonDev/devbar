import type {
  McpAuditFacets,
  McpAuditSort,
} from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import {
  COLUMNS,
  columnOf,
  describeFilter,
  isDefaultSort,
  isFiltered,
  narrows,
  type ActivityColumn,
  type ActivityState,
} from './mcp-activity-model.js';
import { NUMBER } from './mcp-activity-pager.js';

/**
 * The line over the «Actividad» table that says what is narrowing it: the
 * sort keys when they are not the usual newest first, one pill per filtered
 * column (each with its ✕), then «X de Y» and «Quitar todo». With nothing
 * applied it just says how many calls the log keeps.
 */

export interface ActiveActions {
  dropSort(key: ActivityColumn): void;
  clearColumn(column: ActivityColumn): void;
  clearAll(): void;
}

export interface ActiveView {
  state: ActivityState;
  facets: McpAuditFacets | null;
  total: number;
  retained: number;
}

function pill(
  extra: string,
  content: (Node | string)[],
  removeLabel: string,
  remove: () => void,
): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `act-pill${extra}`;
  el.append(...content);
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', `Quitar ${removeLabel}`);
  button.title = `Quitar ${removeLabel}`;
  button.append(icon('x'));
  button.addEventListener('click', remove);
  el.append(button);
  return el;
}

function text(className: string, value: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = value;
  return el;
}

function sortPill(
  each: McpAuditSort,
  index: number,
  several: boolean,
  actions: ActiveActions,
): HTMLSpanElement {
  const { label } = columnOf(each.key);
  const content: (Node | string)[] = [];
  if (several) content.push(text('prio', String(index + 1)));
  content.push(label, icon(each.dir === 'asc' ? 'arrow-up' : 'arrow-down'));
  return pill(' is-sort', content, `orden ${label}`, () =>
    actions.dropSort(each.key),
  );
}

export function renderActive(
  container: HTMLElement,
  view: ActiveView,
  actions: ActiveActions,
): void {
  const { state } = view;
  const items: HTMLElement[] = [];
  if (!isDefaultSort(state.sort)) {
    items.push(text('lbl', 'Orden'));
    const several = state.sort.length > 1;
    state.sort.forEach((each, index) =>
      items.push(sortPill(each, index, several, actions)),
    );
  }
  for (const column of COLUMNS) {
    if (!isFiltered(state, column.key)) continue;
    items.push(
      pill(
        '',
        [`${column.label}: ${describeFilter(state, column.key, view.facets)}`],
        `filtro ${column.label}`,
        () => actions.clearColumn(column.key),
      ),
    );
  }
  items.push(text('spacer', ''));
  if (!narrows(state)) {
    items.push(
      text(
        'act-count',
        `${NUMBER.format(view.retained)} llamadas en los últimos 30 días`,
      ),
    );
  } else {
    items.push(
      text(
        'act-count',
        `${NUMBER.format(view.total)} de ${NUMBER.format(view.retained)}`,
      ),
    );
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'act-link';
    clear.textContent = 'Quitar todo';
    clear.addEventListener('click', () => actions.clearAll());
    items.push(clear);
  }
  container.replaceChildren(...items);
}
