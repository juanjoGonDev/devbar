import type { IconBatteryItem } from '../../src/ipc-contract.js';

/** The picker's own chrome, as the window's markup declares it. */
export interface IconPickerElements {
  picker: HTMLDivElement;
  search: HTMLInputElement;
  grid: HTMLElement;
  /** The sub-dialog the picker must reparent into while it is open. */
  dialog: HTMLDialogElement;
}

export interface IconPicker {
  open(anchorEl: HTMLElement, onSelect: (emoji: string) => void): void;
  close(): void;
}

// macOS-style category order + Spanish headers (data stays English-keyed).
const ICON_GROUP_ORDER = [
  'Smileys & Emotion',
  'People & Body',
  'Animals & Nature',
  'Food & Drink',
  'Travel & Places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
] as const;
type IconGroup = (typeof ICON_GROUP_ORDER)[number] | 'Recientes';
const ICON_GROUP_LABELS: Record<IconGroup, string> = {
  'Smileys & Emotion': 'Caras y emociones',
  'People & Body': 'Personas',
  'Animals & Nature': 'Animales y naturaleza',
  'Food & Drink': 'Comida y bebida',
  'Travel & Places': 'Viajes y lugares',
  Activities: 'Actividades',
  Objects: 'Objetos',
  Symbols: 'Símbolos',
  Flags: 'Banderas',
  Recientes: 'Recientes',
};

// Representative glyph per tab (macOS-style).
const ICON_GROUP_TAB: Record<IconGroup, string> = {
  Recientes: '🕘',
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐶',
  'Food & Drink': '🍎',
  'Travel & Places': '🚗',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '❤️',
  Flags: '🏳️',
};

const RECENT_ICONS_KEY = 'devbar.recentIcons';
const RECENT_ICONS_MAX = 20;

function getRecentIcons(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(RECENT_ICONS_KEY) || '[]',
    ) as unknown;
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .slice(0, RECENT_ICONS_MAX)
      : [];
  } catch {
    return [];
  }
}

function pushRecentIcon(emoji: string): void {
  const next = [emoji, ...getRecentIcons().filter((e) => e !== emoji)].slice(
    0,
    RECENT_ICONS_MAX,
  );
  try {
    localStorage.setItem(RECENT_ICONS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — recents just won't persist */
  }
}

export function createIconPicker(els: IconPickerElements): IconPicker {
  let allIcons: readonly IconBatteryItem[] = [];
  let iconPickerCallback: ((emoji: string) => void) | null = null;
  let activeIconGroup: IconGroup = 'Smileys & Emotion';

  function makeIconCell(item: IconBatteryItem): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'icon-cell';
    btn.title = item.label;
    btn.textContent = item.emoji;
    btn.addEventListener('click', () => {
      pushRecentIcon(item.emoji);
      if (iconPickerCallback) iconPickerCallback(item.emoji);
      closeIconPicker();
    });
    return btn;
  }

  function iconsInGroup(group: IconGroup): IconBatteryItem[] {
    if (group === 'Recientes') {
      return getRecentIcons()
        .map((e) => allIcons.find((i) => i.emoji === e))
        .filter((item): item is IconBatteryItem => item !== undefined);
    }
    return allIcons.filter((i) => i.group === group);
  }

  // Tabs to show: Recents (only if any) + the macOS categories that have icons.
  function availableIconTabs(): IconGroup[] {
    const tabs: IconGroup[] = [];
    if (getRecentIcons().length) tabs.push('Recientes');
    for (const g of ICON_GROUP_ORDER) {
      if (allIcons.some((i) => i.group === g)) tabs.push(g);
    }
    return tabs;
  }

  function renderIconTabs() {
    const tabsEl = document.getElementById('icon-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const g of availableIconTabs()) {
      const btn = document.createElement('button');
      btn.className = 'icon-tab' + (g === activeIconGroup ? ' is-active' : '');
      btn.textContent = ICON_GROUP_TAB[g] || '•';
      btn.title = ICON_GROUP_LABELS[g] || g;
      btn.dataset.group = g;
      btn.addEventListener('click', () => {
        activeIconGroup = g;
        els.search.value = '';
        // Toggle active class in place — do NOT rebuild the tab bar here, or the
        // clicked button detaches mid-click and the outside-click handler treats
        // it as a click outside the picker and closes it.
        for (const t of tabsEl.querySelectorAll<HTMLElement>('.icon-tab')) {
          t.classList.toggle('is-active', t.dataset.group === g);
        }
        renderIconGrid('');
      });
      tabsEl.appendChild(btn);
    }
  }

  function renderIconGrid(filter: string): void {
    els.grid.innerHTML = '';
    const q = (filter || '').toLowerCase().trim();

    // Searching: flat results across ALL categories.
    const items = q
      ? allIcons.filter(
          (i) =>
            i.emoji.startsWith(q) ||
            i.label.toLowerCase().includes(q) ||
            (i.keywords && i.keywords.some((k) => k.includes(q))),
        )
      : iconsInGroup(activeIconGroup);

    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    for (const item of items) grid.appendChild(makeIconCell(item));
    els.grid.appendChild(grid);
  }

  function openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (emoji: string) => void,
  ): void {
    iconPickerCallback = onSelect;
    els.search.value = '';
    const tabs = availableIconTabs();
    activeIconGroup = tabs[0] || ICON_GROUP_ORDER[0];
    renderIconTabs();
    renderIconGrid('');

    // Reparent the picker: if the sub-dialog is open it lives in the top layer,
    // so the picker must also be inside the dialog to appear above the backdrop.
    // Otherwise keep it at body level. The picker uses position:fixed so
    // top/left are always viewport-relative regardless of parent.
    if (els.dialog.open) {
      if (els.picker.parentElement !== els.dialog) {
        els.dialog.appendChild(els.picker);
      }
    } else {
      if (els.picker.parentElement !== document.body) {
        document.body.appendChild(els.picker);
      }
    }

    els.picker.removeAttribute('hidden');
    // Position below anchor using viewport-relative coords (works with position:fixed)
    const rect = anchorEl.getBoundingClientRect();
    els.picker.style.top = `${rect.bottom + 4}px`;
    els.picker.style.left = `${rect.left}px`;
    els.search.focus();
  }

  function closeIconPicker(): void {
    els.picker.setAttribute('hidden', '');
    iconPickerCallback = null;
  }

  // Load the battery from the main process (single source of truth).
  // Render an empty grid until it resolves, then re-render.
  window.api
    .getIconBattery()
    .then((battery) => {
      allIcons = battery || [];
      renderIconGrid(els.search.value || '');
    })
    .catch(() => {
      // If IPC fails (e.g., test environment), allIcons stays []
    });

  els.search.addEventListener('input', () => renderIconGrid(els.search.value));
  document.addEventListener('click', (e) => {
    if (
      !els.picker.hidden &&
      !(e.target instanceof Node && els.picker.contains(e.target)) &&
      !(e.target instanceof Element && e.target.closest('.icon-btn'))
    ) {
      closeIconPicker();
    }
  });

  return { open: openIconPicker, close: closeIconPicker };
}
