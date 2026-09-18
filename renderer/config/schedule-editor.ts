import type {
  Action,
  Command,
  PreScript,
  Schedule,
  ScheduleRule,
} from '../../src/domain-types.js';

/** The sub-dialog's schedule block, as the window's markup declares it. */
export interface ScheduleEditorElements {
  group: HTMLElement;
  enabled: HTMLInputElement;
  rules: HTMLElement;
  add: HTMLButtonElement;
  details: HTMLElement;
}

export interface ScheduleEditor {
  /**
   * Show + populate the schedule editor. Available for commands and actions,
   * hidden for pre-scripts (a prep step isn't a thing you run at a clock time).
   */
  setup(
    item: Command | Action | PreScript | null | undefined,
    isPreScript: boolean,
  ): void;
  /** Read all schedule-rule rows back into [{ time, days }]. */
  readRules(): ScheduleRule[];
  /** The whole block as the form submits it. */
  readSchedule(): Schedule;
}

// Monday-first display order → weekday index (Sun=0..Sat=6).
const DAY_CHIPS = [
  { label: 'L', d: 1 },
  { label: 'M', d: 2 },
  { label: 'X', d: 3 },
  { label: 'J', d: 4 },
  { label: 'V', d: 5 },
  { label: 'S', d: 6 },
  { label: 'D', d: 0 },
];

/** Render the 7 weekday chips into `container`, selecting `days`. */
function makeDayChips(container: HTMLElement, selected: number[]): void {
  const chosen = new Set(selected || []);
  container.innerHTML = '';
  for (const { label, d } of DAY_CHIPS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `day-chip${chosen.has(d) ? ' is-on' : ''}`;
    chip.textContent = label;
    chip.dataset.day = String(d);
    chip.setAttribute('aria-pressed', chosen.has(d) ? 'true' : 'false');
    chip.addEventListener('click', () => {
      const on = chip.classList.toggle('is-on');
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    container.appendChild(chip);
  }
}

/** Append one schedule-rule row (time + day chips + remove) to the editor. */
function addScheduleRuleRow(rulesEl: HTMLElement, rule: ScheduleRule): void {
  const row = document.createElement('div');
  row.className = 'schedule-rule';

  const time = document.createElement('input');
  time.type = 'time';
  time.className = 'rule-time';
  time.value = (rule && rule.time) || '09:00';
  row.appendChild(time);

  const days = document.createElement('div');
  days.className = 'day-chips rule-days';
  makeDayChips(days, (rule && rule.days) || []);
  row.appendChild(days);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small-btn danger rule-remove';
  remove.textContent = '🗑';
  remove.title = 'Quitar este horario';
  remove.addEventListener('click', () => row.remove());
  row.appendChild(remove);

  rulesEl.appendChild(row);
}

/** One-line human summary of a schedule, e.g. "09:00 LMXJV · 14:00 todos". */
export function summarizeSchedule(
  schedule: Schedule | null | undefined,
): string {
  const rules = (schedule && schedule.rules) || [];
  const name = (day: number): string =>
    ['D', 'L', 'M', 'X', 'J', 'V', 'S'][day] ?? '';
  return rules
    .map((r) => {
      const days =
        r.days && r.days.length ? r.days.map(name).join('') : 'todos';
      return `${r.time} ${days}`;
    })
    .join(' · ');
}

export function createScheduleEditor(
  els: ScheduleEditorElements,
): ScheduleEditor {
  els.add.addEventListener('click', () =>
    addScheduleRuleRow(els.rules, { time: '09:00', days: [] }),
  );

  function setup(
    item: Command | Action | PreScript | null | undefined,
    isPreScript: boolean,
  ): void {
    els.group.style.display = isPreScript ? 'none' : '';
    if (isPreScript) return;
    const sched: Schedule =
      item && 'schedule' in item
        ? item.schedule
        : { enabled: false, rules: [] };
    els.enabled.checked = sched.enabled;
    {
      els.rules.innerHTML = '';
      const rules = Array.isArray(sched.rules) ? sched.rules : [];
      // Always show at least one row so there is something to fill in.
      (rules.length ? rules : [{ time: '09:00', days: [] }]).forEach((rule) =>
        addScheduleRuleRow(els.rules, rule),
      );
    }
    const sync = () => {
      els.details.style.display = els.enabled.checked ? '' : 'none';
    };
    sync();
    els.enabled.onchange = sync;
  }

  function readRules(): ScheduleRule[] {
    return [...els.rules.querySelectorAll<HTMLElement>('.schedule-rule')].map(
      (row) => ({
        time:
          row.querySelector<HTMLInputElement>('.rule-time')?.value || '09:00',
        days: [...row.querySelectorAll<HTMLElement>('.day-chip.is-on')]
          .map((chip) => Number(chip.dataset.day))
          .sort((a, b) => a - b),
      }),
    );
  }

  function readSchedule(): Schedule {
    return { enabled: els.enabled.checked, rules: readRules() };
  }

  return { setup, readRules, readSchedule };
}
