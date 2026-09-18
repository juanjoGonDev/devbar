// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  createScheduleEditor,
  summarizeSchedule,
} from '../renderer/config/schedule-editor.js';
import type { Command, Schedule } from '../src/domain-types.js';

interface Harness {
  group: HTMLElement;
  enabled: HTMLInputElement;
  rules: HTMLElement;
  add: HTMLButtonElement;
  details: HTMLElement;
  editor: ReturnType<typeof createScheduleEditor>;
}

function harness(): Harness {
  document.body.innerHTML = '';
  const group = document.createElement('div');
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  const rules = document.createElement('div');
  const add = document.createElement('button');
  const details = document.createElement('div');
  for (const el of [group, enabled, rules, add, details])
    document.body.appendChild(el);
  const editor = createScheduleEditor({ group, enabled, rules, add, details });
  return { group, enabled, rules, add, details, editor };
}

function ruleRows(h: Harness): HTMLElement[] {
  return [...h.rules.querySelectorAll<HTMLElement>('.schedule-rule')];
}

function chips(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('.day-chip')];
}

function command(schedule: Schedule): Command {
  return {
    id: 'cmd-1',
    name: 'api',
    icon: null,
    command: 'npm',
    args: [],
    env: [],
    cwd: null,
    warnRegex: '',
    errorRegex: '',
    silenceWarnings: false,
    silenceErrors: false,
    maxLogLines: null,
    autoStart: false,
    order: 0,
    schedule,
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    silencedPatterns: { warn: [], error: [] },
  } as unknown as Command;
}

describe('renderer/config/schedule-editor.ts', () => {
  describe('summarizeSchedule', () => {
    it('is empty for a missing schedule', () => {
      expect(summarizeSchedule(null)).toBe('');
      expect(summarizeSchedule(undefined)).toBe('');
    });

    it('names the selected weekdays', () => {
      expect(
        summarizeSchedule({
          enabled: true,
          rules: [{ time: '09:00', days: [1, 5] }],
        }),
      ).toBe('09:00 LV');
    });

    it('says "todos" when a rule selects no weekday', () => {
      expect(
        summarizeSchedule({
          enabled: true,
          rules: [{ time: '14:00', days: [] }],
        }),
      ).toBe('14:00 todos');
    });

    it('joins several rules with a middle dot', () => {
      expect(
        summarizeSchedule({
          enabled: true,
          rules: [
            { time: '09:00', days: [1] },
            { time: '14:00', days: [] },
          ],
        }),
      ).toBe('09:00 L · 14:00 todos');
    });

    it('drops a weekday index outside 0..6', () => {
      expect(
        summarizeSchedule({
          enabled: true,
          rules: [{ time: '09:00', days: [9] }],
        }),
      ).toBe('09:00 ');
    });
  });

  describe('setup', () => {
    it('hides the whole block for a pre-script', () => {
      const h = harness();
      h.editor.setup(null, true);
      expect(h.group.style.display).toBe('none');
      expect(ruleRows(h)).toHaveLength(0);
    });

    it('offers one empty row for a brand-new item', () => {
      const h = harness();
      h.editor.setup(null, false);
      expect(h.group.style.display).toBe('');
      expect(h.enabled.checked).toBe(false);
      expect(ruleRows(h)).toHaveLength(1);
      expect(h.details.style.display).toBe('none');
    });

    it('renders one row per stored rule and reveals the details', () => {
      const h = harness();
      h.editor.setup(
        command({
          enabled: true,
          rules: [
            { time: '09:00', days: [1, 2] },
            { time: '18:30', days: [] },
          ],
        }),
        false,
      );
      expect(h.enabled.checked).toBe(true);
      expect(h.details.style.display).toBe('');
      expect(ruleRows(h)).toHaveLength(2);
      expect(
        chips(ruleRows(h)[0]).filter((c) => c.classList.contains('is-on'))
          .length,
      ).toBe(2);
    });

    it('falls back to one empty row when rules is not an array', () => {
      const h = harness();
      h.editor.setup(
        command({ enabled: true, rules: null } as unknown as Schedule),
        false,
      );
      expect(ruleRows(h)).toHaveLength(1);
    });

    it('falls back to 09:00 and no days for a blank rule', () => {
      const h = harness();
      h.editor.setup(
        command({
          enabled: true,
          rules: [{ time: '', days: null }] as unknown as Schedule['rules'],
        }),
        false,
      );
      const time = ruleRows(h)[0].querySelector<HTMLInputElement>('.rule-time');
      expect(time?.value).toBe('09:00');
      expect(
        chips(ruleRows(h)[0]).some((c) => c.classList.contains('is-on')),
      ).toBe(false);
    });

    it('follows the enabled toggle after setup', () => {
      const h = harness();
      h.editor.setup(null, false);
      h.enabled.checked = true;
      h.enabled.dispatchEvent(new Event('change'));
      expect(h.details.style.display).toBe('');
    });
  });

  describe('editing rows', () => {
    it('appends an empty row from the add button', () => {
      const h = harness();
      h.editor.setup(null, false);
      h.add.click();
      expect(ruleRows(h)).toHaveLength(2);
    });

    it('removes the row its own bin button belongs to', () => {
      const h = harness();
      h.editor.setup(null, false);
      h.add.click();
      ruleRows(h)[0].querySelector<HTMLButtonElement>('.rule-remove')?.click();
      expect(ruleRows(h)).toHaveLength(1);
    });

    it('toggles a weekday chip and its aria-pressed state', () => {
      const h = harness();
      h.editor.setup(null, false);
      const monday = chips(ruleRows(h)[0])[0];
      monday.click();
      expect(monday.classList.contains('is-on')).toBe(true);
      expect(monday.getAttribute('aria-pressed')).toBe('true');
      monday.click();
      expect(monday.getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('readSchedule', () => {
    it('reads the toggle and every row back, weekdays sorted', () => {
      const h = harness();
      h.editor.setup(null, false);
      h.enabled.checked = true;
      const row = ruleRows(h)[0];
      row.querySelector<HTMLInputElement>('.rule-time')!.value = '07:45';
      const [monday, , wednesday] = chips(row);
      wednesday.click();
      monday.click();
      expect(h.editor.readSchedule()).toEqual({
        enabled: true,
        rules: [{ time: '07:45', days: [1, 3] }],
      });
    });

    it('falls back to 09:00 for a row whose time field is gone', () => {
      const h = harness();
      h.editor.setup(null, false);
      ruleRows(h)[0].querySelector('.rule-time')?.remove();
      expect(h.editor.readSchedule().rules).toEqual([
        { time: '09:00', days: [] },
      ]);
    });
  });
});
