// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createIconPicker,
  ICON_CHUNK,
  type IconPickerOptions,
} from '../renderer/config/icon-picker.js';
import type { IconBatteryItem } from '../src/ipc-contract.js';

const RECENTS_KEY = 'devbar.recentIcons';

const BATTERY: IconBatteryItem[] = [
  {
    emoji: '😀',
    label: 'grinning',
    group: 'Smileys & Emotion',
    keywords: ['smile'],
  },
  {
    emoji: '🐶',
    label: 'dog face',
    group: 'Animals & Nature',
    keywords: ['pet'],
  },
  {
    emoji: '🍎',
    label: 'red apple',
    group: 'Food & Drink',
    keywords: ['fruit'],
  },
];

interface Harness {
  picker: HTMLDivElement;
  search: HTMLInputElement;
  grid: HTMLElement;
  dialog: HTMLDialogElement;
  anchor: HTMLButtonElement;
}

function elements(): Harness {
  document.body.innerHTML =
    '<div id="icon-tabs"></div><dialog id="dlg"></dialog><button id="anchor" class="icon-btn"></button>';
  const picker = document.createElement('div');
  picker.setAttribute('hidden', '');
  const search = document.createElement('input');
  const grid = document.createElement('div');
  picker.append(search, grid);
  document.body.appendChild(picker);
  return {
    picker,
    search,
    grid,
    dialog: document.getElementById('dlg') as HTMLDialogElement,
    anchor: document.getElementById('anchor') as HTMLButtonElement,
  };
}

function stubBattery(result: unknown, reject = false): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getIconBattery: () =>
        reject ? Promise.reject(new Error('no ipc')) : Promise.resolve(result),
    },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function cells(h: Harness): HTMLButtonElement[] {
  return [...h.grid.querySelectorAll<HTMLButtonElement>('.icon-cell')];
}

function tabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#icon-tabs .icon-tab')];
}

/** A scheduler the tests advance by hand: no timers, deterministic. */
function manualScheduler(): {
  schedule: (task: () => void) => void;
  runAll: () => Promise<void>;
  pending: () => number;
} {
  const queue: (() => void)[] = [];
  return {
    schedule: (task) => queue.push(task),
    pending: () => queue.length,
    runAll: async () => {
      // Chunks schedule more chunks: drain until the queue stays empty.
      while (queue.length) {
        const task = queue.shift();
        task?.();
      }
      await flush();
    },
  };
}

function batteryOf(
  count: number,
  group = 'Smileys & Emotion',
): IconBatteryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    emoji: String.fromCodePoint(0x1f600 + i),
    label: `face ${i}`,
    group,
  }));
}

