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
  { name: 'smile', tags: ['emoji', 'happy'] },
  { name: 'dog', tags: ['pet', 'animal'] },
  { name: 'apple', tags: ['fruit', 'food'] },
  { name: 'shopping-cart', tags: ['trolley'] },
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

function names(h: Harness): string[] {
  return cells(h).map((c) => c.dataset.name ?? '');
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

function batteryOf(count: number): IconBatteryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `icon-${i}`,
    tags: [`tag ${i}`],
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
    expect(names(h)).toEqual(['smile', 'dog', 'apple', 'shopping-cart']);
  });

  it('paints each cell with its icon and names it for the pointer and AT', async () => {
    const h = elements();
    stubBattery(BATTERY);
    createIconPicker(h);
    await flush();
    const cell = cells(h)[1];
    expect(cell?.title).toBe('dog');
    expect(cell?.getAttribute('aria-label')).toBe('dog');
    expect(cell?.querySelector<HTMLElement>('.icon')?.dataset.icon).toBe('dog');
  });

  it('survives a battery that never arrives', async () => {
    const h = elements();
    stubBattery(null, true);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(cells(h)).toHaveLength(0);
    // Only the uploads tab is left: uploading needs no battery.
    expect(tabs().map((t) => t.dataset.group)).toEqual(['custom']);
  });

  it('treats a null battery as an empty one', async () => {
    const h = elements();
    stubBattery(null);
    createIconPicker(h);
    await flush();
    expect(cells(h)).toHaveLength(0);
  });

  it('opens below its anchor, at body level, on the full list', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(h.picker.hasAttribute('hidden')).toBe(false);
    expect(h.picker.parentElement).toBe(document.body);
    expect(tabs().map((t) => t.dataset.group)).toEqual(['all', 'custom']);
    expect(tabs()[0]?.title).toBe('Todos');
    expect(tabs()[1]?.title).toBe('Mis iconos');
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

  it('reports the picked icon name, remembers it and closes', async () => {
    const h = elements();
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    const picked: string[] = [];
    picker.open(h.anchor, (name) => picked.push(name));
    cells(h)[0].click();
    expect(picked).toEqual(['smile']);
    expect(h.picker.hasAttribute('hidden')).toBe(true);
    expect(JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')).toEqual([
      'smile',
    ]);
  });

  it('opens on "Recientes" once something has been picked', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify(['dog']));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs().map((t) => t.dataset.group)).toEqual([
      'recent',
      'all',
      'custom',
    ]);
    expect(tabs()[0]?.title).toBe('Recientes');
    expect(names(h)).toEqual(['dog']);
  });

  it('drops remembered emoji from the old picker and names Lucide no longer ships', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify(['🐶', 'dog', 'ghost']));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(names(h)).toEqual(['dog']);
  });

  it('skips the recents tab when none of the remembered values survive', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify(['🐶', '📦']));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs().map((t) => t.dataset.group)).toEqual(['all', 'custom']);
  });

  it('ignores recents that are not a list of strings', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify({ not: 'a list' }));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs()[0]?.dataset.group).toBe('all');
  });

  it('ignores recents that are not valid JSON', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, 'not json');
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    expect(tabs()[0]?.dataset.group).toBe('all');
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
    picker.open(h.anchor, (name) => picked.push(name));
    cells(h)[0].click();
    expect(picked).toEqual(['smile']);
  });

  it('moves the grid to the clicked tab without rebuilding the tab bar', async () => {
    const h = elements();
    localStorage.setItem(RECENTS_KEY, JSON.stringify(['dog']));
    stubBattery(BATTERY);
    const picker = createIconPicker(h);
    await flush();
    picker.open(h.anchor, () => undefined);
    const before = tabs();
    before[1].click();
    expect(tabs()[1]).toBe(before[1]);
    expect(tabs()[1]?.classList.contains('is-active')).toBe(true);
    expect(names(h)).toHaveLength(BATTERY.length);
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
    // Still usable: the grid shows every icon.
    expect(names(h)).toHaveLength(BATTERY.length);
  });

  it('searches by name and by tag', async () => {
    const h = elements();
    stubBattery(BATTERY);
    createIconPicker(h);
    await flush();
    h.search.value = 'APPLE';
    h.search.dispatchEvent(new Event('input'));
    expect(names(h)).toEqual(['apple']);
    h.search.value = 'pet';
    h.search.dispatchEvent(new Event('input'));
    expect(names(h)).toEqual(['dog']);
    // Spaces and dashes are interchangeable: "shopping cart" finds the
    // dashed Lucide name.
    h.search.value = 'shopping cart';
    h.search.dispatchEvent(new Event('input'));
    expect(names(h)).toEqual(['shopping-cart']);
  });

  it('ranks name matches ahead of tag matches', async () => {
    const h = elements();
    stubBattery([
      { name: 'box', tags: ['dog'] },
      { name: 'dog', tags: [] },
    ]);
    createIconPicker(h);
    await flush();
    h.search.value = 'dog';
    h.search.dispatchEvent(new Event('input'));
    expect(names(h)).toEqual(['dog', 'box']);
  });

  it('matches nothing for a query no icon carries', async () => {
    const h = elements();
    stubBattery([{ name: 'dog', tags: ['pet'] }]);
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
      // A real-sized battery: the first paint must not build ~1800 buttons.
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
      h.search.value = 'icon-9';
      h.search.dispatchEvent(new Event('input'));
      const grid = h.grid.querySelector('.icon-grid') as HTMLElement;
      expect(grid.children.length).toBe(1);
      await h.tasks.runAll();
      expect(grid.children.length).toBe(1);
      const shown = [...grid.children].map(
        (c) => (c as HTMLElement).dataset.name,
      );
      expect(shown).toEqual(['icon-9']);
    });

    it('falls back to the default chunk for a size that cannot stream', async () => {
      // 0 never advances the stream and a negative one moves it backwards:
      // either would keep appendChunk scheduling work forever.
      for (const bad of [0, -3]) {
        const h = elements();
        const tasks = manualScheduler();
        stubBattery(batteryOf(200));
        createIconPicker(h, { schedule: tasks.schedule, chunkSize: bad });
        await flush();
        const grid = h.grid.querySelector('.icon-grid') as HTMLElement;
        expect(grid.children.length, `chunkSize ${bad}`).toBe(ICON_CHUNK);
        await tasks.runAll();
        expect(grid.children.length, `chunkSize ${bad}`).toBe(200);
      }
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
