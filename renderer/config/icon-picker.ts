import type { IconBatteryItem } from '../../src/ipc-contract.js';
import { customIconIdOf, customIconRef } from '../../src/custom-icons.js';
import { customIconList, icon, userIcon, type IconName } from '../icon.js';
import { getRecentIcons, pushRecentIcon } from './icon-recents.js';
import { renderCustomIconPanel } from './icon-picker-custom.js';
import {
  buildIconSearchIndex,
  normalizeSearchText,
  searchIconIndex,
  type IconSearchIndex,
} from './icon-search.js';

/** The picker's own chrome, as the window's markup declares it. */
export interface IconPickerElements {
  picker: HTMLDivElement;
  search: HTMLInputElement;
  grid: HTMLElement;
  /** The sub-dialog the picker must reparent into while it is open. */
  dialog: HTMLDialogElement;
}

export interface IconPicker {
  /** `onSelect` gets what an icon field stores: a Lucide name or
   *  `img:<id>` for an uploaded image. */
  open(anchorEl: HTMLElement, onSelect: (value: string) => void): void;
  close(): void;
  /** Re-renders an open picker after the uploaded-icon library changed. */
  refresh(): void;
}

/**
 * Lucide ships no categories, so the picker has three views: what was picked
 * lately, everything (searchable in English and Spanish), and the images the
 * user uploaded.
 */
type IconTab = 'recent' | 'all' | 'custom';
const ICON_TABS: Record<IconTab, { label: string; icon: IconName }> = {
  recent: { label: 'Recientes', icon: 'history' },
  all: { label: 'Todos', icon: 'layout-grid' },
  custom: { label: 'Mis iconos', icon: 'image' },
};

/**
 * How many cells render synchronously per step. The picker can list ~1800
 * icons; building that many buttons (each with a click listener) in one
 * go spiked the CPU on low-end hosts — the fans literally spun up opening
 * the picker on a Raspberry Pi. The rest streams in as the scheduler
 * yields.
 */
export const ICON_CHUNK = 96;

export interface IconPickerOptions {
  /** Yields one chunk of work. Defaults to requestIdleCallback with a
   *  setTimeout fallback; tests inject a manual queue. */
  schedule?: (task: () => void) => void;
  /** Cells per chunk. Tests use a tiny one to observe the growth. */
  chunkSize?: number;
}

function defaultSchedule(task: () => void): void {
  const idle = (
    window as {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => void;
    }
  ).requestIdleCallback;
  if (idle) idle(task, { timeout: 200 });
  else setTimeout(task, 0);
}

/** One cell of a grid: the stored value and how the cell names it. */
interface PickerItem {
  value: string;
  label: string;
}

function batteryItem(item: IconBatteryItem): PickerItem {
  // The Spanish rendering of the name rides along in the tooltip.
  return {
    value: item.name,
    label: item.esName ? `${item.name} · ${item.esName}` : item.name,
  };
}

function customItems(query = ''): PickerItem[] {
  const q = normalizeSearchText(query);
  return customIconList()
    .filter((item) => !q || normalizeSearchText(item.name).includes(q))
    .map((item) => ({ value: customIconRef(item.id), label: item.name }));
}

