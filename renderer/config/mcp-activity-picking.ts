import type {
  McpAuditEntry,
  McpAuditFilter,
  McpAuditPage,
  McpAuditPageQuery,
} from '../../src/ipc-contract/mcp-api.js';
import { latestWins } from '../latest-wins.js';
import { icon } from '../icon.js';
import { auditTime } from './mcp-format.js';
import {
  confirmDelete,
  confirmUndoMany,
  plural,
  type BulkDeps,
} from './mcp-activity-bulk.js';
import { NUMBER } from './mcp-activity-pager.js';
import {
  clearSelection,
  count,
  createSelection,
  everyMatch,
  freshInfo,
  isEmpty,
  isPicked,
  pageState,
  pick,
  pickEveryMatch,
  setPicked,
  takeInfo,
  toWire,
  type ActivitySelection,
} from './mcp-activity-selection.js';

/**
 * Selecting entries of «Actividad» to undo or delete them, the way a mail
 * client does: a box at the start of every row (Shift+click ticks every row
 * from the last one), and a box in the header that ticks the whole page. The
 * selection outlives pages, sorts and filters until it is cleared.
 *
 * While anything is selected the header turns into the selection bar: how
 * many, on how many pages and how many the filters now hide, «Deshacer
 * seleccionados (N)» while some can still be undone, «Eliminar» and ✕ (or
 * Escape) to clear it. With the whole page ticked and more entries matching,
 * a banner over the rows offers all of them — and, once taken, to clear.
 *
 * Ticking repaints the rows in place, so the box keeps focus; main is then
 * asked about the new selection (counts, pages, the rows of a filter
 * selection) and the bar repaints when it answers.
 */

export interface PickingDeps extends BulkDeps {
  /** «Actividad» is on screen (Escape only clears it then). */
  shown(): boolean;
  page(): McpAuditPage | null;
  /** The page query on show, and the filters alone. */
  query(): McpAuditPageQuery;
  filter(): McpAuditFilter;
  /** Something was deleted or undone: read the log again. */
  reload(): void;
}

export interface Picking {
  /** What the rows ask about their box. */
  rows: {
    picked(id: string): boolean;
    pick(entry: McpAuditEntry, on: boolean, shift: boolean): void;
  };
  /** The banner over the rows, when it has something to offer. */
  banner(): HTMLLIElement | null;
  /** A new page is in: learn its selected rows before it is painted. */
  loaded(): Promise<void>;
  /** Repaints the header and the rows' boxes in place. */
  paint(): void;
}

const CLEAR = 'Quitar la selección';

function checkbox(label: string): HTMLInputElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('aria-label', label);
  return box;
}

function boxCell(box: HTMLInputElement): HTMLSpanElement {
  const cell = document.createElement('span');
  cell.className = 'sel-box';
  cell.append(box);
  return cell;
}

function setBox(box: HTMLInputElement, state: 'none' | 'some' | 'all'): void {
  box.checked = state === 'all';
  box.indeterminate = state === 'some';
}

function text(className: string, value: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = value;
  return el;
}

function actButton(
  label: string,
  name: 'undo-2' | 'trash-2',
  run: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = name === 'trash-2' ? 'sel-act is-danger' : 'sel-act';
  button.append(icon(name), label);
  button.addEventListener('click', run);
  return button;
}

/** The box at the start of a row, for `rows.ts`. */
export function rowBox(
  entry: McpAuditEntry,
  picked: boolean,
  pick: (on: boolean, shift: boolean) => void,
): HTMLSpanElement {
  const box = checkbox(
    `Seleccionar ${entry.tool} de las ${auditTime(entry.at)}`,
  );
  box.checked = picked;
  box.addEventListener('click', (event) => pick(box.checked, event.shiftKey));
  return boxCell(box);
}

