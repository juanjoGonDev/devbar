// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createScheduleEditor,
  type ScheduleValue,
} from '../renderer/schedule/schedule-editor.js';

// 2026-01-05 is a Monday; 12:20.
const NOW = new Date(2026, 0, 5, 12, 20).getTime();
const WEEKDAYS_AT_8: ScheduleValue = {
  rules: [{ time: '08:00', days: [1, 2, 3, 4, 5] }],
  interval: null,
};

interface Harness {
  editor: ReturnType<typeof createScheduleEditor>;
  root: HTMLElement;
  changes: ScheduleValue[];
  domChanges: number;
}

function harness(value: ScheduleValue = WEEKDAYS_AT_8): Harness {
  document.body.innerHTML = '';
  const changes: ScheduleValue[] = [];
  const editor = createScheduleEditor({
    value,
    defaultRule: { time: '09:00', days: [] },
    now: () => NOW,
    onChange: (next) => changes.push(next),
  });
  document.body.append(editor.element);
  const h: Harness = { editor, root: editor.element, changes, domChanges: 0 };
  editor.element.addEventListener('change', () => {
    h.domChanges += 1;
  });
  return h;
}

function all<T extends HTMLElement = HTMLElement>(
  h: Harness,
  selector: string,
): T[] {
  return [...h.root.querySelectorAll<T>(selector)];
}

