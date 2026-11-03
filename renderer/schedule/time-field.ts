import { icon } from '../icon.js';

/**
 * A wall-clock time field drawn as «08 : 00» instead of a native
 * `<input type="time">` (which ignores the app's theme). Focused, it takes
 * digits into the active part, Up/Down to step it, Left/Right to switch
 * parts, Enter to open or close the picker and Escape to close it. The
 * picker is a themed
 * popover with an HORA column (00–23) and a MIN column (five-minute steps,
 * plus the current minute when it is off that grid).
 */

type Part = 'hour' | 'minute';

export interface TimeFieldOptions {
  /** `'HH:MM'`. */
  value: string;
  /** Accessible name, read as «<label>: HH:MM». */
  label: string;
  onChange: (time: string) => void;
  /** Called when the picker opens, so the owner can close any other one. */
  onOpen?: (field: TimeField) => void;
}

export interface TimeField {
  element: HTMLElement;
  value(): string;
  /** Repaints a new value without reporting it. */
  set(time: string): void;
  close(): void;
  contains(node: Node | null): boolean;
}

const LIMIT: Record<Part, number> = { hour: 24, minute: 60 };
const MINUTE_STEP = 5;

const pad = (n: number): string => String(n).padStart(2, '0');

function parse(time: string): { hour: number; minute: number } {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return {
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0,
  };
}

function minuteChoices(current: number): number[] {
  const steps = Array.from(
    { length: 60 / MINUTE_STEP },
    (_, i) => i * MINUTE_STEP,
  );
  if (!steps.includes(current)) steps.push(current);
  return steps.sort((a, b) => a - b);
}

export function createTimeField(options: TimeFieldOptions): TimeField {
  let { hour, minute } = parse(options.value);
  let active: Part = 'hour';
  /** The first digit typed into the active part, waiting for a second. */
  let pending: number | null = null;
  let pop: HTMLElement | null = null;

  const wrap = document.createElement('span');
  wrap.className = 'sched-time-wrap';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sched-time';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const hourPart = document.createElement('span');
  hourPart.className = 'sched-time-part';
  hourPart.dataset.part = 'hour';
  const minutePart = document.createElement('span');
  minutePart.className = 'sched-time-part';
  minutePart.dataset.part = 'minute';
  const colon = document.createElement('span');
  colon.className = 'sched-time-colon';
  colon.textContent = ':';
  button.append(hourPart, colon, minutePart, icon('clock'));
  wrap.append(button);

  const text = (): string => `${pad(hour)}:${pad(minute)}`;

  function paint(): void {
    hourPart.textContent = pad(hour);
    minutePart.textContent = pad(minute);
    hourPart.classList.toggle('is-active', active === 'hour');
    minutePart.classList.toggle('is-active', active === 'minute');
    button.setAttribute('aria-label', `${options.label}: ${text()}`);
    if (pop) paintPop(pop);
  }

  function commit(next: { hour?: number; minute?: number }): void {
    hour = next.hour ?? hour;
    minute = next.minute ?? minute;
    paint();
    options.onChange(text());
  }

  function setPart(part: Part, value: number): void {
    commit(part === 'hour' ? { hour: value } : { minute: value });
  }

  function typeDigit(digit: number): void {
    const max = LIMIT[active] - 1;
    const tens = Math.floor(max / 10);
    if (pending !== null && pending * 10 + digit <= max) {
      const value = pending * 10 + digit;
      const part = active;
      pending = null;
      if (part === 'hour') active = 'minute';
      setPart(part, value);
      return;
    }
    pending = null;
    const part = active;
    if (digit > tens) {
      if (part === 'hour') active = 'minute';
      setPart(part, digit);
      return;
    }
    pending = digit;
    setPart(part, digit);
  }

  function step(delta: number): void {
    pending = null;
    const limit = LIMIT[active];
    const current = active === 'hour' ? hour : minute;
    setPart(active, (current + delta + limit) % limit);
  }

  function column(part: Part, values: number[]): HTMLElement {
    const col = document.createElement('div');
    col.className = 'sched-time-col';
    col.dataset.col = part;
    const head = document.createElement('div');
    head.className = 'sched-time-head';
    head.setAttribute('aria-hidden', 'true');
    head.textContent = part === 'hour' ? 'HORA' : 'MIN';
    const list = document.createElement('div');
    list.className = 'sched-time-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', part === 'hour' ? 'Hora' : 'Minutos');
    for (const value of values) {
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.className = 'sched-time-opt';
      option.setAttribute('role', 'option');
      option.dataset.value = String(value);
      option.textContent = pad(value);
      // Keep the focus (and so the keyboard) on the field itself.
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => {
        pending = null;
        if (part === 'hour') {
          active = 'minute';
          setPart('hour', value);
        } else {
          setPart('minute', value);
          close();
        }
        button.focus({ preventScroll: true });
      });
      list.append(option);
    }
    col.append(head, list);
    return col;
  }

  function paintPop(root: HTMLElement): void {
    const minutes = root.querySelector<HTMLElement>(
      ".sched-time-col[data-col='minute']",
    );
    const values = minuteChoices(minute);
    if (
      minutes &&
      minutes.querySelectorAll('[role="option"]').length !== values.length
    )
      minutes.replaceWith(column('minute', values));
    for (const option of root.querySelectorAll<HTMLElement>(
      '[role="option"]',
    )) {
      const part = option.closest<HTMLElement>('.sched-time-col')?.dataset.col;
      const current = part === 'hour' ? hour : minute;
      const selected = Number(option.dataset.value) === current;
      option.setAttribute('aria-selected', String(selected));
      // Centre the pick in its own column, without scrolling the page.
      const list = option.parentElement;
      if (selected && list)
        list.scrollTop =
          option.offsetTop - list.offsetTop - list.clientHeight / 2 + 14;
    }
  }

  function open(): void {
    if (pop) return;
    pop = document.createElement('div');
    pop.className = 'sched-time-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Elegir ${options.label.toLowerCase()}`);
    pop.append(
      column(
        'hour',
        Array.from({ length: 24 }, (_, i) => i),
      ),
      column('minute', minuteChoices(minute)),
    );
    wrap.append(pop);
    button.setAttribute('aria-expanded', 'true');
    paintPop(pop);
    options.onOpen?.(field);
  }

  function close(): void {
    if (!pop) return;
    pop.remove();
    pop = null;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', (event) => {
    const part = (event.target as Element | null)?.closest<HTMLElement>(
      '.sched-time-part',
    )?.dataset.part;
    if (part === 'hour' || part === 'minute') {
      active = part;
      pending = null;
      paint();
    }
    if (pop) close();
    else open();
  });

  button.addEventListener('keydown', (event) => {
    let handled = true;
    if (/^\d$/.test(event.key)) typeDigit(Number(event.key));
    else if (event.key === 'ArrowUp') step(1);
    else if (event.key === 'ArrowDown') step(-1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      pending = null;
      active = event.key === 'ArrowLeft' ? 'hour' : 'minute';
      paint();
    } else if (event.key === 'Enter') {
      if (pop) close();
      else open();
    } else if (event.key === 'Escape' && pop) close();
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  });

  button.addEventListener('blur', () => {
    pending = null;
  });

  const field: TimeField = {
    element: wrap,
    value: text,
    set(time) {
      ({ hour, minute } = parse(time));
      pending = null;
      paint();
    },
    close,
    contains: (node) => node !== null && wrap.contains(node),
  };
  paint();
  return field;
}
