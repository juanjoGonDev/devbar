import { pad } from './mcp-range-dates.js';

/**
 * One segment of the «Rango…» picker's HH : MM field
 * (mcp-range-picker.ts): a two-digit box that holds no free text. ArrowUp /
 * ArrowDown and the wheel step it, Left / Right move to the other segment and
 * digits are handed over to fill it. What the steps and digits mean is the
 * picker's: the segment only reports them.
 */

export type Part = 'hours' | 'minutes';

export const PART_MAX: Readonly<Record<Part, number>> = {
  hours: 23,
  minutes: 59,
};
const PART_NAMES: Readonly<Record<Part, string>> = {
  hours: 'Horas',
  minutes: 'Minutos',
};

export interface SegmentHandlers {
  /** One up (1) or down (-1). */
  step(by: number): void;
  digit(digit: string): void;
  move(to: Part): void;
  /** The user came into the field anew: typing starts over. */
  restart(): void;
}

export function timeSegment(
  part: Part,
  current: number,
  on: SegmentHandlers,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rp-seg';
  input.inputMode = 'numeric';
  input.maxLength = 2;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = pad(current);
  input.dataset.focusKey = `rp-${part}`;
  input.setAttribute('role', 'spinbutton');
  input.setAttribute('aria-label', PART_NAMES[part]);
  input.setAttribute('aria-valuemin', '0');
  input.setAttribute('aria-valuemax', String(PART_MAX[part]));
  input.setAttribute('aria-valuenow', String(current));
  input.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case 'Tab':
      case 'Escape':
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        event.preventDefault();
        on.step(event.key === 'ArrowUp' ? 1 : -1);
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        on.move(event.key === 'ArrowLeft' ? 'hours' : 'minutes');
        return;
    }
    // Digits only: the field never holds free text.
    event.preventDefault();
    if (/^\d$/.test(event.key)) on.digit(event.key);
  });
  input.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      on.step(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  // Pasted or composed text never sticks.
  input.addEventListener('input', () => {
    input.value = pad(current);
  });
  // A click or Tab into the field starts the typing over; the refocus a
  // rebuild makes (from nowhere: the old field is gone) keeps it.
  input.addEventListener('mousedown', () => on.restart());
  input.addEventListener('focus', (event) => {
    if (event.relatedTarget) on.restart();
  });
  return input;
}