function one<T extends HTMLElement = HTMLElement>(
  h: Harness,
  selector: string,
): T {
  const found = h.root.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

function byText(h: Harness, selector: string, text: string): HTMLElement {
  const found = all(h, selector).find((el) => el.textContent?.trim() === text);
  if (!found) throw new Error(`no ${selector} reads «${text}»`);
  return found;
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

const rules = (h: Harness): HTMLElement[] => all(h, '.sched-rule');
const tab = (h: Harness, label: string): HTMLElement =>
  byText(h, '[role="tab"]', label);
const preset = (h: Harness, label: string): HTMLElement =>
  byText(h, '.sched-at .sched-chip', label);
const pressedDays = (scope: HTMLElement): string[] =>
  [...scope.querySelectorAll('.sched-day[aria-pressed="true"]')].map(
    (c) => c.textContent ?? '',
  );

function setEvery(h: Harness, value: string): void {
  const input = one<HTMLInputElement>(h, '.sched-every-n');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('renderer/schedule/schedule-editor.ts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('A una hora', () => {
    it('shows one row per rule with its time field and days', () => {
      const h = harness({
        rules: [
          { time: '08:00', days: [1, 2, 3, 4, 5] },
          { time: '18:30', days: [5] },
        ],
        interval: null,
      });
      expect(tab(h, 'A una hora').getAttribute('aria-selected')).toBe('true');
      expect(one(h, '.sched-every').hidden).toBe(true);
      expect(rules(h)).toHaveLength(2);
      expect(
        rules(h).map((r) =>
          r.querySelector('.sched-time')?.getAttribute('aria-label'),
        ),
      ).toEqual(['Hora: 08:00', 'Hora: 18:30']);
      expect(pressedDays(rules(h)[1])).toEqual(['V']);
    });

    it('starts a schedule without rules from the default rule', () => {
      const h = harness({ rules: [], interval: null });
      expect(h.editor.value()).toEqual({
        rules: [{ time: '09:00', days: [] }],
        interval: null,
      });
    });

    it('edits a rule time from the keyboard', () => {
      const h = harness();
      const time = one(h, '.sched-time');
      key(time, '0');
      key(time, '7');
      key(time, '3');
      key(time, '0');
      expect(h.changes.at(-1)).toEqual({
        rules: [{ time: '07:30', days: [1, 2, 3, 4, 5] }],
        interval: null,
      });
      expect(h.domChanges).toBeGreaterThan(0);
    });

    it('toggles days and adds and removes rules', () => {
      const h = harness();
      byText(h, '.sched-rule .sched-day', 'S').click();
      expect(h.editor.value().rules[0]?.days).toEqual([1, 2, 3, 4, 5, 6]);
      one(h, '.sched-add').click();
      expect(rules(h)).toHaveLength(2);
      expect(h.editor.value().rules[1]).toEqual({ time: '09:00', days: [] });
      rules(h)[0]
        ?.querySelector<HTMLButtonElement>('[aria-label="Quitar horario"]')
        ?.click();
      expect(h.editor.value().rules).toEqual([{ time: '09:00', days: [] }]);
    });

    it('applies a preset to the last rule and highlights the match', () => {
      const h = harness();
      expect(preset(h, 'Laborables').getAttribute('aria-pressed')).toBe('true');
      one(h, '.sched-add').click();
      expect(preset(h, 'Todos').getAttribute('aria-pressed')).toBe('true');
      preset(h, 'Fin de semana').click();
      expect(h.editor.value().rules.map((r) => r.days)).toEqual([
        [1, 2, 3, 4, 5],
        [0, 6],
      ]);
      expect(pressedDays(rules(h)[1])).toEqual(['S', 'D']);
      expect(preset(h, 'Fin de semana').getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    it('applies a preset to the rule that last had the focus', () => {
      const h = harness({
        rules: [
          { time: '08:00', days: [1] },
          { time: '18:30', days: [5] },
        ],
        interval: null,
      });
      rules(h)[0]?.querySelector<HTMLElement>('.sched-time')?.focus();
      expect(preset(h, 'Laborables').getAttribute('aria-pressed')).toBe(
        'false',
      );
      preset(h, 'Laborables').click();
      expect(h.editor.value().rules.map((r) => r.days)).toEqual([
        [1, 2, 3, 4, 5],
        [5],
      ]);
    });

    it('keeps one time popover open at a time and closes it from outside', () => {
      const h = harness({
        rules: [
          { time: '08:00', days: [] },
          { time: '18:30', days: [] },
        ],
        interval: null,
      });
      const [first, second] = all(h, '.sched-time');
      first?.click();
      second?.click();
      expect(all(h, '.sched-time-pop')).toHaveLength(1);
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      expect(all(h, '.sched-time-pop')).toHaveLength(0);
    });
  });

  describe('Cada…', () => {
    const EVERY_15: ScheduleValue = {
      rules: [],
      interval: {
        every: 15,
        unit: 'minutes',
        window: { from: '09:00', to: '18:00' },
        days: [1, 2, 3, 4, 5],
      },
    };

    it('opens on the interval with its number, unit, window and days', () => {
      const h = harness(EVERY_15);
      expect(tab(h, 'Cada…').getAttribute('aria-selected')).toBe('true');
      expect(one(h, '.sched-at').hidden).toBe(true);
      expect(one<HTMLInputElement>(h, '.sched-every-n').value).toBe('15');
      expect(one<HTMLSelectElement>(h, '.sched-unit').value).toBe('minutes');
      expect(one<HTMLInputElement>(h, '.sched-window-on').checked).toBe(true);
      expect(
        all(h, '.sched-every .sched-time').map((t) =>
          t.getAttribute('aria-label'),
        ),
      ).toEqual(['Desde: 09:00', 'Hasta: 18:00']);
      expect(pressedDays(one(h, '.sched-every'))).toEqual([
        'L',
        'M',
        'X',
        'J',
        'V',
      ]);
      expect(
        byText(h, '.sched-quick .sched-chip', '15 min').getAttribute(
          'aria-pressed',
        ),
      ).toBe('true');
    });

    it('edits the number and the unit, with quick chips', () => {
      const h = harness(EVERY_15);
      setEvery(h, '2');
      const unit = one<HTMLSelectElement>(h, '.sched-unit');
      unit.value = 'hours';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
      expect(h.changes.at(-1)?.interval).toMatchObject({
        every: 2,
        unit: 'hours',
      });
      byText(h, '.sched-quick .sched-chip', '30 min').click();
      expect(h.changes.at(-1)?.interval).toMatchObject({
        every: 30,
        unit: 'minutes',
      });
      expect(one<HTMLInputElement>(h, '.sched-every-n').value).toBe('30');
    });

    it('refuses an interval under one, inline, and keeps the last good one', () => {
      const h = harness(EVERY_15);
      setEvery(h, '0');
      const input = one<HTMLInputElement>(h, '.sched-every-n');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(one(h, '.sched-every-error').hidden).toBe(false);
      expect(one(h, '.sched-every-error').textContent).toBe('Mínimo 1');
      expect(h.editor.value().interval?.every).toBe(15);
      setEvery(h, '20');
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(one(h, '.sched-every-error').hidden).toBe(true);
      expect(h.editor.value().interval?.every).toBe(20);
    });

    it('turns the window off and back on, keeping its hours', () => {
      const h = harness(EVERY_15);
      const toggle = one<HTMLInputElement>(h, '.sched-window-on');
      toggle.click();
      expect(h.editor.value().interval?.window).toBeNull();
      toggle.click();
      expect(h.editor.value().interval?.window).toEqual({
        from: '09:00',
        to: '18:00',
      });
    });

    it('reads an equal start and end as the whole day', () => {
      const h = harness({
        rules: [],
        interval: {
          every: 1,
          unit: 'hours',
          window: { from: '09:00', to: '09:00' },
          days: [],
        },
      });
      expect(one(h, '.sched-window-hint').hidden).toBe(false);
      expect(one(h, '.sched-window-hint').textContent).toBe('Todo el día');
    });

    it('edits the interval days through its own presets', () => {
      const h = harness(EVERY_15);
      byText(h, '.sched-every .sched-chip', 'Fin de semana').click();
      expect(h.editor.value().interval?.days).toEqual([0, 6]);
      byText(h, '.sched-every .sched-day', 'L').click();
      expect(h.editor.value().interval?.days).toEqual([0, 1, 6]);
    });
  });

  describe('mode switch', () => {
    it('keeps the other mode in memory until it is saved', () => {
      const h = harness();
      byText(h, '.sched-rule .sched-day', 'S').click();
      tab(h, 'Cada…').click();
      expect(h.changes.at(-1)).toEqual({
        rules: [],
        interval: { every: 1, unit: 'hours', window: null, days: [] },
      });
      setEvery(h, '3');
      tab(h, 'A una hora').click();
      expect(h.changes.at(-1)).toEqual({
        rules: [{ time: '08:00', days: [1, 2, 3, 4, 5, 6] }],
        interval: null,
      });
      tab(h, 'Cada…').click();
      expect(h.editor.value().interval?.every).toBe(3);
    });

    it('moves between the tabs with the arrows', () => {
      const h = harness();
      key(tab(h, 'A una hora'), 'ArrowRight');
      expect(tab(h, 'Cada…').getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab(h, 'Cada…'));
    });
  });

  describe('summary', () => {
    it('says it in a sentence with the next three runs', () => {
      const h = harness({
        rules: [],
        interval: {
          every: 15,
          unit: 'minutes',
          window: { from: '09:00', to: '18:00' },
          days: [1, 2, 3, 4, 5],
        },
      });
      expect(one(h, '.sched-sentence').textContent).toBe(
        'Se ejecutará cada 15 minutos, de 9:00 a 18:00, de lunes a viernes.',
      );
      expect(all(h, '.sched-run').map((r) => r.textContent)).toEqual([
        'hoy 12:30',
        '12:45',
        '13:00',
      ]);
    });

    it('recomputes live as the schedule changes', () => {
      const h = harness();
      expect(all(h, '.sched-run').map((r) => r.textContent)).toEqual([
        'mañana 08:00',
        'miércoles 08:00',
        'jueves 08:00',
      ]);
      const time = one(h, '.sched-time');
      key(time, '1');
      key(time, '3');
      expect(one(h, '.sched-sentence').textContent).toBe(
        'Se ejecutará a las 13:00 de lunes a viernes.',
      );
      expect(all(h, '.sched-run')[0]?.textContent).toBe('hoy 13:00');
    });

    it('says so when nothing is scheduled', () => {
      const h = harness();
      one<HTMLButtonElement>(h, '[aria-label="Quitar horario"]').click();
      expect(one(h, '.sched-sentence').textContent).toBe('Sin horario.');
      expect(all(h, '.sched-run')).toHaveLength(0);
    });
  });

  it('repaints from set() without reporting', () => {
    const h = harness();
    h.editor.set({
      rules: [],
      interval: { every: 2, unit: 'days', window: null, days: [] },
    });
    expect(tab(h, 'Cada…').getAttribute('aria-selected')).toBe('true');
    expect(one<HTMLSelectElement>(h, '.sched-unit').value).toBe('days');
    expect(h.changes).toEqual([]);
  });
});
