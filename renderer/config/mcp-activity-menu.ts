import type {
  McpAuditFacets,
  McpAuditResult,
  McpScopeKey,
} from '../../src/ipc-contract/mcp-api.js';
import { AUDIT_RESULT_LABELS } from '../../src/mcp-audit-labels.js';
import { icon, type IconName } from '../icon.js';
import {
  checklist,
  type ChecklistItem,
  type Selection,
} from './mcp-activity-checklist.js';
import {
  isFiltered,
  localInput,
  TIME_PRESETS,
  type ActivityState,
  type ColumnDef,
  type SortDir,
  type TimeFilter,
  type TimePreset,
} from './mcp-activity-model.js';
import { SCOPE_KEYS, SCOPE_LABELS } from './mcp-format.js';

/**
 * What a column's menu holds: the sort entries on top, then its filter — the
 * time chips and range for «Hora», a searchable checklist for the others
 * (tools gathered by family, results with their colour and the «Solo se
 * puede deshacer» switch) — and «Quitar filtro» / «Listo» at the foot.
 * Rebuilt whole on every change; the column header keeps the popover itself.
 */

export interface MenuContext {
  column: ColumnDef;
  state: ActivityState;
  facets: McpAuditFacets | null;
  now: number;
  /** The text of this column's «Buscar» field (kept while the menu is open). */
  find: string;
  setFind(text: string): void;
  sort(dir: SortDir): void;
  addSort(): void;
  removeSort(): void;
  setTime(time: TimeFilter): void;
  select(next: Selection): void;
  setUndoable(on: boolean): void;
  clear(): void;
  done(): void;
}

const DAY = 24 * 60 * 60 * 1000;
const RESULTS: readonly McpAuditResult[] = [
  'ok',
  'warning',
  'error',
  'rejected',
  'pending',
];

function section(...children: HTMLElement[]): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'xf-sec';
  el.append(...children);
  return el;
}

function item(
  name: IconName,
  label: string,
  on: boolean,
  key: string,
  run: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xf-item';
  button.dataset.focusKey = key;
  const text = document.createElement('span');
  text.textContent = label;
  button.append(icon(name), text);
  if (on) {
    const check = icon('check');
    check.classList.add('on');
    button.append(check);
    button.setAttribute('aria-current', 'true');
  }
  button.addEventListener('click', run);
  return button;
}

function sortSection(ctx: MenuContext): HTMLDivElement {
  const { column, state } = ctx;
  const at = state.sort.findIndex((each) => each.key === column.key);
  const mine = state.sort[at];
  const others = state.sort.some((each) => each.key !== column.key);
  const alone = (dir: SortDir): boolean => mine?.dir === dir && !others;
  const sec = section(
    item('arrow-up-narrow-wide', column.asc, alone('asc'), 'sort-asc', () =>
      ctx.sort('asc'),
    ),
    item(
      'arrow-down-wide-narrow',
      column.desc,
      alone('desc'),
      'sort-desc',
      () => ctx.sort('desc'),
    ),
  );
  if (others && !mine)
    sec.append(
      item('plus', 'Añadir a la ordenación', false, 'sort-add', () =>
        ctx.addSort(),
      ),
    );
  if (mine && others)
    sec.append(
      item(
        'x',
        `Quitar de la ordenación (${at + 1}º)`,
        false,
        'sort-remove',
        () => ctx.removeSort(),
      ),
    );
  return sec;
}

function timeFilter(ctx: MenuContext): HTMLElement[] {
  const { time } = ctx.state;
  const chips = document.createElement('div');
  chips.className = 'xf-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Periodo');
  for (const [preset, label] of TIME_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'xf-chip';
    chip.textContent = label;
    chip.dataset.focusKey = `when:${preset}`;
    chip.setAttribute('aria-pressed', String(time.when === preset));
    chip.addEventListener('click', () =>
      ctx.setTime(pickPreset(time, preset, ctx.now)),
    );
    chips.append(chip);
  }
  if (time.when !== 'custom') return [chips];
  const range = document.createElement('div');
  range.className = 'xf-range';
  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
  ): void => {
    const name = document.createElement('label');
    name.htmlFor = id;
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.id = id;
    input.value = value;
    input.dataset.focusKey = id;
    input.addEventListener('change', () => set(input.value));
    range.append(name, input);
  };
  field('mcp-activity-from', 'Desde', time.from, (from) =>
    ctx.setTime({ ...time, from }),
  );
  field('mcp-activity-to', 'Hasta', time.to, (to) =>
    ctx.setTime({ ...time, to }),
  );
  return [chips, range];
}

