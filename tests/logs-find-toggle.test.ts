// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { drain, mountLogsDom } from './helpers/logs-dom.js';

/**
 * `renderer/logs/find-toggle.ts` is the toolbar's «Buscar» button. The find
 * widget itself lives in the log panel; the button only asks it to open or
 * close (`devbar:find` with `'toggle'`) and reads back whether it is open
 * from `data-find-open` on the root element.
 */
describe('renderer/logs/find-toggle.ts', () => {
  let button: HTMLButtonElement;

  async function load(platform?: string): Promise<void> {
    mountLogsDom();
    if (platform) {
      const api = window.api;
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: new Proxy(api, {
          get: (target, key) =>
            key === 'platform'
              ? platform
              : (target as unknown as Record<string | symbol, unknown>)[key],
        }),
      });
    }
    delete document.documentElement.dataset.findOpen;
    await import('../renderer/logs/find-toggle.js');
    const found = document.getElementById('find-toggle');
    if (!(found instanceof HTMLButtonElement)) throw new Error('no button');
    button = found;
  }

  beforeEach(async () => {
    await load();
  });

  it('asks the find widget to toggle', () => {
    const asked: unknown[] = [];
    document.addEventListener('devbar:find', (event) =>
      asked.push((event as CustomEvent).detail),
    );
    button.click();
    expect(asked).toEqual(['toggle']);
  });

  it('names the shortcut with Ctrl off macOS', () => {
    expect(button.getAttribute('aria-label')).toBe('Buscar (Ctrl+F)');
    expect(button.title).toBe('Buscar (Ctrl+F)');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+F');
  });

  it('names the shortcut with Cmd on macOS', async () => {
    await load('darwin');
    expect(button.getAttribute('aria-label')).toBe('Buscar (Cmd+F)');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Meta+F');
  });

  it('is pressed while the find widget says it is open', async () => {
    expect(button.getAttribute('aria-pressed')).toBe('false');
    document.documentElement.dataset.findOpen = 'true';
    await drain();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    document.documentElement.dataset.findOpen = 'false';
    await drain();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('starts pressed when the widget opened first', async () => {
    mountLogsDom();
    document.documentElement.dataset.findOpen = 'true';
    await import('../renderer/logs/find-toggle.js');
    expect(
      document.getElementById('find-toggle')?.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
