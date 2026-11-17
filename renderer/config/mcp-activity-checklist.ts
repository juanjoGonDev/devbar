/**
 * The checklist of a column menu, the way a spreadsheet filter reads:
 * «(Seleccionar todo)» on top, then one box per value with how many entries
 * it would show, optionally gathered under group boxes. A box that covers
 * several values is ticked, unticked or mixed (indeterminate).
 *
 * The selection is `null` while every value is shown, so a value that turns
 * up later (a new client) is shown too; ticking the last unticked box goes
 * back to `null`.
 */

export interface ChecklistItem {
  id: string;
  label: string;
  count: number;
  /** A coloured dot before the label (`data-result` styles it). */
  dot?: string;
  /** Gathers the item under a group box; items of a group come together. */
  group?: { key: string; label: string };
}

export type Selection = ReadonlySet<string> | null;
type Tri = boolean | 'mixed';

export interface ChecklistDeps {
  items: readonly ChecklistItem[];
  selected: Selection;
  /** The text of the menu's «Buscar» field: only matching items are listed. */
  find: string;
  change(next: Selection): void;
}

function triOf(
  items: readonly ChecklistItem[],
  has: (id: string) => boolean,
): Tri {
  const on = items.filter((item) => has(item.id)).length;
  if (on === items.length) return true;
  return on === 0 ? false : 'mixed';
}

function checkRow(
  label: string,
  state: Tri,
  onChange: (on: boolean) => void,
  extra: { className?: string; count?: number; dot?: string; key: string },
): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = `xf-check${extra.className ? ` ${extra.className}` : ''}`;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state === true;
  box.indeterminate = state === 'mixed';
  box.dataset.focusKey = extra.key;
  box.addEventListener('change', () => onChange(box.checked));
  row.append(box);
  if (extra.dot) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.result = extra.dot;
    row.append(dot);
  }
  const text = document.createElement('span');
  text.className = 'xf-check-label';
  text.textContent = label;
  row.append(text);
  if (extra.count !== undefined) {
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = String(extra.count);
    row.append(count);
  }
  return row;
}

export function checklist(deps: ChecklistDeps): HTMLElement {
  const { items, selected } = deps;
  const has = (id: string): boolean => !selected || selected.has(id);
  const commit = (next: Set<string>): void =>
    deps.change(items.every((item) => next.has(item.id)) ? null : next);
  const toggle = (ids: readonly string[], on: boolean): void => {
    const next = new Set(selected ?? items.map((item) => item.id));
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    commit(next);
  };

  const box = document.createElement('div');
  box.className = 'xf-list';
  box.append(
    checkRow(
      '(Seleccionar todo)',
      triOf(items, has),
      (on) => deps.change(on ? null : new Set()),
      { className: 'is-all', key: 'all' },
    ),
  );
  const needle = deps.find.trim().toLowerCase();
  const shown = items.filter(
    (item) =>
      !needle ||
      item.label.toLowerCase().includes(needle) ||
      (item.group?.label.toLowerCase().includes(needle) ?? false),
  );
  let group: string | null = null;
  for (const item of shown) {
    if (item.group && item.group.key !== group) {
      group = item.group.key;
      const key = group;
      const members = items.filter((each) => each.group?.key === key);
      box.append(
        checkRow(
          item.group.label,
          triOf(members, has),
          (on) =>
            toggle(
              members.map((each) => each.id),
              on,
            ),
          {
            className: 'is-group',
            count: members.reduce((sum, each) => sum + each.count, 0),
            key: `group:${key}`,
          },
        ),
      );
    }
    box.append(
      checkRow(item.label, has(item.id), (on) => toggle([item.id], on), {
        className: item.group ? 'is-child' : '',
        count: item.count,
        key: `item:${item.id}`,
        ...(item.dot ? { dot: item.dot } : {}),
      }),
    );
  }
  return box;
}
