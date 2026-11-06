// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditEntry, click } from './helpers/mcp.js';
import {
  auditPage,
  funnel,
  lastQuery,
  menu,
  menuButton,
  openActivity,
  openMenu,
  summaryDetails,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import {
  createRangeView,
  rangePicker,
  type RangeValue,
  type RangeView,
} from '../renderer/config/mcp-range-picker.js';

/**
 * The themed «Rango…» picker of the «Hora» column
 * (renderer/config/mcp-range-picker.ts): the ends, the month calendar and its
 * bounds, picking days, the HH : MM field, «Ahora», the keyboard in the grid,
 * and — through the real window — the filter and summary it drives.
 */

/** Friday 6 November 2026, 09:00 local; the log keeps back to 7 October. */
const NOW = new Date(2026, 10, 6, 9, 0).getTime();
const HOUR = 60 * 60 * 1000;

interface Harness {
  view: RangeView;
  changes: RangeValue[];
  root(): HTMLElement;
}

/**
 * The picker mounted on its own. With `rebuild` the host builds a new one
 * from every change and gives the focus back by key, the way the column menu
 * does; without it the picker has to repaint itself.
 */
function mount(value: RangeValue, rebuild = true): Harness {
  const view = createRangeView();
  const changes: RangeValue[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const render = (current: RangeValue): void => {
    const active = document.activeElement;
    const key =
      active instanceof HTMLElement && host.contains(active)
        ? active.dataset.focusKey
        : undefined;
    host.replaceChildren(
      rangePicker({ value: current, now: NOW, view, change }),
    );
    if (key !== undefined) byKey(key)?.focus();
  };
  function change(next: RangeValue): void {
    changes.push(next);
    if (rebuild) render(next);
  }
  render(value);
  return {
    view,
    changes,
    root: () => {
      if (!view.root) throw new Error('no picker');
      return view.root;
    },
  };
}

function byKey(key: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
    (each) => each.dataset.focusKey === key,
  );
}

function day(month: number, date: number): HTMLButtonElement {
  const ms = new Date(2026, month, date).getTime();
  const found = document.querySelector<HTMLButtonElement>(
    `.rp-day[data-day="${ms}"]`,
  );
  if (!found) throw new Error(`no day ${date}/${month + 1}`);
  return found;
}

const NOV = 10;
const OCT = 9;
const monthTitle = (): string =>
  document.querySelector('.rp-month')?.textContent ?? '';
const step = (label: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.rp-step[aria-label="${label}"]`)!;
const end = (name: 'from' | 'to'): HTMLButtonElement =>
  byKey(`rp-${name}`) as HTMLButtonElement;
const segment = (part: 'hours' | 'minutes'): HTMLInputElement =>
  byKey(`rp-${part}`) as HTMLInputElement;
const focusKey = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.dataset.focusKey;
const cellOf = (button: HTMLElement): HTMLElement => button.parentElement!;

function press(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function typeInto(input: HTMLInputElement, digits: string): void {
  for (const digit of digits) press(document.activeElement ?? input, digit);
}

const RANGE: RangeValue = { from: '2026-11-03T10:00', to: '2026-11-05T18:00' };
const OPEN: RangeValue = { from: '', to: '' };

describe('renderer/config/mcp-range-picker.ts', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  describe('the calendar', () => {
    it('shows the month of the edited end, weeks starting on Monday', () => {
      mount(RANGE);
      expect(monthTitle()).toBe('Noviembre de 2026');
      const names = [...document.querySelectorAll('.rp-dow')];
      expect(names.map((n) => n.textContent)).toEqual([
        'L',
        'M',
        'X',
        'J',
        'V',
        'S',
        'D',
      ]);
      expect(names[2]?.getAttribute('aria-label')).toBe('miércoles');
      const days = [...document.querySelectorAll<HTMLElement>('.rp-day')];
      expect(days).toHaveLength(42);
      // 1 Nov 2026 is a Sunday: the grid opens on Monday 26 October.
      expect(days[0]?.textContent).toBe('26');
      expect(days[0]?.classList.contains('is-out')).toBe(true);
      expect(day(NOV, 1).classList.contains('is-out')).toBe(false);
      expect(day(NOV, 6).getAttribute('aria-label')).toBe(
        'viernes, 6 de noviembre de 2026',
      );
      expect(document.querySelectorAll('.rp-week[role="row"]')).toHaveLength(7);
    });

    it('rings today and disables the future', () => {
      mount(RANGE);
      expect(day(NOV, 6).classList.contains('is-today')).toBe(true);
      expect(day(NOV, 6).getAttribute('aria-current')).toBe('date');
      expect(document.querySelectorAll('.rp-day.is-today')).toHaveLength(1);
      expect(day(NOV, 6).disabled).toBe(false);
      expect(day(NOV, 7).disabled).toBe(true);
      expect(step('Mes siguiente').disabled).toBe(true);
    });

    it('stops at the oldest day the log keeps', () => {
      mount(RANGE);
      click(step('Mes anterior'));
      expect(monthTitle()).toBe('Octubre de 2026');
      expect(day(OCT, 7).disabled).toBe(false);
      expect(day(OCT, 6).disabled).toBe(true);
      expect(step('Mes anterior').disabled).toBe(true);
      click(step('Mes siguiente'));
      expect(monthTitle()).toBe('Noviembre de 2026');
    });

    it('marks the ends and the days between them', () => {
      mount(RANGE);
      const grid = document.querySelector('.rp-grid')!;
      expect(grid.getAttribute('role')).toBe('grid');
      expect(grid.classList.contains('is-span')).toBe(true);
      expect(cellOf(day(NOV, 3)).classList.contains('is-from')).toBe(true);
      expect(cellOf(day(NOV, 4)).classList.contains('in-range')).toBe(true);
      expect(cellOf(day(NOV, 5)).classList.contains('is-to')).toBe(true);
      expect(cellOf(day(NOV, 2)).className).toBe('rp-cell');
      expect(cellOf(day(NOV, 4)).getAttribute('aria-selected')).toBe('true');
      expect(cellOf(day(NOV, 6)).getAttribute('aria-selected')).toBe('false');
    });

    it('draws no band for one day or an open end', () => {
      mount({ from: '2026-11-03T08:00', to: '2026-11-03T18:00' });
      expect(document.querySelector('.rp-grid.is-span')).toBeNull();
      expect(cellOf(day(NOV, 3)).classList.contains('is-from')).toBe(true);
      expect(cellOf(day(NOV, 3)).classList.contains('is-to')).toBe(true);
      document.body.replaceChildren();
      mount({ from: '2026-11-03T08:00', to: '' });
      expect(document.querySelector('.rp-grid.is-span')).toBeNull();
      expect(document.querySelectorAll('.rp-cell.in-range')).toHaveLength(0);
    });
  });

  describe('the ends', () => {
    it('reads each end, «Desde» edited first', () => {
      mount(RANGE);
      expect(end('from').getAttribute('aria-pressed')).toBe('true');
      expect(end('to').getAttribute('aria-pressed')).toBe('false');
      expect(end('from').querySelector('.rp-end-v')?.textContent).toBe(
        '3 nov · 10:00',
      );
      expect(end('to').getAttribute('aria-label')).toBe('Hasta: 5 nov · 18:00');
      expect(document.querySelector('.rp-time-k')?.textContent).toBe(
        'Hora de inicio',
      );
    });

    it('reads an open end as «Sin límite»', () => {
      mount({ from: '2026-11-03T10:00', to: '' });
      const shown = end('to').querySelector('.rp-end-v')!;
      expect(shown.textContent).toBe('Sin límite');
      expect(shown.classList.contains('is-empty')).toBe(true);
    });

    it('edits the end clicked, showing its month and time', () => {
      mount({ from: '2026-10-20T07:15', to: '2026-11-05T18:40' }, false);
      expect(monthTitle()).toBe('Octubre de 2026');
      end('to').focus();
      click(end('to'));
      expect(end('to').getAttribute('aria-pressed')).toBe('true');
      expect(focusKey()).toBe('rp-to');
      expect(monthTitle()).toBe('Noviembre de 2026');
      expect(document.querySelector('.rp-time-k')?.textContent).toBe(
        'Hora de fin',
      );
      expect([segment('hours').value, segment('minutes').value]).toEqual([
        '18',
        '40',
      ]);
    });
  });

  describe('picking a day', () => {
    it('starts a new «Desde» at 00:00 and moves on to «Hasta»', () => {
      const h = mount(OPEN);
      click(day(NOV, 2));
      expect(h.changes.at(-1)).toEqual({ from: '2026-11-02T00:00', to: '' });
      expect(h.view.editing).toBe('to');
      expect(end('to').getAttribute('aria-pressed')).toBe('true');
    });

    it('ends a new «Hasta» at 23:59', () => {
      const h = mount(OPEN);
      click(day(NOV, 2));
      click(day(NOV, 4));
      expect(h.changes.at(-1)).toEqual({
        from: '2026-11-02T00:00',
        to: '2026-11-04T23:59',
      });
      expect(h.view.editing).toBe('to');
    });

    it('keeps the time the end already had', () => {
      const h = mount(RANGE);
      click(day(NOV, 4));
      expect(h.changes.at(-1)).toEqual({ ...RANGE, from: '2026-11-04T10:00' });
    });

    it('swaps the ends when they cross', () => {
      const h = mount(RANGE);
      click(end('to'));
      click(day(NOV, 1));
      expect(h.changes.at(-1)).toEqual({
        from: '2026-11-01T18:00',
        to: '2026-11-03T10:00',
      });
    });

    it('jumps to the month of a day of the next or last one', () => {
      mount(RANGE);
      click(day(OCT, 30));
      expect(monthTitle()).toBe('Octubre de 2026');
      expect(cellOf(day(OCT, 30)).classList.contains('is-from')).toBe(true);
    });

    it('repaints itself when the host does not rebuild it', () => {
      const h = mount(OPEN, false);
      click(day(NOV, 2));
      expect(h.changes).toHaveLength(1);
      expect(end('from').querySelector('.rp-end-v')?.textContent).toBe(
        '2 nov · 00:00',
      );
      expect(document.querySelectorAll('.rp')).toHaveLength(1);
    });
  });

  describe('the time', () => {
    it('steps with the arrows and wraps around', () => {
      const h = mount({ from: '2026-11-03T23:00', to: '' });
      segment('hours').focus();
      expect(press(segment('hours'), 'ArrowUp').defaultPrevented).toBe(true);
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T00:00');
      expect(focusKey()).toBe('rp-hours');
      press(segment('minutes'), 'ArrowDown');
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T00:59');
      expect(segment('minutes').getAttribute('aria-valuenow')).toBe('59');
    });

    it('steps with the wheel', () => {
      const h = mount(RANGE);
      const wheel = (deltaY: number): WheelEvent => {
        const event = new WheelEvent('wheel', { deltaY, cancelable: true });
        segment('minutes').dispatchEvent(event);
        return event;
      };
      expect(wheel(-1).defaultPrevented).toBe(true);
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T10:01');
      wheel(1);
      wheel(1);
      // The minutes wrap on their own: the hour stays.
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T10:59');
      expect(wheel(0).defaultPrevented).toBe(false);
    });

    it('takes two typed digits, then moves on to the minutes', () => {
      const h = mount(RANGE);
      segment('hours').focus();
      typeInto(segment('hours'), '1');
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T01:00');
      expect(focusKey()).toBe('rp-hours');
      typeInto(segment('hours'), '5');
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T15:00');
      expect(focusKey()).toBe('rp-minutes');
      typeInto(segment('minutes'), '42');
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T15:42');
      expect(focusKey()).toBe('rp-minutes');
    });

    it('needs no second digit when none could follow', () => {
      const h = mount(RANGE);
      segment('hours').focus();
      typeInto(segment('hours'), '7');
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T07:00');
      expect(focusKey()).toBe('rp-minutes');
    });

    it('starts the typing over when the field is entered again', () => {
      const h = mount(RANGE);
      segment('hours').focus();
      typeInto(segment('hours'), '1');
      segment('minutes').focus();
      segment('hours').focus();
      typeInto(segment('hours'), '2');
      expect(h.changes.at(-1)?.from).toBe('2026-11-03T02:00');
    });

    it('takes no free text', () => {
      const h = mount(RANGE);
      segment('hours').focus();
      expect(press(segment('hours'), 'a').defaultPrevented).toBe(true);
      expect(press(segment('hours'), 'Tab').defaultPrevented).toBe(false);
      expect(h.changes).toHaveLength(0);
      segment('hours').value = 'xy';
      segment('hours').dispatchEvent(new Event('input'));
      expect(segment('hours').value).toBe('10');
    });

    it('moves between hours and minutes with Left and Right', () => {
      mount(RANGE);
      segment('hours').focus();
      press(segment('hours'), 'ArrowRight');
      expect(focusKey()).toBe('rp-minutes');
      press(segment('minutes'), 'ArrowLeft');
      expect(focusKey()).toBe('rp-hours');
    });

    it('sets the edited end to now with «Ahora»', () => {
      vi.useFakeTimers({ now: NOW + 5 * 60_000, toFake: ['Date'] });
      const h = mount(RANGE);
      click(end('to'));
      click(byKey('rp-now')!);
      expect(h.changes.at(-1)).toEqual({ ...RANGE, to: '2026-11-06T09:05' });
    });
  });

  describe('the keyboard in the grid', () => {
    it('gives Tab to one day: the edited end', () => {
      mount(RANGE);
      const tabbable = document.querySelectorAll('.rp-day[tabindex="0"]');
      expect([...tabbable]).toEqual([day(NOV, 3)]);
    });

    it('moves by day, week and month', () => {
      mount(RANGE);
      day(NOV, 3).focus();
      press(day(NOV, 3), 'ArrowRight');
      expect(document.activeElement).toBe(day(NOV, 4));
      expect(day(NOV, 4).tabIndex).toBe(0);
      expect(day(NOV, 3).tabIndex).toBe(-1);
      press(document.activeElement!, 'Home');
      expect(document.activeElement).toBe(day(NOV, 2));
      press(document.activeElement!, 'ArrowLeft');
      expect(document.activeElement).toBe(day(NOV, 1));
      // Sunday 1 November: its week starts in October.
      press(document.activeElement!, 'Home');
      expect(document.activeElement).toBe(day(OCT, 26));
      expect(monthTitle()).toBe('Octubre de 2026');
      press(document.activeElement!, 'End');
      expect(document.activeElement).toBe(day(NOV, 1));
      expect(monthTitle()).toBe('Noviembre de 2026');
      press(document.activeElement!, 'ArrowDown');
      // 8 November is still to come: it stops on today.
      expect(document.activeElement).toBe(day(NOV, 6));
      press(document.activeElement!, 'ArrowUp');
      expect(document.activeElement).toBe(day(OCT, 30));
      expect(monthTitle()).toBe('Octubre de 2026');
      press(document.activeElement!, 'PageDown');
      expect(document.activeElement).toBe(day(NOV, 6));
    });

    it('stays within today and the oldest day kept', () => {
      mount(RANGE);
      day(NOV, 6).focus();
      press(day(NOV, 6), 'ArrowRight');
      expect(document.activeElement).toBe(day(NOV, 6));
      press(document.activeElement!, 'PageUp');
      expect(document.activeElement).toBe(day(OCT, 7));
      press(document.activeElement!, 'ArrowLeft');
      expect(document.activeElement).toBe(day(OCT, 7));
      expect(step('Mes anterior').disabled).toBe(true);
    });

    it('leaves Enter, Space and Escape to the button and the menu', () => {
      mount(RANGE);
      day(NOV, 3).focus();
      for (const key of ['Enter', ' ', 'Escape'])
        expect(press(day(NOV, 3), key).defaultPrevented, key).toBe(false);
    });
  });
});

describe('the picker in «Actividad»', () => {
  let win: RendererWindow | null = null;
  const PAGE = auditPage([auditEntry('a1')]);

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  async function openRange(): Promise<RendererWindow> {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const opened = await openActivity(PAGE);
    click(funnel('Hora'));
    click(menuButton('Rango…'));
    await opened.settle('queryMcpAudit', PAGE);
    return opened;
  }

  it('filters by the days picked and says so in the summary', async () => {
    win = await openRange();
    day(NOV, 2).focus();
    click(day(NOV, 2));
    expect(lastQuery(win).from).toBe(new Date(2026, 10, 2, 9, 0).getTime());
    expect(openMenu()).not.toBeNull();
    expect(focusKey()).toBe(`rp-day:${new Date(2026, 10, 2).getTime()}`);
    click(day(NOV, 4));
    // «Hasta» keeps its whole minute.
    expect(lastQuery(win).to).toBe(new Date(2026, 10, 4, 9, 1).getTime() - 1);
    await win.settleNewest('queryMcpAudit', PAGE);
    expect(summaryDetails()).toEqual(['Hora: 2 nov 09:00 → 4 nov 09:00']);
    expect(menu().querySelector('.rp-end[aria-pressed="true"]')).toBe(
      end('to'),
    );
  });

  it('keeps the month and the end edited across the answer', async () => {
    win = await openRange();
    click(end('to'));
    click(step('Mes anterior'));
    expect(monthTitle()).toBe('Octubre de 2026');
    segment('hours').focus();
    press(segment('hours'), 'ArrowUp');
    await win.settle('queryMcpAudit', PAGE);
    expect(lastQuery(win).to).toBe(NOW + HOUR + 60_000 - 1);
    expect(end('to').getAttribute('aria-pressed')).toBe('true');
    expect(monthTitle()).toBe('Octubre de 2026');
    expect(focusKey()).toBe('rp-hours');
    expect(summaryDetails()).toEqual(['Hora: 5 nov 09:00 → 6 nov 10:00']);
  });

  it('still closes the whole menu on Escape', async () => {
    win = await openRange();
    day(NOV, 5).focus();
    press(day(NOV, 5), 'Escape');
    expect(openMenu()).toBeNull();
    expect(document.activeElement).toBe(funnel('Hora'));
  });
});
