// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDayPicker,
  createPresetChips,
} from '../renderer/schedule/day-picker.js';

function cells(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.sched-day')];
}

function key(target: Element, name: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('renderer/schedule/day-picker.ts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('createDayPicker', () => {
    it('draws seven equal cells, Monday first, pressed for the chosen days', () => {
      const picker = createDayPicker([1, 5], () => undefined);
      expect(picker.element.getAttribute('role')).toBe('group');
      expect(cells(picker.element).map((c) => c.textContent)).toEqual([
        'L',
        'M',
        'X',
        'J',
        'V',
        'S',
        'D',
      ]);
      expect(
        cells(picker.element).map((c) => c.getAttribute('aria-pressed')),
      ).toEqual(['true', 'false', 'false', 'false', 'true', 'false', 'false']);
      expect(cells(picker.element)[6]?.getAttribute('aria-label')).toBe(
        'domingo',
      );
    });

    it('toggles a day and reports the days sorted', () => {
      const seen: number[][] = [];
      const picker = createDayPicker([3], (days) => seen.push(days));
      cells(picker.element)[6]?.click();
      cells(picker.element)[0]?.click();
      expect(seen).toEqual([
        [0, 3],
        [0, 1, 3],
      ]);
      cells(picker.element)[0]?.click();
      expect(seen.at(-1)).toEqual([0, 3]);
      expect(cells(picker.element)[0]?.getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    it('moves the focus along the cells with the arrows, one tab stop', () => {
      const picker = createDayPicker([], () => undefined);
      document.body.append(picker.element);
      const all = cells(picker.element);
      expect(all.filter((c) => c.tabIndex === 0)).toHaveLength(1);
      all[0]?.focus();
      key(all[0], 'ArrowRight');
      expect(document.activeElement).toBe(all[1]);
      key(all[1], 'End');
      expect(document.activeElement).toBe(all[6]);
      key(all[6], 'ArrowRight');
      expect(document.activeElement).toBe(all[0]);
      key(all[0], 'ArrowLeft');
      expect(document.activeElement).toBe(all[6]);
      key(all[6], 'Home');
      expect(document.activeElement).toBe(all[0]);
      expect(all[0]?.tabIndex).toBe(0);
    });

    it('repaints from set() without reporting', () => {
      const seen: number[][] = [];
      const picker = createDayPicker([], (days) => seen.push(days));
      picker.set([0, 6]);
      expect(
        cells(picker.element)
          .filter((c) => c.getAttribute('aria-pressed') === 'true')
          .map((c) => c.textContent),
      ).toEqual(['S', 'D']);
      expect(seen).toEqual([]);
    });
  });

  describe('createPresetChips', () => {
    function chip(root: HTMLElement, label: string): HTMLButtonElement {
      const found = [
        ...root.querySelectorAll<HTMLButtonElement>('.sched-chip'),
      ].find((c) => c.textContent === label);
      if (!found) throw new Error(`no chip ${label}`);
      return found;
    }

    it('applies its days on a click', () => {
      const seen: number[][] = [];
      const presets = createPresetChips((days) => seen.push(days));
      chip(presets.element, 'Laborables').click();
      chip(presets.element, 'Todos').click();
      chip(presets.element, 'Fin de semana').click();
      expect(seen).toEqual([
        [1, 2, 3, 4, 5],
        [0, 1, 2, 3, 4, 5, 6],
        [0, 6],
      ]);
    });

    it.each([
      [[1, 2, 3, 4, 5], 'Laborables'],
      [[0, 1, 2, 3, 4, 5, 6], 'Todos'],
      [[], 'Todos'],
      [[6, 0], 'Fin de semana'],
    ])('highlights the preset that matches %j', (days, label) => {
      const presets = createPresetChips(() => undefined);
      presets.highlight(days);
      const on = [
        ...presets.element.querySelectorAll('.sched-chip[aria-pressed="true"]'),
      ].map((c) => c.textContent);
      expect(on).toEqual([label]);
    });

    it('highlights none for a custom set of days', () => {
      const presets = createPresetChips(() => undefined);
      presets.highlight([1, 3]);
      expect(
        presets.element.querySelectorAll('.sched-chip[aria-pressed="true"]'),
      ).toHaveLength(0);
    });
  });
});
