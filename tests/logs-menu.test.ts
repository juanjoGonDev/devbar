// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  drain,
  entry,
  mountLogsDom,
  type LogsDom,
} from './helpers/logs-dom.js';

/**
 * `renderer/logs/menu.ts` is the toolbar's «⋯» menu: the view-wide actions
 * that used to be a row of icon buttons. What it offers depends on what is on
 * screen, so that is asserted from the menu the button actually opens.
 */
type BufferModule = typeof import('../renderer/logs/buffer.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type PaneModule = typeof import('../renderer/logs/pane.js');
type ViewModule = typeof import('../renderer/logs/view.js');

describe('renderer/logs/menu.ts', () => {
  let dom: LogsDom;
  let buffer: BufferModule;
  let elements: ElementsModule;
  let pane: PaneModule;
  let view: ViewModule;

  async function load(search?: string): Promise<void> {
    dom = mountLogsDom(search ? { search } : {});
    await import('../renderer/logs/menu.js');
    buffer = await import('../renderer/logs/buffer.js');
    elements = await import('../renderer/logs/elements.js');
    pane = await import('../renderer/logs/pane.js');
    view = await import('../renderer/logs/view.js');
  }

  beforeEach(async () => {
    await load();
  });

  function items(): HTMLButtonElement[] {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ),
    );
  }

  /** The item's own text, without the glyph the icon font draws. */
  function labelOf(item: HTMLElement): string {
    return item.querySelector('span:not(.icon)')?.textContent ?? '';
  }

  function labels(): string[] {
    return items().map(labelOf);
  }

  function choose(label: string): void {
    const item = items().find((candidate) => labelOf(candidate) === label);
    if (!item) throw new Error(`no menu item ${label}`);
    item.click();
  }

  it('opens under its button, and closes when pressed again', () => {
    elements.moreBtn.click();
    expect(elements.moreBtn.getAttribute('aria-expanded')).toBe('true');
    expect(items().length).toBeGreaterThan(0);
    elements.moreBtn.click();
    expect(items()).toHaveLength(0);
  });

  it('offers to detach the single service on screen', () => {
    view.view.processId = 'api';
    elements.moreBtn.click();
    expect(labels()).toEqual([
      'Copiar todo',
      'Vaciar',
      'Mostrar actividad',
      'Separar ventana',
    ]);
    choose('Separar ventana');
    expect(dom.argsFor('openLogs')).toEqual([
      [{ processId: 'api', detached: true }],
    ]);
  });

  it('has nothing to detach while a merged scope is on screen', () => {
    view.view.processId = null;
    elements.moreBtn.click();
    expect(labels()).toEqual(['Copiar todo', 'Vaciar', 'Mostrar actividad']);
  });

  it('has nothing to detach in a window that already is detached', async () => {
    await load('?detached=1');
    view.view.processId = 'api';
    elements.moreBtn.click();
    expect(labels()).toEqual(['Copiar todo', 'Vaciar', 'Mostrar actividad']);
  });

  it('says it copies the selection when there is one', () => {
    buffer.buffer.selected.add(0);
    buffer.buffer.selected.add(1);
    elements.moreBtn.click();
    expect(labels()[0]).toBe('Copiar 2 seleccionada(s)');
  });

  it('switches the activity strip off and on, showing which it is', () => {
    const toggle = (): HTMLButtonElement | undefined =>
      items().find((item) => labelOf(item) === 'Mostrar actividad');
    elements.moreBtn.click();
    expect(toggle()?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    choose('Mostrar actividad');
    expect(localStorage.getItem('devbar.logs.activity')).toBe('off');
    elements.moreBtn.click();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('empties the log from «Vaciar»', async () => {
    view.view.processId = 'api';
    pane.resetBuffer([entry('vieja')]);
    elements.moreBtn.click();
    choose('Vaciar');
    await drain();
    expect(dom.argsFor('clearLogs')).toEqual([['api']]);
    expect(elements.linesEl.childElementCount).toBe(0);
  });
});
