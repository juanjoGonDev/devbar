import { AUDIT_RETENTION_MS } from '../../src/mcp-audit-labels.js';
import { icon } from '../icon.js';
import { localInput, parseLocal } from './mcp-activity-model.js';
import { PART_MAX, timeSegment, type Part } from './mcp-range-clock.js';
import {
  addDays,
  addMonths,
  endText,
  FULL_DAY,
  midnight,
  monthOf,
  monthTitle,
  moved,
  WEEKDAYS,
  weekday,
} from './mcp-range-dates.js';

/**
 * The «Rango…» picker of the «Hora» column, drawn with the app's own theme
 * (Chromium's datetime-local popup ignores it): «Desde» / «Hasta» side by
 * side — the pressed one is the end being edited — a month calendar that
 * stops at today and at the oldest day the log still keeps, and an HH : MM
 * field with «Ahora».
 *
 * The values live in the activity state (TimeFilter's `from` / `to`); every
 * change goes out through `change`, and the column menu rebuilds the picker
 * from the new state. What is only about the view — which end is edited, the
 * month on show, the day that takes Tab, the digits typed so far — lives in
 * a RangeView the open menu keeps, so it survives those rebuilds. A change of
 * view alone repaints the picker in place.
 */

type RangeEnd = 'from' | 'to';

export interface RangeValue {
  from: string;
  to: string;
}

export interface RangeView {
  editing: RangeEnd;
  /** The first day of the month on show; null follows the edited end. */
  month: number | null;
  /** The day of the grid that takes Tab (roving tabindex); null picks one. */
  cursor: number | null;
  /** Digits typed into a time segment that may still take a second one. */
  typing: { part: Part; text: string } | null;
  /** The picker on screen, so a repaint or a refocus finds the latest one. */
  root: HTMLElement | null;
}

export interface RangePickerOptions {
  value: RangeValue;
  now: number;
  view: RangeView;
  change(next: RangeValue): void;
}

export function createRangeView(): RangeView {
  return {
    editing: 'from',
    month: null,
    cursor: null,
    typing: null,
    root: null,
  };
}

const END_NAMES: Readonly<Record<RangeEnd, string>> = {
  from: 'Desde',
  to: 'Hasta',
};
const WEEKS = 6;

/** Focuses `key` inside `root`, or the grid's day that takes Tab. */
function focusIn(root: HTMLElement | null, key: string): void {
  const target = [
    ...(root?.querySelectorAll<HTMLElement>('[data-focus-key]') ?? []),
  ].find((each) => each.dataset.focusKey === key);
  if (target && !(target as HTMLButtonElement).disabled) target.focus();
  else root?.querySelector<HTMLElement>('.rp-day[tabindex="0"]')?.focus();
}

