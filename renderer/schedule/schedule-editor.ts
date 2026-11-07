import { icon, iconButton } from '../icon.js';
import { createDayPicker, createPresetChips } from './day-picker.js';
import { createIntervalPanel } from './interval-panel.js';
import { runLabels } from './run-labels.js';
import { createTimeField, type TimeField } from './time-field.js';
import { describeSchedule, nextRuns } from '../../src/schedule-plan.js';
import type { ScheduleInterval, ScheduleRule } from '../../src/domain-types.js';

/**
 * The one schedule editor, shared by the command / action side sheet and the
 * workflow trigger popover. A «A una hora | Cada…» switch over either the
 * weekday + time rules or the interval, and a footer that says the schedule
 * in a sentence with its next three runs, recomputed on every change.
 *
 * Both halves stay in memory while the editor lives, so flipping the mode
 * and back loses nothing; only the active one is in `value()` (the other is
 * `[]` / `null`), which is what a save keeps.
 */

export interface ScheduleValue {
  rules: ScheduleRule[];
  interval: ScheduleInterval | null;
}

export interface ScheduleEditorOptions {
  value: ScheduleValue;
  /** The rule a new row (or a schedule without rules) starts from. */
  defaultRule: ScheduleRule;
  now: () => number;
  /** Every edit, as `value()` reads it then. */
  onChange?: (value: ScheduleValue) => void;
}

export interface ScheduleEditor {
  element: HTMLElement;
  value(): ScheduleValue;
  /** Repaints a new value without reporting it. */
  set(value: ScheduleValue): void;
}

type Mode = 'at' | 'every';

const DEFAULT_INTERVAL: ScheduleInterval = {
  every: 1,
  unit: 'hours',
  window: null,
  days: [],
};

const RUNS_SHOWN = 3;

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

const copyRules = (rules: readonly ScheduleRule[]): ScheduleRule[] =>
  rules.map((rule) => ({ time: rule.time, days: [...rule.days] }));

export function createScheduleEditor(
  options: ScheduleEditorOptions,
): ScheduleEditor {
  let mode: Mode = 'at';
  let rules: ScheduleRule[] = [];
  /** The rule the presets act on: the one focused last, else the last. */
  let activeRule = 0;
  let openField: TimeField | null = null;

  const root = el('div', 'sched-editor');

  // ── Mode tabs ────────────────────────────────────────────────────────
  const tabs = el('div', 'sched-seg');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Tipo de programación');
  const tabButtons = (
    [
      ['at', 'A una hora'],
      ['every', 'Cada…'],
    ] as const
  ).map(([value, label]) => {
    const button = el('button', 'sched-seg-option', label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset.mode = value;
    button.addEventListener('click', () => switchMode(value));
    tabs.append(button);
    return button;
  });
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const next: Mode = mode === 'at' ? 'every' : 'at';
    switchMode(next);
    tabButtons.find((b) => b.dataset.mode === next)?.focus();
  });

  // ── A una hora ───────────────────────────────────────────────────────
  const atPanel = el('div', 'sched-at');
  const ruleList = el('div', 'sched-rules');
  const presets = createPresetChips((days) => {
    const rule = rules[activeRule];
    if (!rule) return;
    rule.days = days;
    renderRules();
    emit();
  });
  const add = el('button', 'sched-add');
  add.type = 'button';
  add.append(icon('plus'), el('span', '', 'Añadir horario'));
  add.addEventListener('click', () => {
    rules.push({ ...options.defaultRule, days: [...options.defaultRule.days] });
    activeRule = rules.length - 1;
    renderRules();
    emit();
  });
  const atFoot = el('div', 'sched-at-foot');
  atFoot.append(presets.element, el('span', 'sched-grow'), add);
  atPanel.append(ruleList, atFoot);

  // ── Cada… ────────────────────────────────────────────────────────────
  const interval = createIntervalPanel(DEFAULT_INTERVAL, {
    onChange: () => emit(),
    onOpenField: (field) => opened(field),
  });

  // ── Summary ──────────────────────────────────────────────────────────
  const summary = el('div', 'sched-summary');
  const sentence = el('p', 'sched-sentence');
  const next = el('div', 'sched-next');
  summary.append(sentence, next);

  root.append(tabs, atPanel, interval.element, summary);

  function opened(field: TimeField): void {
    if (openField && openField !== field) openField.close();
    openField = field;
  }

  function ruleRow(rule: ScheduleRule, index: number): HTMLElement {
    const row = el('div', 'sched-rule');
    const time = createTimeField({
      value: rule.time,
      label: 'Hora',
      onChange: (value) => {
        rule.time = value;
        emit();
      },
      onOpen: opened,
    });
    const days = createDayPicker(rule.days, (value) => {
      rule.days = value;
      emit();
    });
    const remove = iconButton('x', 'Quitar horario', 'sched-remove');
    remove.addEventListener('click', () => {
      rules.splice(index, 1);
      activeRule = Math.max(0, Math.min(activeRule, rules.length - 1));
      renderRules();
      emit();
    });
    row.addEventListener('focusin', () => {
      activeRule = index;
      presets.highlight(rule.days);
    });
    row.append(time.element, days.element, el('span', 'sched-grow'), remove);
    return row;
  }

  function renderRules(): void {
    openField = null;
    ruleList.replaceChildren(...rules.map(ruleRow));
  }

  function value(): ScheduleValue {
    return mode === 'at'
      ? { rules: copyRules(rules), interval: null }
      : { rules: [], interval: interval.value() };
  }

  function paintSummary(): void {
    const current = value();
    const empty = current.interval === null && current.rules.length === 0;
    const text = describeSchedule(current);
    sentence.replaceChildren();
    if (empty) sentence.textContent = 'Sin horario.';
    else
      sentence.append(
        'Se ejecutará ',
        el('strong', '', text.charAt(0).toLowerCase() + text.slice(1)),
        '.',
      );
    const now = new Date(options.now());
    const labels = runLabels(nextRuns(current, now, RUNS_SHOWN), now);
    next.replaceChildren(el('span', 'sched-label', 'Próximas'));
    if (labels.length === 0) next.append(el('span', 'sched-none', 'Ninguna'));
    for (const label of labels) next.append(el('span', 'sched-run', label));
  }

  function paint(): void {
    for (const button of tabButtons) {
      const on = button.dataset.mode === mode;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
    }
    atPanel.hidden = mode !== 'at';
    interval.element.hidden = mode !== 'every';
    presets.highlight(rules[activeRule]?.days ?? []);
    paintSummary();
  }

  function emit(): void {
    paint();
    options.onChange?.(value());
    root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function switchMode(next: Mode): void {
    if (next === mode) return;
    openField?.close();
    mode = next;
    emit();
  }

  function set(next: ScheduleValue): void {
    mode = next.interval ? 'every' : 'at';
    rules = copyRules(
      next.rules.length > 0 ? next.rules : [options.defaultRule],
    );
    activeRule = rules.length - 1;
    if (next.interval) interval.set(next.interval);
    renderRules();
    paint();
  }

  document.addEventListener('pointerdown', (event) => {
    if (openField && !openField.contains(event.target as Node | null)) {
      openField.close();
      openField = null;
    }
  });

  set(options.value);
  return { element: root, value, set };
}
