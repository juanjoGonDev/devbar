import type { McpAuditEntry } from '../../src/ipc-contract/mcp-api.js';
import { auditResultLabel } from '../../src/mcp-audit-labels.js';
import { icon } from '../icon.js';
import { auditTime } from './mcp-format.js';
import { shortStamp } from './mcp-activity-model.js';

/**
 * The rows of «Actividad»: one line per tool call (time, client, action,
 * result), a change that unfolds into its diff and offers «Deshacer», the
 * search marked in what it matched, and a separator per day while the time
 * leads the sort. With another column first the rows run flat and each time
 * carries its date.
 */

export interface RowsView {
  /** The applied search, marked in every row. */
  search: string;
  /** Day separators (time first), or flat rows with dated times. */
  byDay: boolean;
  now: number;
  /** Nothing in the log at all, or nothing that matches. */
  empty: 'none' | 'filtered';
  undo(token: string, button: HTMLButtonElement): void;
}

const DIFF_SIGN = { ctx: ' ', del: '-', add: '+' } as const;

const DAY_NAME = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function span(className: string, text = ''): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/** Appends `text` with every case-insensitive hit of `search` in a <mark>. */
function appendMarked(parent: HTMLElement, text: string, search: string): void {
  const needle = search.trim().toLowerCase();
  const hay = text.toLowerCase();
  // A case change that alters the length would shift every offset.
  if (!needle || hay.length !== text.length) {
    parent.append(text);
    return;
  }
  let at = 0;
  for (let hit = hay.indexOf(needle); hit >= 0; hit = hay.indexOf(needle, at)) {
    if (hit > at) parent.append(text.slice(at, hit));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(hit, hit + needle.length);
    parent.append(mark);
    at = hit + needle.length;
  }
  if (at < text.length) parent.append(text.slice(at));
}

function marked(
  className: string,
  text: string,
  search: string,
): HTMLSpanElement {
  const el = span(className);
  appendMarked(el, text, search);
  return el;
}

/** «Hoy · viernes, 6 de noviembre», «Ayer · …», then the long date. */
function dayLabel(at: number, now: number): string {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const long = DAY_NAME.format(day);
  const back = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (back === 0) return `Hoy · ${long}`;
  if (back === 1) return `Ayer · ${long}`;
  return long.charAt(0).toUpperCase() + long.slice(1);
}

function diffBox(
  entry: McpAuditEntry,
  li: HTMLLIElement,
  tail: HTMLElement,
): void {
  const diff = document.createElement('div');
  diff.className = 'mcp-diff';
  diff.id = `mcp-diff-${entry.id}`;
  diff.hidden = true;
  for (const change of entry.diff ?? []) {
    const line = document.createElement('div');
    line.className = 'mcp-diff-line';
    line.dataset.kind = change.kind;
    line.textContent = `${DIFF_SIGN[change.kind]} ${change.field}: ${change.text}`;
    diff.append(line);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mcp-entry-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', diff.id);
  toggle.setAttribute('aria-label', 'Ver el cambio');
  toggle.append(icon('chevron-right'));
  toggle.addEventListener('click', () => {
    diff.hidden = !diff.hidden;
    toggle.setAttribute('aria-expanded', String(!diff.hidden));
    li.classList.toggle('is-open', !diff.hidden);
  });
  tail.append(toggle);
  li.classList.add('is-change');
  li.append(diff);
}

function undoButton(token: string, view: RowsView): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small-btn mcp-entry-undo';
  button.append(icon('undo-2'), 'Deshacer');
  button.addEventListener('click', () => view.undo(token, button));
  return button;
}

function row(entry: McpAuditEntry, view: RowsView): HTMLLIElement {
  const { search } = view;
  const li = document.createElement('li');
  li.className = 'mcp-entry';
  li.dataset.id = entry.id;

  const line = document.createElement('div');
  line.className = 'mcp-entry-line';
  const action = span('mcp-entry-action');
  action.append(marked('mcp-entry-tool', entry.tool, search));
  if (entry.target) {
    action.append(' · ');
    appendMarked(action, entry.target, search);
  }
  if (entry.summary) {
    const summary = span('mcp-entry-summary', ' · ');
    appendMarked(summary, entry.summary, search);
    action.append(summary);
  }
  const result = marked('mcp-entry-result', auditResultLabel(entry), search);
  result.dataset.result = entry.result;
  const tail = span('mcp-entry-tail');
  const time = view.byDay
    ? span('mcp-entry-time', auditTime(entry.at))
    : span('mcp-entry-time has-date', shortStamp(entry.at));
  line.append(
    time,
    marked('mcp-entry-client', entry.clientName, search),
    action,
    result,
    tail,
  );
  li.append(line);

  if (entry.diff) diffBox(entry, li, tail);
  if (entry.undoToken) tail.prepend(undoButton(entry.undoToken, view));
  return li;
}

function emptyRow(kind: RowsView['empty']): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'act-empty';
  if (kind === 'none') {
    li.append('Sin actividad todavía.');
    return li;
  }
  const title = document.createElement('strong');
  title.textContent = 'Nada coincide con estos filtros';
  li.append(title, 'Cambia la búsqueda o quita algún filtro de columna.');
  return li;
}

export function renderRows(
  list: HTMLUListElement,
  entries: readonly McpAuditEntry[],
  view: RowsView,
): void {
  if (entries.length === 0) {
    list.replaceChildren(emptyRow(view.empty));
    return;
  }
  const items: HTMLLIElement[] = [];
  let day = '';
  for (const entry of entries) {
    if (view.byDay) {
      const label = dayLabel(entry.at, view.now);
      if (label !== day) {
        day = label;
        const separator = document.createElement('li');
        separator.className = 'act-day';
        separator.append(span('', label));
        items.push(separator);
      }
    }
    items.push(row(entry, view));
  }
  list.replaceChildren(...items);
}