function button(className: string, focusKey: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.dataset.focusKey = focusKey;
  return el;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export function rangePicker(options: RangePickerOptions): HTMLElement {
  const { view, now } = options;
  let value: RangeValue = { ...options.value };
  const oldest = midnight(now - AUDIT_RETENTION_MS);
  const today = midnight(now);
  const clamp = (day: number): number => Math.min(today, Math.max(oldest, day));
  const at = (end: RangeEnd): number | undefined => parseLocal(value[end]);
  const dayOf = (end: RangeEnd): number | null => {
    const ms = at(end);
    return ms === undefined ? null : midnight(ms);
  };
  const shownMonth = (): number =>
    view.month ?? monthOf(at(view.editing) ?? now);

  function change(next: RangeValue): void {
    value = next;
    const mine = view.root;
    options.change(next);
    // Nobody rebuilt the picker from the new state: bring it up to date.
    if (view.root === mine) repaint();
  }

  function repaint(focusKey?: string): void {
    const old = view.root;
    const active = document.activeElement;
    const key =
      focusKey ??
      (active instanceof HTMLElement && old?.contains(active)
        ? active.dataset.focusKey
        : undefined);
    const next = build();
    old?.replaceWith(next);
    if (key !== undefined) focusIn(next, key);
  }

  function edit(end: RangeEnd): void {
    view.editing = end;
    const ms = at(end);
    view.month = ms === undefined ? null : monthOf(ms);
    view.cursor = null;
    view.typing = null;
    repaint();
  }

  /** A day for the edited end, keeping its time; crossed ends swap. */
  function pick(day: number): void {
    const end = view.editing;
    const current = at(end);
    const next = new Date(day);
    if (current === undefined) {
      if (end === 'from') next.setHours(0, 0, 0, 0);
      else next.setHours(23, 59, 0, 0);
    } else {
      const was = new Date(current);
      next.setHours(was.getHours(), was.getMinutes(), 0, 0);
    }
    let range: RangeValue = { ...value, [end]: localInput(next.getTime()) };
    const from = parseLocal(range.from);
    const to = parseLocal(range.to);
    if (from !== undefined && to !== undefined && from > to)
      range = { from: range.to, to: range.from };
    if (end === 'from') view.editing = 'to';
    view.month = monthOf(day);
    view.cursor = day;
    view.typing = null;
    change(range);
  }

  function setPart(part: Part, n: number): void {
    const next = new Date(at(view.editing) ?? now);
    if (part === 'hours') next.setHours(n);
    else next.setMinutes(n);
    change({ ...value, [view.editing]: localInput(next.getTime()) });
  }

  /** A digit typed into a segment: it fills it, and two complete it. */
  function type(part: Part, digit: string): void {
    const text = (view.typing?.part === part ? view.typing.text : '') + digit;
    const max = PART_MAX[part];
    // «3» can only be «03» as an hour: no second digit is waited for.
    const complete = text.length >= 2 || Number(text) * 10 > max;
    view.typing = complete ? null : { part, text };
    setPart(part, Math.min(max, Number(text)));
    if (complete && part === 'hours') focusIn(view.root, 'rp-minutes');
  }

  function navigate(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.day) return;
    const next = moved(Number(target.dataset.day), event.key);
    if (next === null) return;
    event.preventDefault();
    const day = clamp(next);
    view.cursor = day;
    view.month = monthOf(day);
    repaint(`rp-day:${day}`);
  }

  function ends(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'rp-ends';
    for (const end of ['from', 'to'] as const) {
      const ms = at(end);
      const el = button('rp-end', `rp-${end}`);
      el.setAttribute('aria-pressed', String(view.editing === end));
      el.setAttribute('aria-label', `${END_NAMES[end]}: ${endText(ms)}`);
      const shown = span('rp-end-v', endText(ms));
      shown.classList.toggle('is-empty', ms === undefined);
      el.append(span('rp-end-k', END_NAMES[end]), shown);
      el.addEventListener('click', () => edit(end));
      box.append(el);
    }
    return box;
  }

  function navButton(
    name: 'chevron-left' | 'chevron-right',
    label: string,
    key: string,
    disabled: boolean,
    month: number,
  ): HTMLButtonElement {
    const el = button('rp-step', key);
    el.setAttribute('aria-label', label);
    el.title = label;
    el.disabled = disabled;
    el.append(icon(name));
    el.addEventListener('click', () => {
      view.month = month;
      view.cursor = null;
      repaint();
    });
    return el;
  }

  /** The day that takes Tab: kept, the edited end's, today or the first. */
  function cursorIn(month: number): number {
    const fits = (day: number | null): day is number =>
      day !== null && monthOf(day) === month && day === clamp(day);
    const choice = [view.cursor, dayOf(view.editing), today].find(fits);
    return choice ?? clamp(month);
  }

  function dayCell(day: number, month: number, cursor: number): HTMLElement {
    const from = dayOf('from');
    const to = dayOf('to');
    const cell = document.createElement('div');
    cell.className = 'rp-cell';
    cell.setAttribute('role', 'gridcell');
    cell.classList.toggle('is-from', day === from);
    cell.classList.toggle('is-to', day === to);
    cell.classList.toggle(
      'in-range',
      from !== null && to !== null && day > from && day < to,
    );
    const chosen = from !== null && to !== null && day >= from && day <= to;
    cell.setAttribute(
      'aria-selected',
      String(chosen || day === from || day === to),
    );
    const el = button('rp-day', `rp-day:${day}`);
    el.textContent = String(new Date(day).getDate());
    el.dataset.day = String(day);
    el.setAttribute('aria-label', FULL_DAY.format(day));
    el.tabIndex = day === cursor ? 0 : -1;
    el.disabled = day !== clamp(day);
    el.classList.toggle('is-out', monthOf(day) !== month);
    if (day === today) {
      el.classList.add('is-today');
      el.setAttribute('aria-current', 'date');
    }
    el.addEventListener('click', () => pick(day));
    cell.append(el);
    return cell;
  }

  function calendar(): HTMLElement {
    const month = shownMonth();
    const title = monthTitle(month);
    const head = document.createElement('div');
    head.className = 'rp-cal-head';
    const name = span('rp-month', title);
    name.setAttribute('aria-live', 'polite');
    const nav = document.createElement('div');
    nav.className = 'rp-nav';
    nav.append(
      navButton(
        'chevron-left',
        'Mes anterior',
        'rp-prev',
        month <= monthOf(oldest),
        monthOf(addMonths(month, -1)),
      ),
      navButton(
        'chevron-right',
        'Mes siguiente',
        'rp-next',
        month >= monthOf(today),
        monthOf(addMonths(month, 1)),
      ),
    );
    head.append(name, nav);
    const grid = document.createElement('div');
    grid.className = 'rp-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', title);
    grid.classList.toggle(
      'is-span',
      dayOf('from') !== null &&
        dayOf('to') !== null &&
        dayOf('from') !== dayOf('to'),
    );
    const names = document.createElement('div');
    names.className = 'rp-week';
    names.setAttribute('role', 'row');
    for (const [letter, full] of WEEKDAYS) {
      const dow = span('rp-dow', letter);
      dow.setAttribute('role', 'columnheader');
      dow.setAttribute('aria-label', full);
      names.append(dow);
    }
    grid.append(names);
    const cursor = cursorIn(month);
    const start = addDays(month, -weekday(month));
    for (let week = 0; week < WEEKS; week++) {
      const row = document.createElement('div');
      row.className = 'rp-week';
      row.setAttribute('role', 'row');
      for (let d = 0; d < WEEKDAYS.length; d++)
        row.append(dayCell(addDays(start, week * 7 + d), month, cursor));
      grid.append(row);
    }
    grid.addEventListener('keydown', navigate);
    const box = document.createElement('div');
    box.className = 'rp-cal';
    box.append(head, grid);
    return box;
  }

  function segment(part: Part, current: number): HTMLInputElement {
    const max = PART_MAX[part];
    return timeSegment(part, current, {
      step: (by) => {
        view.typing = null;
        setPart(part, (current + by + max + 1) % (max + 1));
      },
      digit: (digit) => type(part, digit),
      move: (to) => {
        view.typing = null;
        focusIn(view.root, `rp-${to}`);
      },
      restart: () => {
        view.typing = null;
      },
    });
  }

  function clock(): HTMLElement {
    const label = view.editing === 'from' ? 'Hora de inicio' : 'Hora de fin';
    const shown = new Date(at(view.editing) ?? now);
    const field = document.createElement('span');
    field.className = 'rp-clock';
    field.setAttribute('role', 'group');
    field.setAttribute('aria-label', label);
    const colon = span('rp-colon', ':');
    colon.setAttribute('aria-hidden', 'true');
    field.append(
      segment('hours', shown.getHours()),
      colon,
      segment('minutes', shown.getMinutes()),
    );
    const nowButton = button('rp-now', 'rp-now');
    nowButton.textContent = 'Ahora';
    nowButton.addEventListener('click', () => {
      // The clock at the click: the menu may have sat open for a while.
      const ms = Date.now();
      view.month = monthOf(ms);
      view.cursor = midnight(ms);
      view.typing = null;
      change({ ...value, [view.editing]: localInput(ms) });
    });
    const row = document.createElement('div');
    row.className = 'rp-time';
    row.append(
      span('rp-time-k', label),
      field,
      span('rp-spacer', ''),
      nowButton,
    );
    return row;
  }

  function build(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'rp';
    root.append(ends(), calendar(), clock());
    view.root = root;
    return root;
  }

  return build();
}
