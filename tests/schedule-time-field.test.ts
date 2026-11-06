// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { createTimeField } from '../renderer/schedule/time-field.js';

interface Harness {
  field: ReturnType<typeof createTimeField>;
  button: HTMLButtonElement;
  changes: string[];
}

function harness(value = '08:00'): Harness {
  const changes: string[] = [];
  const field = createTimeField({
    value,
    label: 'Hora',
    onChange: (time) => changes.push(time),
  });
  document.body.append(field.element);
  const button = field.element.querySelector<HTMLButtonElement>('.sched-time');
  if (!button) throw new Error('no time button');
  return { field, button, changes };
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function popover(h: Harness): HTMLElement | null {
  return h.field.element.querySelector<HTMLElement>('.sched-time-pop');
}

function options(h: Harness, column: 'hour' | 'minute'): HTMLElement[] {
  return [
    ...(popover(h)?.querySelectorAll<HTMLElement>(
      `.sched-time-col[data-col='${column}'] [role='option']`,
    ) ?? []),
  ];
}

function optionText(h: Harness, column: 'hour' | 'minute'): string[] {
  return options(h, column).map((o) => o.textContent ?? '');
}

describe('renderer/schedule/time-field.ts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the hour and the minute as two parts, not a native time input', () => {
    const h = harness('08:05');
    expect(h.field.element.querySelector('input[type="time"]')).toBeNull();
    const parts = [...h.button.querySelectorAll('.sched-time-part')];
    expect(parts.map((p) => p.textContent)).toEqual(['08', '05']);
    expect(h.button.getAttribute('aria-label')).toBe('Hora: 08:05');
    expect(h.field.value()).toBe('08:05');
  });

  describe('keyboard', () => {
    it('types two digits into the hour, then moves on to the minutes', () => {
      const h = harness('08:00');
      h.button.focus();
      key(h.button, '1');
      expect(h.field.value()).toBe('01:00');
      key(h.button, '7');
      expect(h.field.value()).toBe('17:00');
      key(h.button, '4');
      key(h.button, '5');
      expect(h.field.value()).toBe('17:45');
      expect(h.changes.at(-1)).toBe('17:45');
    });

    it('jumps to the minutes after an hour digit that cannot start two', () => {
      const h = harness('08:00');
      key(h.button, '9');
      key(h.button, '3');
      expect(h.field.value()).toBe('09:03');
    });

    it('starts the hour again when the two digits would pass 23', () => {
      const h = harness('08:00');
      key(h.button, '2');
      key(h.button, '7');
      expect(h.field.value()).toBe('07:00');
    });

    it('moves the focused part up and down with the arrows, wrapping round', () => {
      const h = harness('23:59');
      key(h.button, 'ArrowUp');
      expect(h.field.value()).toBe('00:59');
      key(h.button, 'ArrowRight');
      key(h.button, 'ArrowUp');
      expect(h.field.value()).toBe('00:00');
      key(h.button, 'ArrowDown');
      expect(h.field.value()).toBe('00:59');
      key(h.button, 'ArrowLeft');
      key(h.button, 'ArrowDown');
      expect(h.field.value()).toBe('23:59');
    });

    it('marks the part the keys act on', () => {
      const h = harness();
      const active = (): string | null | undefined =>
        h.button.querySelector('.sched-time-part.is-active')?.textContent;
      expect(active()).toBe('08');
      key(h.button, 'ArrowRight');
      expect(active()).toBe('00');
    });

    it('opens the popover on Enter and closes it on Escape without letting Escape through', () => {
      const h = harness();
      const enter = key(h.button, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(popover(h)).not.toBeNull();
      expect(h.button.getAttribute('aria-expanded')).toBe('true');
      let reachedDocument = false;
      const spy = (): void => {
        reachedDocument = true;
      };
      document.addEventListener('keydown', spy);
      key(h.button, 'Escape');
      document.removeEventListener('keydown', spy);
      expect(popover(h)).toBeNull();
      expect(reachedDocument).toBe(false);
      expect(h.button.getAttribute('aria-expanded')).toBe('false');
    });

    it('lets Escape through when the popover is closed', () => {
      const h = harness();
      let reachedDocument = false;
      const spy = (): void => {
        reachedDocument = true;
      };
      document.addEventListener('keydown', spy);
      key(h.button, 'Escape');
      document.removeEventListener('keydown', spy);
      expect(reachedDocument).toBe(true);
    });

    it('closes an open popover on Enter', () => {
      const h = harness();
      key(h.button, 'Enter');
      key(h.button, 'Enter');
      expect(popover(h)).toBeNull();
    });
  });

  describe('popover', () => {
    it('lists every hour and the minutes in five-minute steps', () => {
      const h = harness('08:00');
      h.button.click();
      expect(optionText(h, 'hour')).toHaveLength(24);
      expect(optionText(h, 'hour')[0]).toBe('00');
      expect(optionText(h, 'minute')).toEqual([
        '00',
        '05',
        '10',
        '15',
        '20',
        '25',
        '30',
        '35',
        '40',
        '45',
        '50',
        '55',
      ]);
    });

    it('keeps a typed minute off the five-minute grid in the list', () => {
      const h = harness('08:07');
      h.button.click();
      expect(optionText(h, 'minute').slice(0, 3)).toEqual(['00', '05', '07']);
    });

    it('selects the current hour and minute', () => {
      const h = harness('08:30');
      h.button.click();
      const selected = (column: 'hour' | 'minute'): string[] =>
        options(h, column)
          .filter((o) => o.getAttribute('aria-selected') === 'true')
          .map((o) => o.textContent ?? '');
      expect(selected('hour')).toEqual(['08']);
      expect(selected('minute')).toEqual(['30']);
    });

    it('picks an hour, then a minute, and closes', () => {
      const h = harness('08:00');
      h.button.click();
      options(h, 'hour')
        .find((o) => o.textContent === '18')
        ?.click();
      expect(h.field.value()).toBe('18:00');
      expect(popover(h)).not.toBeNull();
      options(h, 'minute')
        .find((o) => o.textContent === '45')
        ?.click();
      expect(h.field.value()).toBe('18:45');
      expect(h.changes).toEqual(['18:00', '18:45']);
      expect(popover(h)).toBeNull();
    });

    it('closes from the outside through close()', () => {
      const h = harness();
      h.button.click();
      expect(h.field.contains(popover(h))).toBe(true);
      h.field.close();
      expect(popover(h)).toBeNull();
    });

    it('tells the owner when it opens', () => {
      const opened: string[] = [];
      const field = createTimeField({
        value: '10:00',
        label: 'Desde',
        onChange: () => undefined,
        onOpen: () => opened.push('yes'),
      });
      document.body.append(field.element);
      field.element.querySelector<HTMLButtonElement>('.sched-time')?.click();
      expect(opened).toEqual(['yes']);
    });
  });

  it('repaints from set() without reporting a change', () => {
    const h = harness('08:00');
    h.field.set('21:15');
    expect(h.field.value()).toBe('21:15');
    expect(h.button.getAttribute('aria-label')).toBe('Hora: 21:15');
    expect(h.changes).toEqual([]);
  });
});