export function createActivityPicking(
  head: HTMLElement,
  rows: HTMLElement,
  deps: PickingDeps,
): Picking {
  const sel: ActivitySelection = createSelection();
  const asks = latestWins();

  const pageIds = (): string[] =>
    deps.page()?.entries.map((entry) => entry.id) ?? [];
  const viewKey = (): string => JSON.stringify(deps.query());

  const lead = checkbox('Seleccionar esta página');
  lead.title = 'Seleccionar esta página';
  const leadCell = boxCell(lead);
  leadCell.classList.add('xh-sel');
  const bar = document.createElement('div');
  bar.className = 'sel-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Selección');
  bar.hidden = true;
  head.prepend(leadCell);
  head.append(bar);

  /** Asks main about the selection as it is now; the bar repaints after. */
  async function ask(): Promise<void> {
    asks.invalidate();
    if (isEmpty(sel)) return;
    const current = asks.claim();
    const { version } = sel;
    const view = viewKey();
    try {
      const info = await window.api.getMcpAuditSelectionInfo(
        toWire(sel),
        deps.query(),
      );
      if (!current()) return;
      takeInfo(sel, version, view, info);
    } catch {
      // The bar keeps its best guess; the next change asks again.
    }
  }

  function changed(): void {
    paint();
    void ask().then(paint);
  }

  function clear(): void {
    const focused = bar.contains(document.activeElement);
    clearSelection(sel);
    asks.invalidate();
    paint();
    if (focused) lead.focus();
  }

  async function run(flow: () => Promise<boolean>, after: () => void) {
    if (await flow()) {
      after();
      deps.reload();
    }
  }

  function paintBar(): void {
    const info = freshInfo(sel) ?? sel.info?.value ?? null;
    const view = info?.view;
    const all = everyMatch(sel, deps.filter(), viewKey());
    const box = checkbox(CLEAR);
    setBox(box, all ? 'all' : 'some');
    box.addEventListener('click', clear);
    const items: HTMLElement[] = [
      boxCell(box),
      text('sel-count', plural(count(sel), 'seleccionada', 'seleccionadas')),
    ];
    const where: string[] = [];
    if (view && view.pages > 1) where.push(`en ${view.pages} páginas`);
    if (view && view.outside > 0)
      where.push(`${NUMBER.format(view.outside)} fuera de los filtros`);
    if (where.length > 0)
      items.push(text('sel-where', `· ${where.join(' · ')}`));
    items.push(text('spacer', ''));
    const undoable = info?.undoable ?? 0;
    if (undoable > 0)
      items.push(
        actButton(
          `Deshacer seleccionados (${NUMBER.format(undoable)})`,
          'undo-2',
          () =>
            void run(
              () => confirmUndoMany(deps, toWire(sel), undoable),
              () => {},
            ),
        ),
      );
    items.push(
      actButton(
        'Eliminar',
        'trash-2',
        () => void run(() => confirmDelete(deps, toWire(sel)), clear),
      ),
    );
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'sel-x';
    x.setAttribute('aria-label', CLEAR);
    x.title = `${CLEAR} (Esc)`;
    x.append(icon('x'));
    x.addEventListener('click', clear);
    items.push(x);
    bar.replaceChildren(...items);
  }

  function paintRows(): void {
    for (const li of rows.querySelectorAll<HTMLElement>('.mcp-entry')) {
      const on = isPicked(sel, li.dataset.id ?? '');
      li.classList.toggle('is-selected', on);
      const box = li.querySelector<HTMLInputElement>('.sel-box input');
      if (box) box.checked = on;
    }
    const banner = makeBanner();
    const old = rows.querySelector('.sel-banner');
    if (old && banner) old.replaceWith(banner);
    else if (old) old.remove();
    else if (banner) rows.prepend(banner);
  }

  function paint(): void {
    const selecting = !isEmpty(sel);
    head.classList.toggle('is-selecting', selecting);
    bar.hidden = !selecting;
    const ids = pageIds();
    setBox(lead, pageState(sel, ids));
    lead.disabled = ids.length === 0;
    if (selecting) paintBar();
    else bar.replaceChildren();
    paintRows();
  }

  function makeBanner(): HTMLLIElement | null {
    const page = deps.page();
    const ids = pageIds();
    if (!page || ids.length === 0 || pageState(sel, ids) !== 'all') return null;
    if (page.total <= ids.length) return null;
    const li = document.createElement('li');
    li.className = 'sel-banner';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'sel-link';
    if (everyMatch(sel, deps.filter(), viewKey())) {
      li.append(
        `Están seleccionadas las ${NUMBER.format(page.total)} que coinciden.`,
      );
      link.textContent = CLEAR;
      link.addEventListener('click', clear);
    } else {
      li.append(
        `Están seleccionadas las ${NUMBER.format(ids.length)} de esta página.`,
      );
      link.textContent = `Seleccionar las ${NUMBER.format(page.total)} que coinciden`;
      link.addEventListener('click', () => {
        pickEveryMatch(sel, deps.filter(), page.total, ids);
        changed();
      });
    }
    li.append(link);
    return li;
  }

  lead.addEventListener('click', () => {
    const ids = pageIds();
    setPicked(sel, ids, pageState(sel, ids) !== 'all');
    changed();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || isEmpty(sel))
      return;
    if (!deps.shown()) return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    clear();
  });

  return {
    rows: {
      picked: (id) => isPicked(sel, id),
      pick: (entry, on, shift) => {
        pick(sel, pageIds(), entry.id, on, shift);
        changed();
      },
    },
    banner: makeBanner,
    loaded: ask,
    paint,
  };
}
