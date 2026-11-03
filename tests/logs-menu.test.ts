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

  describe('on a narrow toolbar', () => {
    /** What the «Logs: header» container query does to a folded button. */
    function fold(...buttons: HTMLButtonElement[]): void {
      for (const button of buttons) {
        button.hidden = false;
        button.style.display = 'none';
      }
    }

    function clicksOn(button: HTMLButtonElement): () => number {
      let count = 0;
      button.addEventListener('click', () => (count += 1));
      return () => count;
    }

    it('offers nothing extra while every button is drawn', () => {
      elements.restartBtn.hidden = false;
      elements.runBtn.hidden = false;
      elements.moreBtn.click();
      expect(labels()).not.toContain('Reiniciar');
      expect(labels()).not.toContain('Silenciados');
    });

    it('takes in the folded run controls and the silenced toggle, first', () => {
      elements.runBtn.setAttribute('aria-label', 'Parar');
      elements.silenceToggleCountEl.textContent = '2';
      fold(elements.restartBtn, elements.runBtn, elements.silenceToggleBtn);
      elements.moreBtn.click();
      expect(labels()).toEqual([
        'Reiniciar',
        'Parar',
        'Silenciados (2)',
        'Copiar todo',
        'Vaciar',
        'Mostrar actividad',
      ]);
      // Set apart from the view's own actions by a line of their own.
      expect(document.querySelectorAll('[role="separator"]')).toHaveLength(2);
    });

    it('leaves out a run control the service does not have', () => {
      fold(elements.silenceToggleBtn);
      elements.restartBtn.hidden = true;
      elements.runBtn.hidden = true;
      elements.moreBtn.click();
      expect(labels()[0]).toBe('Silenciados');
    });

    it('acts through the folded buttons themselves', () => {
      fold(elements.restartBtn, elements.runBtn, elements.silenceToggleBtn);
      const restarts = clicksOn(elements.restartBtn);
      const runs = clicksOn(elements.runBtn);
      const silences = clicksOn(elements.silenceToggleBtn);
      for (const label of ['Reiniciar', 'Iniciar', 'Silenciados']) {
        elements.moreBtn.click();
        choose(label);
      }
      expect([restarts(), runs(), silences()]).toEqual([1, 1, 1]);
    });
  });
});
