import type { McpAuditFacets } from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import type { Selection } from './mcp-activity-checklist.js';
import { menuContent } from './mcp-activity-menu.js';
import { placeMenu } from './mcp-activity-place.js';
import {
  COLUMNS,
  isFiltered,
  type ActivityColumn,
  type ActivityState,
  type ColumnDef,
  type SortDir,
  type TimeFilter,
} from './mcp-activity-model.js';
import { createRangeView, type RangeView } from './mcp-range-picker.js';

/**
 * The header of the «Actividad» table, one cell per column the way a
 * spreadsheet's reads: the label sorts (Shift adds it as one more key), and
 * the funnel opens the column's menu. The menu is a popover that stays open
 * while it is used — even when what is inside it is rebuilt with new counts —
 * and closes on «Listo», Escape (focus back on its funnel) or a click
 * anywhere else. After every paint and on every resize the menu is fitted
 * into the window, with the «Rango…» flyout beside it (mcp-activity-place.ts).
 */

export interface HeadDeps {
  state(): ActivityState;
  facets(): McpAuditFacets | null;
  now(): number;
  retentionDays(): number;
  clickSort(key: ActivityColumn, additive: boolean): void;
  sort(key: ActivityColumn, dir: SortDir): void;
  addSort(key: ActivityColumn): void;
  removeSort(key: ActivityColumn): void;
  setTime(time: TimeFilter): void;
  select(column: ActivityColumn, next: Selection): void;
  setUndoable(on: boolean): void;
  clear(column: ActivityColumn): void;
}

export interface ActivityHead {
  /** Repaints the cells and, when one is open, its menu. */
  render(): void;
}

interface Cell {
  column: ColumnDef;
  el: HTMLElement;
  sort: HTMLButtonElement;
  funnel: HTMLButtonElement;
}

interface OpenMenu {
  cell: Cell;
  el: HTMLElement;
  find: string;
  range: RangeView;
}

function buildCell(
  column: ColumnDef,
  deps: HeadDeps,
  toggle: (cell: Cell) => void,
): Cell {
  const el = document.createElement('div');
  el.className = 'xh';
  el.setAttribute('role', 'columnheader');
  el.dataset.column = column.key;
  const sort = document.createElement('button');
  sort.type = 'button';
  sort.className = 'xh-sort';
  sort.title = `Ordenar por ${column.label.toLowerCase()} · Mayús+clic para añadir a la ordenación`;
  sort.addEventListener('click', (event) =>
    deps.clickSort(column.key, event.shiftKey),
  );
  const funnel = document.createElement('button');
  funnel.type = 'button';
  funnel.className = 'xh-funnel';
  funnel.setAttribute('aria-label', `Filtrar y ordenar ${column.label}`);
  funnel.title = `Filtrar y ordenar ${column.label}`;
  funnel.setAttribute('aria-haspopup', 'dialog');
  funnel.setAttribute('aria-expanded', 'false');
  el.append(sort, funnel);
  const cell: Cell = { column, el, sort, funnel };
  funnel.addEventListener('click', () => toggle(cell));
  return cell;
}

function paintCell(cell: Cell, state: ActivityState, open: boolean): void {
  const { column } = cell;
  const at = state.sort.findIndex((each) => each.key === column.key);
  const mine = state.sort[at];
  const filtered = isFiltered(state, column.key);
  cell.el.classList.toggle('is-sorted', mine !== undefined);
  cell.el.classList.toggle('is-filtered', filtered);
  cell.el.setAttribute(
    'aria-sort',
    !mine ? 'none' : mine.dir === 'asc' ? 'ascending' : 'descending',
  );
  const parts: (Node | string)[] = [column.label];
  if (mine) {
    parts.push(icon(mine.dir === 'asc' ? 'arrow-up' : 'arrow-down'));
    if (state.sort.length > 1) {
      const prio = document.createElement('span');
      prio.className = 'xh-prio';
      prio.textContent = String(at + 1);
      prio.setAttribute('aria-label', `prioridad ${at + 1}`);
      parts.push(prio);
    }
  }
  cell.sort.replaceChildren(...parts);
  cell.funnel.replaceChildren(icon(filtered ? 'filter' : 'list-filter'));
  cell.funnel.setAttribute('aria-expanded', String(open));
}

/** Rebuilds `menu` and gives focus back to what had it, by its key. */
function rebuildKeepingFocus(menu: HTMLElement, content: HTMLElement[]): void {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && menu.contains(active)
      ? active.dataset.focusKey
      : undefined;
  const caret =
    active instanceof HTMLInputElement && active.type === 'search'
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
  menu.replaceChildren(...content);
  if (key === undefined) return;
  const again = [
    ...menu.querySelectorAll<HTMLElement>('[data-focus-key]'),
  ].find((el) => el.dataset.focusKey === key);
  again?.focus();
  if (caret && again instanceof HTMLInputElement)
    again.setSelectionRange(caret.start, caret.end);
}

export function createActivityHead(
  head: HTMLElement,
  deps: HeadDeps,
): ActivityHead {
  let open: OpenMenu | null = null;

  function paintMenu(menu: OpenMenu): void {
    const { key } = menu.cell.column;
    rebuildKeepingFocus(
      menu.el,
      menuContent({
        column: menu.cell.column,
        state: deps.state(),
        facets: deps.facets(),
        now: deps.now(),
        retentionDays: deps.retentionDays(),
        find: menu.find,
        setFind: (text) => {
          menu.find = text;
        },
        range: menu.range,
        sort: (dir) => deps.sort(key, dir),
        addSort: () => deps.addSort(key),
        removeSort: () => deps.removeSort(key),
        setTime: (time) => deps.setTime(time),
        select: (next) => deps.select(key, next),
        setUndoable: (on) => deps.setUndoable(on),
        clear: () => deps.clear(key),
        done: () => close(true),
      }),
    );
    placeMenu(menu.el);
  }

  function close(refocus: boolean): void {
    if (!open) return;
    const { cell, el } = open;
    open = null;
    el.remove();
    cell.funnel.setAttribute('aria-expanded', 'false');
    if (refocus) cell.funnel.focus();
  }

  function toggle(cell: Cell): void {
    const same = open?.cell === cell;
    close(false);
    if (same) return;
    const el = document.createElement('div');
    el.className = 'xf';
    el.classList.toggle('is-right', COLUMNS.indexOf(cell.column) >= 2);
    el.dataset.column = cell.column.key;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Columna ${cell.column.label}`);
    open = { cell, el, find: '', range: createRangeView() };
    cell.el.append(el);
    cell.funnel.setAttribute('aria-expanded', 'true');
    paintMenu(open);
    el.querySelector<HTMLElement>('button')?.focus();
  }

  const cells = COLUMNS.map((column) => buildCell(column, deps, toggle));
  head.replaceChildren(
    ...cells.map((cell) => cell.el),
    document.createElement('span'),
  );

  // The path is fixed when the click starts, so a box inside the menu that is
  // rebuilt while the click runs still counts as inside.
  document.addEventListener('click', (event) => {
    if (!open) return;
    const path = event.composedPath();
    if (path.includes(open.el) || path.includes(open.cell.funnel)) return;
    close(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  window.addEventListener('resize', () => {
    if (open) placeMenu(open.el);
  });

  return {
    render() {
      const state = deps.state();
      for (const cell of cells) paintCell(cell, state, open?.cell === cell);
      if (open) paintMenu(open);
    },
  };
}
