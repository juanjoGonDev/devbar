// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, scrolledIntoView } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';

/**
 * `renderer/logs/activity.ts` draws the activity strip under the toolbar: one
 * bar per bucket of the lines the view shows, kept up to date as lines stream
 * in, and a way to jump to any stretch of the log.
 */
type ActivityModule = typeof import('../renderer/logs/activity.js');
type PaneModule = typeof import('../renderer/logs/pane.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

const MINUTE = 60_000;
const BASE = new Date(2026, 9, 20, 13, 0).getTime();

/** One line per minute for `minutes` minutes. */
function minutes(count: number, extra: Partial<LogEntry> = {}): LogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry(`line ${i}`, { ts: BASE + i * MINUTE, ...extra }),
  );
}

describe('renderer/logs/activity.ts', () => {
  let activity: ActivityModule;
  let pane: PaneModule;
  let elements: ElementsModule;
  let view: ViewModule;

  async function load(): Promise<void> {
    activity = await import('../renderer/logs/activity.js');
    pane = await import('../renderer/logs/pane.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    mountLogsDom();
    await load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function bars(): HTMLElement[] {
    return Array.from(
      elements.activityBarsEl.querySelectorAll<HTMLElement>('.activity-bar'),
    );
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(
      elements.activityBarsEl.querySelectorAll<HTMLButtonElement>('button'),
    );
  }

  it('stays hidden while the scope holds less than two buckets of lines', () => {
    pane.resetBuffer([entry('only', { ts: BASE })]);
    activity.paintActivity();
    expect(elements.activityEl.hidden).toBe(true);
  });

  it('draws a bar per bucket, with the span it covers and a summary', () => {
    pane.resetBuffer(minutes(35));
    activity.paintActivity();
    expect(elements.activityEl.hidden).toBe(false);
    expect(bars()).toHaveLength(35);
    expect(elements.activitySpanEl.textContent).toBe('últimos 35 min');
    expect(elements.activityEl.getAttribute('aria-label')).toBe(
      'Actividad: 35 líneas, últimos 35 min',
    );
    expect(buttons()[0]?.getAttribute('aria-label')).toBe(
      '13:00–13:01 · 1 línea',
    );
  });

  it('marks the bucket on screen — the last one while following', () => {
    pane.resetBuffer(minutes(35));
    activity.paintActivity();
    const current = bars().filter((bar) => bar.classList.contains('current'));
    expect(current).toEqual([bars().at(-1)]);
  });

  it('counts only what the filters leave on screen', () => {
    pane.resetBuffer([
      ...minutes(35),
      entry('boom', { ts: BASE + 5 * MINUTE, level: 'error' }),
      entry('boom', { ts: BASE + 20 * MINUTE, level: 'error' }),
    ]);
    pane.setLevelFilter(['error']);
    activity.paintActivity();
    const busy = bars().filter((bar) => bar.tagName === 'BUTTON');
    expect(busy).toHaveLength(2);
    expect(busy.every((bar) => bar.classList.contains('tone-error'))).toBe(
      true,
    );
  });

  it('keeps counting lines as they stream in', () => {
    pane.resetBuffer(minutes(10));
    activity.paintActivity();
    pane.pushEntry(entry('late', { ts: BASE + 10 * MINUTE }));
    pane.pushEntry(entry('later', { ts: BASE + 11 * MINUTE, level: 'warn' }));
    activity.paintActivity();
    expect(bars().length).toBeGreaterThan(10);
    expect(bars().at(-1)?.classList.contains('tone-warn')).toBe(true);
  });

  it('repaints on its own a few times a second, not once per line', () => {
    pane.resetBuffer(minutes(10));
    expect(bars()).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(bars().length).toBeGreaterThan(0);
  });

  it('jumps to the first line of a bucket, pausing the live tail', () => {
    pane.resetBuffer(minutes(35));
    activity.paintActivity();
    buttons()[3]?.click();
    expect(view.view.live.following).toBe(false);
    const landed = scrolledIntoView.at(-1);
    expect(landed instanceof HTMLElement && landed.dataset.eidx).toBe('3');
    expect(landed instanceof HTMLElement && landed.classList).toContain(
      'flash',
    );
  });

  it('moves between bars with the arrow keys from a single tab stop', () => {
    pane.resetBuffer(minutes(5));
    activity.paintActivity();
    const stops = buttons().filter((button) => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    stops[0]?.focus();
    stops[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons()[0]);
    buttons()[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons()[1]);
  });

  it('hides when switched off, and remembers it', () => {
    pane.resetBuffer(minutes(35));
    activity.setActivityShown(false);
    expect(elements.activityEl.hidden).toBe(true);
    expect(localStorage.getItem('devbar.logs.activity')).toBe('off');
    activity.setActivityShown(true);
    expect(elements.activityEl.hidden).toBe(false);
  });

  it('starts switched off when it was left that way', async () => {
    mountLogsDom();
    localStorage.setItem('devbar.logs.activity', 'off');
    await load();
    expect(activity.activityShown()).toBe(false);
  });
});
