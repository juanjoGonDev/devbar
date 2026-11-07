import { createDayPicker, createPresetChips } from './day-picker.js';
import { createTimeField, type TimeField } from './time-field.js';
import type {
  ScheduleInterval,
  ScheduleWindow,
} from '../../src/domain-types.js';

/**
 * The «Cada…» half of the schedule editor: «Cada [N] [minutos|horas|días]»,
 * quick chips, an optional «Solo entre [desde] y [hasta]» window and the
 * weekdays. An out-of-range N is flagged inline and never reported, so the
 * value read back is always the last valid one.
 */

type Unit = ScheduleInterval['unit'];

const UNITS: ReadonlyArray<[Unit, string]> = [
  ['minutes', 'minutos'],
  ['hours', 'horas'],
  ['days', 'días'],
];

/** The bounds `normalizeScheduleInterval` clamps to. */
const MAX_EVERY: Record<Unit, number> = {
  minutes: 1440,
  hours: 168,
  days: 365,
};

const QUICK: ReadonlyArray<{ label: string; every: number; unit: Unit }> = [
  { label: '5 min', every: 5, unit: 'minutes' },
  { label: '15 min', every: 15, unit: 'minutes' },
  { label: '30 min', every: 30, unit: 'minutes' },
  { label: '1 h', every: 1, unit: 'hours' },
  { label: '6 h', every: 6, unit: 'hours' },
];

const DEFAULT_WINDOW: ScheduleWindow = { from: '09:00', to: '18:00' };

export interface IntervalPanelDeps {
  onChange: (interval: ScheduleInterval) => void;
  /** A time field opened its picker: the editor closes the others. */
  onOpenField: (field: TimeField) => void;
}

export interface IntervalPanel {
  element: HTMLElement;
  value(): ScheduleInterval;
  set(interval: ScheduleInterval): void;
  fields(): TimeField[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validEvery(raw: string, unit: Unit): number | null {
  const n = Number(raw.trim());
  if (raw.trim() === '' || !Number.isInteger(n)) return null;
  return n >= 1 && n <= MAX_EVERY[unit] ? n : null;
}

export function createIntervalPanel(
  initial: ScheduleInterval,
  deps: IntervalPanelDeps,
): IntervalPanel {
  let state: ScheduleInterval = { ...initial };
  /** The window to bring back when the switch is turned on again. */
  let lastWindow: ScheduleWindow = initial.window ?? DEFAULT_WINDOW;

  const root = el('div', 'sched-every');

  const every = el('input', 'sched-every-n');
  every.type = 'number';
  every.min = '1';
  every.step = '1';
  every.inputMode = 'numeric';
  every.setAttribute('aria-label', 'Intervalo');
  const unit = el('select', 'sched-unit');
  unit.setAttribute('aria-label', 'Unidad');
  for (const [value, label] of UNITS) {
    const option = el('option', '', label);
    option.value = value;
    unit.append(option);
  }
  const error = el('div', 'sched-every-error');
  error.setAttribute('role', 'alert');
  const head = el('div', 'sched-row');
  head.append(el('span', '', 'Cada'), every, unit);

  const quick = el('div', 'sched-quick');
  quick.append(el('span', 'sched-label', 'Rápidos'));
  const quickChips = QUICK.map((choice) => {
    const chip = el('button', 'sched-chip', choice.label);
    chip.type = 'button';
    chip.addEventListener('click', () =>
      update({ every: choice.every, unit: choice.unit }),
    );
    quick.append(chip);
    return { chip, choice };
  });

  const windowOn = el('input', 'remote-switch sched-window-on');
  windowOn.type = 'checkbox';
  windowOn.setAttribute('role', 'switch');
  windowOn.setAttribute('aria-label', 'Solo entre dos horas');
  const from = createTimeField({
    value: lastWindow.from,
    label: 'Desde',
    onChange: (time) => setWindow({ ...lastWindow, from: time }),
    onOpen: deps.onOpenField,
  });
  const to = createTimeField({
    value: lastWindow.to,
    label: 'Hasta',
    onChange: (time) => setWindow({ ...lastWindow, to: time }),
    onOpen: deps.onOpenField,
  });
  const hint = el('span', 'sched-window-hint', 'Todo el día');
  const windowRow = el('div', 'sched-row sched-window');
  windowRow.append(
    windowOn,
    el('span', '', 'Solo entre'),
    from.element,
    el('span', '', 'y'),
    to.element,
    hint,
  );

  const days = createDayPicker(state.days, (next) => update({ days: next }));
  const presets = createPresetChips((next) => {
    days.set(next);
    update({ days: next });
  });
  const daysRow = el('div', 'sched-row sched-every-days');
  daysRow.append(days.element, presets.element);

  root.append(head, error, quick, el('div', 'sched-divider'), windowRow);
  root.append(daysRow);

  function setWindow(next: ScheduleWindow): void {
    lastWindow = next;
    update({ window: next });
  }

  function update(patch: Partial<ScheduleInterval>): void {
    state = { ...state, ...patch };
    paint();
    deps.onChange({ ...state });
  }

  function showError(message: string | null): void {
    every.setAttribute('aria-invalid', String(message !== null));
    error.hidden = message === null;
    error.textContent = message ?? '';
  }

  function paint(): void {
    if (validEvery(every.value, state.unit) !== state.every)
      every.value = String(state.every);
    showError(null);
    unit.value = state.unit;
    for (const { chip, choice } of quickChips)
      chip.setAttribute(
        'aria-pressed',
        String(choice.every === state.every && choice.unit === state.unit),
      );
    windowOn.checked = state.window !== null;
    windowRow.classList.toggle('is-off', state.window === null);
    hint.hidden = !(state.window && state.window.from === state.window.to);
    presets.highlight(state.days);
  }

  every.addEventListener('input', () => {
    const n = validEvery(every.value, state.unit);
    if (n === null) {
      showError(
        Number(every.value) > MAX_EVERY[state.unit]
          ? `Máximo ${MAX_EVERY[state.unit]}`
          : 'Mínimo 1',
      );
      return;
    }
    if (n !== state.every) update({ every: n });
    else showError(null);
  });
  unit.addEventListener('change', () => {
    const next = UNITS.find(([value]) => value === unit.value)?.[0];
    if (!next) return;
    update({
      unit: next,
      every: Math.min(state.every, MAX_EVERY[next]),
    });
  });
  windowOn.addEventListener('change', () =>
    update({ window: windowOn.checked ? lastWindow : null }),
  );

  paint();
  return {
    element: root,
    value: () => ({ ...state }),
    set(next) {
      state = { ...next };
      lastWindow = next.window ?? lastWindow;
      from.set(lastWindow.from);
      to.set(lastWindow.to);
      days.set(next.days);
      every.value = String(next.every);
      paint();
    },
    fields: () => [from, to],
  };
}
