// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIconPicker } from '../renderer/config/icon-picker.js';
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
});