export function createIconPicker(
  els: IconPickerElements,
  options: IconPickerOptions = {},
): IconPicker {
  const schedule = options.schedule ?? defaultSchedule;
  // A chunk of 0 never advances the stream and a negative one moves it
  // backwards — either way `end < items.length` stays true and appendChunk
  // keeps scheduling work forever. Only a positive integer streams.
  const requestedChunk = options.chunkSize ?? ICON_CHUNK;
  const chunkSize =
    Number.isInteger(requestedChunk) && requestedChunk > 0
      ? requestedChunk
      : ICON_CHUNK;
  let allIcons: readonly IconBatteryItem[] = [];
  let searchIndex: IconSearchIndex = [];
  let iconPickerCallback: ((value: string) => void) | null = null;
  let activeTab: IconTab = 'all';
  // Bumped on every re-render and on close: a queued chunk from a superseded
  // render must not append into a grid it no longer belongs to.
  let renderEpoch = 0;

  function pick(value: string): void {
    pushRecentIcon(value);
    if (iconPickerCallback) iconPickerCallback(value);
    closeIconPicker();
  }

  function makeIconCell(value: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-cell';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.dataset.name = value;
    btn.append(userIcon(value, 'package'));
    btn.addEventListener('click', () => pick(value));
    return btn;
  }

  /** Remembered values that still exist. The emoji the previous picker
   *  stored under the same key, and deleted uploads, drop out. */
  function recentItems(): PickerItem[] {
    const uploads = new Map(customIconList().map((i) => [i.id, i]));
    return getRecentIcons().flatMap((value): PickerItem[] => {
      const id = customIconIdOf(value);
      const upload = id === null ? undefined : uploads.get(id);
      if (upload) return [{ value, label: upload.name }];
      const found = allIcons.find((i) => i.name === value);
      return found ? [batteryItem(found)] : [];
    });
  }

  function availableIconTabs(): IconTab[] {
    const tabs: IconTab[] = [];
    if (recentItems().length) tabs.push('recent');
    if (allIcons.length) tabs.push('all');
    // Always offered: it is where uploading starts.
    tabs.push('custom');
    return tabs;
  }

  function renderIconTabs() {
    const tabsEl = document.getElementById('icon-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    for (const tab of availableIconTabs()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-tab' + (tab === activeTab ? ' is-active' : '');
      btn.append(icon(ICON_TABS[tab].icon));
      btn.title = ICON_TABS[tab].label;
      btn.setAttribute('aria-label', ICON_TABS[tab].label);
      btn.dataset.group = tab;
      btn.addEventListener('click', () => {
        activeTab = tab;
        els.search.value = '';
        // Toggle active class in place — do NOT rebuild the tab bar here, or the
        // clicked button detaches mid-click and the outside-click handler treats
        // it as a click outside the picker and closes it.
        for (const t of tabsEl.querySelectorAll<HTMLElement>('.icon-tab')) {
          t.classList.toggle('is-active', t.dataset.group === tab);
        }
        renderIconGrid('');
      });
      tabsEl.appendChild(btn);
    }
  }

  function renderCustomTab(): void {
    renderEpoch++;
    renderCustomIconPanel(els.grid, {
      makeCell: makeIconCell,
      select: pick,
      rerender: () => {
        els.grid.innerHTML = '';
        renderCustomTab();
      },
    });
  }

  function renderIconGrid(filter: string): void {
    els.grid.innerHTML = '';
    const query = (filter || '').trim();
    if (!query && activeTab === 'custom') {
      renderCustomTab();
      return;
    }

    // Searching: flat results across the whole set, uploads first.
    const items: PickerItem[] = query
      ? [
          ...customItems(query),
          ...searchIconIndex(searchIndex, query).map(batteryItem),
        ]
      : activeTab === 'recent'
        ? recentItems()
        : allIcons.map(batteryItem);

    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    els.grid.appendChild(grid);
    // First chunk lands synchronously (the grid must not look empty), the
    // rest streams in through the scheduler. Any queued chunk checks the
    // epoch: a newer render (or a close) supersedes it.
    renderEpoch++;
    const epoch = renderEpoch;
    const appendChunk = (from: number): void => {
      if (epoch !== renderEpoch || !grid.isConnected) return;
      const end = Math.min(from + chunkSize, items.length);
      for (const item of items.slice(from, end))
        grid.appendChild(makeIconCell(item.value, item.label));
      if (end < items.length) schedule(() => appendChunk(end));
    };
    appendChunk(0);
  }

  function openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (value: string) => void,
  ): void {
    iconPickerCallback = onSelect;
    els.search.value = '';
    activeTab = availableIconTabs()[0] ?? 'all';
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
    // Invalidate queued chunks: a hidden picker must not keep burning CPU
    // appending cells nobody can see.
    renderEpoch++;
    els.picker.setAttribute('hidden', '');
    iconPickerCallback = null;
  }

  function refresh(): void {
    if (els.picker.hidden) return;
    renderIconGrid(els.search.value);
  }

  // Load the battery from the main process (single source of truth).
  // Render an empty grid until it resolves, then re-render.
  window.api
    .getIconBattery()
    .then((battery) => {
      allIcons = battery || [];
      searchIndex = buildIconSearchIndex(allIcons);
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

  return { open: openIconPicker, close: closeIconPicker, refresh };
}