function pickPreset(
  time: TimeFilter,
  when: TimePreset,
  now: number,
): TimeFilter {
  if (when !== 'custom') return { ...time, when };
  // A first range starts as the last day, ready to adjust.
  if (time.from || time.to) return { ...time, when };
  return { when, from: localInput(now - DAY), to: localInput(now) };
}

function familyLabel(family: McpScopeKey | null): string {
  return family ? SCOPE_LABELS[family] : 'Otras';
}

function itemsOf(ctx: MenuContext): ChecklistItem[] {
  const facets = ctx.facets;
  switch (ctx.column.key) {
    case 'client':
      return (facets?.clients ?? []).map((c) => ({
        id: c.id,
        label: c.name,
        count: c.count,
      }));
    case 'result':
      return RESULTS.map((result) => ({
        id: result,
        label: AUDIT_RESULT_LABELS[result],
        count: facets?.results.find((r) => r.result === result)?.count ?? 0,
        dot: result,
      }));
    default: {
      const tools = facets?.tools ?? [];
      const families: (McpScopeKey | null)[] = [...SCOPE_KEYS, null];
      return families.flatMap((family) =>
        tools
          .filter((t) => t.family === family)
          .map((t) => ({
            id: t.tool,
            label: t.tool,
            count: t.count,
            group: { key: family ?? 'other', label: familyLabel(family) },
          })),
      );
    }
  }
}

function selectionOf(ctx: MenuContext): Selection {
  const { state } = ctx;
  if (ctx.column.key === 'client') return state.clients;
  if (ctx.column.key === 'result') return state.results;
  return state.tools;
}

function valueFilter(ctx: MenuContext): HTMLElement[] {
  const find = document.createElement('div');
  find.className = 'xf-find';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Buscar';
  input.setAttribute(
    'aria-label',
    `Buscar en ${ctx.column.label.toLowerCase()}`,
  );
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = ctx.find;
  input.dataset.focusKey = 'find';
  find.append(icon('search'), input);
  const items = itemsOf(ctx);
  const build = (): HTMLElement =>
    checklist({
      items,
      selected: selectionOf(ctx),
      find: input.value,
      change: (next) => ctx.select(next),
    });
  let list = build();
  input.addEventListener('input', () => {
    ctx.setFind(input.value);
    const next = build();
    list.replaceWith(next);
    list = next;
  });
  const parts: HTMLElement[] = [find, list];
  if (ctx.column.key === 'result') {
    const row = document.createElement('label');
    row.className = 'xf-switch';
    const text = document.createElement('span');
    text.textContent = 'Solo se puede deshacer';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'remote-switch';
    toggle.setAttribute('role', 'switch');
    toggle.checked = ctx.state.undoable;
    toggle.dataset.focusKey = 'undoable';
    toggle.addEventListener('change', () => ctx.setUndoable(toggle.checked));
    row.append(text, toggle);
    parts.push(row);
  }
  return parts;
}

function foot(ctx: MenuContext): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'xf-foot';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'xf-foot-link';
  clear.textContent = 'Quitar filtro';
  clear.dataset.focusKey = 'clear';
  clear.disabled = !isFiltered(ctx.state, ctx.column.key);
  clear.addEventListener('click', () => ctx.clear());
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'small-btn primary';
  done.textContent = 'Listo';
  done.dataset.focusKey = 'done';
  done.addEventListener('click', () => ctx.done());
  el.append(clear, done);
  return el;
}

export function menuContent(ctx: MenuContext): HTMLElement[] {
  const title = document.createElement('div');
  title.className = 'xf-title';
  title.textContent = 'Filtrar';
  const filter = ctx.column.key === 'time' ? timeFilter(ctx) : valueFilter(ctx);
  return [sortSection(ctx), section(title, ...filter), foot(ctx)];
}
