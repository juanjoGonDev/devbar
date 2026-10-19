/**
 * The tray popover's «Grupos | Workflows» tabs, under the header. One list
 * element (`#groups`) is the panel of whichever tab is selected; this module
 * only says which one that is and paints the selector — the count of visible
 * groups, the badge of running workflows — and `tray.ts` fills the panel.
 *
 * The choice is remembered per machine (localStorage, best effort). While
 * there is no workflow to list the selector is hidden and the groups show,
 * but the remembered choice is kept for when one appears.
 */

type TrayTab = 'groups' | 'workflows';

const STORAGE_KEY = 'devbar.tray.tab';
const ORDER: readonly TrayTab[] = ['groups', 'workflows'];

interface TrayTabsState {
  /** Whether there is any workflow to list (else: no selector, groups). */
  visible: boolean;
  /** Groups listed in plain sight (the hidden ones are not counted). */
  groups: number;
  /** Workflows running right now. */
  running: number;
}

export interface TrayTabs {
  /** The tab whose content the panel shows now. */
  active(): TrayTab;
  paint(state: TrayTabsState): void;
}

function readStored(): TrayTab | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return ORDER.find((tab) => tab === value) ?? null;
  } catch {
    return null;
  }
}

function writeStored(tab: TrayTab): void {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    /* storage unavailable: the choice lasts while the popover lives */
  }
}

export function createTrayTabs(options: {
  root: HTMLElement;
  panel: HTMLElement;
  /** The selected tab changed: refill the panel. */
  onChange: () => void;
}): TrayTabs {
  const { root, panel } = options;
  const buttons = new Map<TrayTab, HTMLButtonElement>();
  for (const tab of ORDER) {
    const button = root.querySelector<HTMLButtonElement>(`#tray-tab-${tab}`);
    if (button) buttons.set(tab, button);
  }
  const count = buttons.get('groups')?.querySelector('.tray-tab-count');
  const badge = buttons
    .get('workflows')
    ?.querySelector<HTMLElement>('.tray-tab-badge');
  let chosen: TrayTab = readStored() ?? 'groups';
  let visible = false;

  const active = (): TrayTab => (visible ? chosen : 'groups');

  function paintSelection(): void {
    for (const [tab, button] of buttons) {
      const selected = tab === chosen;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (visible) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `tray-tab-${chosen}`);
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-labelledby');
    }
  }

  function select(tab: TrayTab, focus = false): void {
    if (focus) buttons.get(tab)?.focus();
    if (tab === chosen) return;
    chosen = tab;
    writeStored(tab);
    paintSelection();
    options.onChange();
  }

  for (const [tab, button] of buttons) {
    button.addEventListener('click', () => select(tab));
    button.addEventListener('keydown', (event) => {
      const at = ORDER.indexOf(tab);
      const last = ORDER.length - 1;
      const next =
        event.key === 'ArrowRight'
          ? ORDER[at === last ? 0 : at + 1]
          : event.key === 'ArrowLeft'
            ? ORDER[at === 0 ? last : at - 1]
            : event.key === 'Home'
              ? ORDER[0]
              : event.key === 'End'
                ? ORDER[last]
                : undefined;
      if (!next) return;
      event.preventDefault();
      select(next, true);
    });
  }
  paintSelection();

  return {
    active,
    paint(state) {
      visible = state.visible;
      root.hidden = !visible;
      if (count) count.textContent = String(state.groups);
      if (badge) {
        badge.hidden = state.running === 0;
        badge.textContent = String(state.running);
        badge.setAttribute('aria-label', `${state.running} en ejecución`);
      }
      paintSelection();
    },
  };
}
