// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createScheduleSection } from '../renderer/config/schedule-editor.js';
import type { Command, Schedule } from '../src/domain-types.js';

// 2026-01-05 is a Monday; 15:00.
const NOW = new Date(2026, 0, 5, 15, 0).getTime();

interface Harness {
  group: HTMLElement;
  enabled: HTMLInputElement;
  details: HTMLElement;
  mount: HTMLElement;
  section: ReturnType<typeof createScheduleSection>;
}

function harness(): Harness {
  document.body.innerHTML = '';
  const group = document.createElement('div');
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  const details = document.createElement('div');
  const mount = document.createElement('div');
  details.append(mount);
  group.append(enabled, details);
  document.body.append(group);
  const section = createScheduleSection(
    { group, enabled, details, mount },
    () => NOW,
  );
  return { group, enabled, details, mount, section };
}

function rows(h: Harness): HTMLElement[] {
  return [...h.mount.querySelectorAll<HTMLElement>('.sched-rule')];
}

function command(schedule: Schedule): Command {
  return { id: 'cmd-1', name: 'api', schedule } as unknown as Command;
}

describe('renderer/config/schedule-editor.ts', () => {
  describe('setup', () => {
    it('hides the whole block for a pre-script', () => {
      const h = harness();
      h.section.setup(null, true);
      expect(h.group.style.display).toBe('none');
    });

    it('offers one 09:00 row, every day, for a brand-new item', () => {
      const h = harness();
      h.section.setup(null, false);
      expect(h.group.style.display).toBe('');
      expect(h.enabled.checked).toBe(false);
      expect(rows(h)).toHaveLength(1);
      expect(h.details.style.display).toBe('none');
      expect(h.section.readSchedule()).toEqual({
        enabled: false,
        rules: [{ time: '09:00', days: [] }],
        interval: null,
      });
    });

    it('loads the stored rules and reveals the editor', () => {
      const h = harness();
      h.section.setup(
        command({
          enabled: true,
          rules: [
            { time: '09:00', days: [1, 2] },
            { time: '18:30', days: [] },
          ],
          interval: null,
        }),
        false,
      );
      expect(h.enabled.checked).toBe(true);
      expect(h.details.style.display).toBe('');
      expect(rows(h)).toHaveLength(2);
    });

    it('loads a stored interval in the «Cada…» mode', () => {
      const h = harness();
      const schedule: Schedule = {
        enabled: true,
        rules: [],
        interval: { every: 15, unit: 'minutes', window: null, days: [] },
      };
      h.section.setup(command(schedule), false);
      expect(
        h.mount.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
      ).toBe('Cada…');
      expect(h.section.readSchedule()).toEqual(schedule);
    });

    it('starts over from what the next item holds', () => {
      const h = harness();
      h.section.setup(
        command({
          enabled: true,
          rules: [],
          interval: { every: 2, unit: 'hours', window: null, days: [] },
        }),
        false,
      );
      h.section.setup(
        command({
          enabled: true,
          rules: [{ time: '07:00', days: [] }],
          interval: null,
        }),
        false,
      );
      expect(h.section.readSchedule().interval).toBeNull();
      expect(rows(h)).toHaveLength(1);
    });

    it('follows the header switch', () => {
      const h = harness();
      h.section.setup(null, false);
      h.enabled.checked = true;
      h.enabled.dispatchEvent(new Event('change'));
      expect(h.details.style.display).toBe('');
      expect(h.section.readSchedule().enabled).toBe(true);
    });
  });

  it('reads back what the editor shows', () => {
    const h = harness();
    h.section.setup(null, false);
    h.enabled.checked = true;
    const days = [...h.mount.querySelectorAll<HTMLElement>('.sched-day')];
    days[2]?.click();
    days[0]?.click();
    expect(h.section.readSchedule()).toEqual({
      enabled: true,
      rules: [{ time: '09:00', days: [1, 3] }],
      interval: null,
    });
  });
});