describe('renderer/config/icon-picker.ts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the battery once the main process answers', async () => {
    const h = elements();
    stubBattery(BATTERY);
    createIconPicker(h);
    await flush();
    expect(cells(h)).toHaveLength(1); // the default group holds one icon
  });

  it('survives a battery that never arrives', async () => {
    const h = elements();
    stubBattery(null, true);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(cells(h)).toHaveLength(0);
    expect(tabs()).toHaveLength(0);
  });

  it('treats a null battery as an empty one', async () => {
    const h = elements();
    stubBattery(null);
    createIconPicker(h);
    await flush();
    expect(cells(h)).toHaveLength(0);
  });

  it('opens below its anchor, at body level, with one tab per stocked group', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(h.picker.hasAttribute('hidden')).toBe(false);
    expect(h.picker.parentElement).toBe(document.body);
    expect(tabs().map((t) => t.dataset.group)).toEqual([
      'Smileys & Emotion',
      'Animals & Nature',
      'Food & Drink',
    ]);
  });

  it('reparents into the sub-dialog while that dialog is open', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    h.dialog.open = true;
    picker.open(h.anchor, () => undefined);
    expect(h.picker.parentElement).toBe(h.dialog);
    // Opening again must not move it a second time.
    picker.open(h.anchor, () => undefined);
    expect(h.picker.parentElement).toBe(h.dialog);
    h.dialog.open = false;
    picker.open(h.anchor, () => undefined);
    expect(h.picker.parentElement).toBe(document.body);
  });

  it('reports the picked emoji, remembers it and closes', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    const picked: string[] = [];
    picker.open(h.anchor, (emoji) => picked.push(emoji));
    cells(h)[0].click();
    expect(picked).toEqual(['😀']);
    expect(h.picker.hasAttribute('hidden')).toBe(true);
    expect(JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')).toEqual([
      '😀',
    ]);
  });

  it('opens on "Recientes" once something has been picked', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify(['🐶']));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs()[0]?.dataset.group).toBe('Recientes');
    expect(cells(h).map((c) => c.textContent)).toEqual(['🐶']);
  });

  it('drops a remembered emoji the battery no longer ships', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify(['🐶', '👻']));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(cells(h).map((c) => c.textContent)).toEqual(['🐶']);
  });

  it('ignores recents that are not a list of strings', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify({ not: 'a list' }));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs()[0]?.dataset.group).toBe('Smileys & Emotion');
  });

  it('ignores recents that are not valid JSON', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, 'not json');
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs()[0]?.dataset.group).toBe('Smileys & Emotion');
  });

  it('keeps working when recents cannot be written', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const picked: string[] = [];
    picker.open(h.anchor, (emoji) => picked.push(emoji));
    cells(h)[0].click();
    expect(picked).toEqual(['😀']);
  });

  it('moves the grid to the clicked tab without rebuilding the tab bar', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    const before = tabs();
    before[1].click();
    expect(tabs()[1]).toBe(before[1]);
    expect(tabs()[1]?.classList.contains('is-active')).toBe(true);
    expect(cells(h).map((c) => c.textContent)).toEqual(['🐶']);
  });

  it('does nothing when the window has no tab bar', async () => {
    const h = elements();
    document.getElementById('icon-tabs')?.remove();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs()).toHaveLength(0);
    expect(h.picker.hasAttribute('hidden')).toBe(false);
  });

  it('searches across every category, by emoji, label and keyword', async () => {
    const h = elements();
    stubBattery(BATTERY);
    createIconPicker(h);
    await flush();
    h.search.value = 'apple';
    h.search.dispatchEvent(new Event('input'));
    expect(cells(h).map((c) => c.textContent)).toEqual(['🍎']);
    h.search.value = 'pet';
    h.search.dispatchEvent(new Event('input'));
    expect(cells(h).map((c) => c.textContent)).toEqual(['🐶']);
    h.search.value = '🐶';
    h.search.dispatchEvent(new Event('input'));
    expect(cells(h).map((c) => c.textContent)).toEqual(['🐶']);
  });

  it('matches nothing for a query no icon carries', async () => {
    const h = elements();
    stubBattery([
      { emoji: '🐶', label: 'dog face', group: 'Animals & Nature' },
    ]);
    createIconPicker(h);
    await flush();
    h.search.value = 'zzz';
    h.search.dispatchEvent(new Event('input'));
    expect(cells(h)).toHaveLength(0);
  });

  it('closes on a click outside, but not on one inside or on an icon button', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    h.grid.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.picker.hasAttribute('hidden')).toBe(false);
    h.anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.picker.hasAttribute('hidden')).toBe(false);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.picker.hasAttribute('hidden')).toBe(true);
    // Already closed: the handler must stay quiet.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.picker.hasAttribute('hidden')).toBe(true);
  });

  describe('incremental rendering', () => {
    function elementsWith(
      options?: IconPickerOptions & {
        scheduleTasks?: ReturnType<typeof manualScheduler>;
      },
    ): Harness & { tasks: ReturnType<typeof manualScheduler> } {
      const h = elements();
      const tasks = manualScheduler();
      stubBattery(batteryOf(10));
      createIconPicker(h, {
        schedule: tasks.schedule,
        ...options,
      });
      return { ...h, tasks };
    }

    it('renders the first chunk synchronously, the rest as the scheduler yields', async () => {
      const h = elementsWith({ chunkSize: 3 });
      await flush();
      const grid = h.grid.querySelector('.icon-grid') as HTMLElement;
      expect(grid.children.length).toBe(3);
      await h.tasks.runAll();
      expect(grid.children.length).toBe(10);
    });

    it('defaults the chunk to ' + ICON_CHUNK + ' cells', async () => {
      // A real-sized battery: the first paint must not build ~1900 buttons.
      const h = elements();
      const tasks = manualScheduler();
      stubBattery(batteryOf(250));
      createIconPicker(h, { schedule: tasks.schedule });
      await flush();
      const grid = h.grid.querySelector('.icon-grid') as HTMLElement;
      expect(grid.children.length).toBe(ICON_CHUNK);
      await tasks.runAll();
      expect(grid.children.length).toBe(250);
    });

    it('cancels queued chunks of a superseded render', async () => {
      const h = elementsWith({ chunkSize: 3 });
      await flush();
      // Mid-render the user types a filter that matches fewer icons: the
      // pending chunks of the OLD render must not append into the new one.
      h.search.value = 'face 9';
      h.search.dispatchEvent(new Event('input'));
      const grid = h.grid.querySelector('.icon-grid') as HTMLElement;
      expect(grid.children.length).toBe(1);
      await h.tasks.runAll();
      expect(grid.children.length).toBe(1);
      const emojis = [...grid.children].map((c) => c.textContent);
      expect(new Set(emojis).size).toBe(1);
    });

    it('stops rendering once the picker is closed', async () => {
      const h = elements();
      const tasks = manualScheduler();
      stubBattery(batteryOf(10));
      const picker = createIconPicker(h, {
        schedule: tasks.schedule,
        chunkSize: 3,
      });
      await flush();
      const grid = h.grid.querySelector('.icon-grid') as HTMLElement;
      expect(grid.children.length).toBe(3);
      picker.close();
      await tasks.runAll();
      // A hidden picker must not keep burning CPU appending cells nobody
      // can see.
      expect(grid.children.length).toBe(3);
    });
  });
});
