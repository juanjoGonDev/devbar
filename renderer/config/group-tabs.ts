/**
 * The group editor's tabs. A native-style tablist: one tab stop (roving
 * tabindex), ←/→ wrap around, Home/End jump to the ends, and moving
 * selects (automatic activation) since every panel is already built.
 */

export type GroupTabId = 'processes' | 'prescripts' | 'env' | 'settings';

const TABS: ReadonlyArray<{ id: GroupTabId; label: string }> = [
  { id: 'processes', label: 'Procesos' },
  { id: 'prescripts', label: 'Pre-scripts' },
  { id: 'env', label: 'Entorno' },
  { id: 'settings', label: 'Ajustes' },
];

export interface GroupTabs {
  /** The `role="tablist"` strip. */
  list: HTMLElement;
  panel(id: GroupTabId): HTMLElement;
  /** Every panel, in tab order, to append after the header. */
  panels(): HTMLElement[];
  /** Sets (or, with null, drops) the count beside a tab's name. */
  setCount(id: GroupTabId, count: number | null): void;
}

function nextIndex(key: string, at: number, count: number): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return (at + 1) % count;
  if (key === 'ArrowLeft') return at <= 0 ? count - 1 : at - 1;
  return null;
}

export function buildGroupTabs(
  active: GroupTabId,
  onSelect: (id: GroupTabId) => void,
): GroupTabs {
  const list = document.createElement('div');
  list.className = 'detail-tabs';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Secciones del grupo');

  const buttons = new Map<GroupTabId, HTMLButtonElement>();
  const counts = new Map<GroupTabId, HTMLSpanElement>();
  const panels = new Map<GroupTabId, HTMLElement>();

  for (const { id, label } of TABS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'detail-tab';
    button.id = `group-tab-${id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `group-panel-${id}`);
    const name = document.createElement('span');
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'detail-tab-count';
    count.hidden = true;
    button.append(name, count);
    button.addEventListener('click', () => select(id));
    list.append(button);
    buttons.set(id, button);
    counts.set(id, count);

    const panel = document.createElement('div');
    panel.className = 'detail-panel';
    panel.id = `group-panel-${id}`;
    panel.dataset.tab = id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels.set(id, panel);
  }

  function select(id: GroupTabId): void {
    for (const [tabId, button] of buttons) {
      const on = tabId === id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      const panel = panels.get(tabId);
      if (panel) panel.hidden = !on;
    }
    onSelect(id);
  }

  list.addEventListener('keydown', (event) => {
    const order = TABS.map((t) => t.id);
    const at = order.findIndex((id) => buttons.get(id) === event.target);
    if (at < 0) return;
    const next = nextIndex(event.key, at, order.length);
    if (next === null) return;
    event.preventDefault();
    const id = order[next];
    if (!id) return;
    select(id);
    buttons.get(id)?.focus();
  });

  select(active);

  return {
    list,
    panel: (id) => {
      const found = panels.get(id);
      if (!found) throw new Error(`no panel ${id}`);
      return found;
    },
    panels: () => TABS.map((t) => panels.get(t.id) as HTMLElement),
    setCount: (id, count) => {
      const el = counts.get(id);
      if (!el) return;
      el.hidden = count === null;
      el.textContent = count === null ? '' : String(count);
    },
  };
}
