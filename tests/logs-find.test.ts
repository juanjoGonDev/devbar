// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, scrolledIntoView } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';

/**
 * `renderer/logs/find.ts` binds «Buscar en el log» to the pane: opening and
 * closing it, typing (debounced), the toggles, moving between hits, the
 * ticks, and keeping all of it current while lines stream in.
 */
type FindModule = typeof import('../renderer/logs/find.js');
type PaneModule = typeof import('../renderer/logs/pane.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

describe('renderer/logs/find.ts', () => {
  let find: FindModule;
  let pane: PaneModule;
  let elements: ElementsModule;
  let view: ViewModule;

  beforeEach(async () => {
    vi.useFakeTimers();
    mountLogsDom();
    find = await import('../renderer/logs/find.js');
    pane = await import('../renderer/logs/pane.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function key(
    target: EventTarget,
    name: string,
    extra: KeyboardEventInit = {},
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    target.dispatchEvent(event);
    return event;
  }

  /** Type into the box and let the debounce run out. */
  function search(query: string): void {
    elements.findInputEl.value = query;
    elements.findInputEl.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(find.FIND_DEBOUNCE_MS);
  }

  function drawnText(): string[] {
    return Array.from(
      elements.linesEl.querySelectorAll<HTMLElement>('.line'),
      (row) => row.dataset.line ?? '',
    );
  }

  function hits(): string[] {
    return Array.from(
      elements.linesEl.querySelectorAll('mark.find-hit'),
      (mark) => mark.textContent ?? '',
    );
  }

  function currentRow(): string | undefined {
    return elements.linesEl.querySelector<HTMLElement>('.line.find-current')
      ?.dataset.line;
  }

  function pressed(button: HTMLElement): boolean {
    return button.getAttribute('aria-pressed') === 'true';
  }

  const sample = (): LogEntry[] => [
    entry('GET /api 200'),
    entry('boot'),
    entry('GET /api 500 api down'),
    entry('listo'),
  ];

  describe('opening and closing', () => {
    it('opens on Cmd/Ctrl+F with the cursor in the box, its text selected', () => {
      const select = vi.spyOn(elements.findInputEl, 'select');
      const event = key(document, 'f', { metaKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(elements.findEl.hidden).toBe(false);
      expect(document.activeElement).toBe(elements.findInputEl);
      expect(select).toHaveBeenCalled();
      key(document, 'f', { ctrlKey: true });
      expect(elements.findEl.hidden).toBe(false);
    });

    it('says whether it is open on the root, for the header button', () => {
      expect(document.documentElement.dataset.findOpen).toBe('');
      find.openFind();
      expect(document.documentElement.dataset.findOpen).toBe('true');
      find.closeFind();
      expect(document.documentElement.dataset.findOpen).toBe('');
    });

    it('answers the header button through devbar:find', () => {
      const send = (detail: string): void => {
        document.dispatchEvent(new CustomEvent('devbar:find', { detail }));
      };
      send('toggle');
      expect(elements.findEl.hidden).toBe(false);
      send('toggle');
      expect(elements.findEl.hidden).toBe(true);
      send('open');
      expect(elements.findEl.hidden).toBe(false);
      send('close');
      expect(elements.findEl.hidden).toBe(true);
    });

    it('prefills the box with one line of text selected in the log', () => {
      pane.resetBuffer(sample());
      const body = elements.linesEl.querySelector('.line .body')?.firstChild;
      const range = document.createRange();
      range.setStart(body as Text, 4);
      range.setEnd(body as Text, 8);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      key(document, 'f', { metaKey: true });
      expect(elements.findInputEl.value).toBe('/api');
      expect(hits()).toHaveLength(2);
      window.getSelection()?.removeAllRanges();
    });

    it('closes on Escape, drops the marks and hands the focus back to the log', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      expect(hits()).not.toHaveLength(0);
      key(elements.findInputEl, 'Escape');
      expect(elements.findEl.hidden).toBe(true);
      expect(hits()).toEqual([]);
      expect(document.activeElement).toBe(elements.mainEl);
    });

    it('closing stops hiding lines, whether by the query or by a level chip', () => {
      pane.resetBuffer([
        entry('ok'),
        entry('fallo', { originalLevel: 'error' }),
      ]);
      find.openFind();
      elements.findOnlyBtn.click();
      search('nada');
      expect(drawnText()).toEqual([]);
      elements.levelErrorChip.click();
      find.closeFind();
      expect(drawnText()).toEqual(['ok', 'fallo']);
      expect(view.view.levelFilter.size).toBe(0);
    });
  });

  describe('searching', () => {
    it('marks every hit and keeps every line, once typing pauses', () => {
      pane.resetBuffer(sample());
      find.openFind();
      elements.findInputEl.value = 'api';
      elements.findInputEl.dispatchEvent(new Event('input'));
      expect(hits()).toEqual([]); // not on every keystroke
      vi.advanceTimersByTime(find.FIND_DEBOUNCE_MS);
      expect(hits()).toEqual(['api', 'api', 'api']);
      expect(drawnText()).toHaveLength(4);
      expect(elements.findCountEl.textContent).toBe('1 de 3');
    });

    it('says «Sin resultados» when nothing matches', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('zzz');
      expect(elements.findCountEl.textContent).toBe('Sin resultados');
      expect(elements.findNextBtn.disabled).toBe(true);
    });

    it('honours case, whole word and regex', () => {
      pane.resetBuffer([entry('API api apis')]);
      find.openFind();
      search('api');
      expect(hits()).toHaveLength(3);
      elements.findCaseBtn.click();
      expect(hits()).toEqual(['api', 'api']);
      elements.findWordBtn.click();
      expect(hits()).toEqual(['api']);
      elements.findWordBtn.click();
      elements.findCaseBtn.click();
      elements.findRegexBtn.click();
      search('^a.i');
      expect(hits()).toEqual(['API']);
    });

    it('rings an invalid regex in red, says why, and matches nothing', () => {
      pane.resetBuffer(sample());
      find.openFind();
      elements.findRegexBtn.click();
      search('api(');
      expect(elements.findFieldEl.classList.contains('invalid')).toBe(true);
      expect(elements.findInputEl.getAttribute('aria-invalid')).toBe('true');
      expect(elements.findFieldEl.title).toMatch(/./);
      expect(hits()).toEqual([]);
      search('api');
      expect(elements.findFieldEl.classList.contains('invalid')).toBe(false);
      expect(elements.findFieldEl.hasAttribute('title')).toBe(false);
    });

    it('hides the lines that do not match with «Solo coincidencias»', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      elements.findOnlyBtn.click();
      expect(drawnText()).toEqual(['GET /api 200', 'GET /api 500 api down']);
      elements.findOnlyBtn.click();
      expect(drawnText()).toHaveLength(4);
    });

    it('keeps the toggles across windows, but not the query', async () => {
      find.openFind();
      elements.findRegexBtn.click();
      elements.findOnlyBtn.click();
      search('api');
      const saved = localStorage.getItem('devbar.logs.find');
      expect(JSON.parse(saved ?? '{}')).toMatchObject({
        regex: true,
        onlyMatches: true,
      });
      expect(saved).not.toContain('api');

      mountLogsDom();
      localStorage.setItem('devbar.logs.find', saved ?? '');
      const elementsAgain = await import('../renderer/logs/elements.js');
      await import('../renderer/logs/find.js');
      expect(pressed(elementsAgain.findRegexBtn)).toBe(true);
      expect(pressed(elementsAgain.findOnlyBtn)).toBe(true);
      expect(pressed(elementsAgain.findCaseBtn)).toBe(false);
      expect(elementsAgain.findInputEl.value).toBe('');
    });

    it('still works when storage refuses to be read', async () => {
      mountLogsDom();
      const getItem = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(() => {
          throw new Error('denied');
        });
      const again = await import('../renderer/logs/elements.js');
      await import('../renderer/logs/find.js');
      expect(pressed(again.findCaseBtn)).toBe(false);
      getItem.mockRestore();
    });
  });

  describe('moving between hits', () => {
    it('goes forward on Enter and back on Shift+Enter, wrapping', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      key(elements.findInputEl, 'Enter');
      expect(elements.findCountEl.textContent).toBe('2 de 3');
      expect(currentRow()).toBe('GET /api 500 api down');
      key(elements.findInputEl, 'Enter');
      key(elements.findInputEl, 'Enter');
      expect(elements.findCountEl.textContent).toBe('1 de 3');
      key(elements.findInputEl, 'Enter', { shiftKey: true });
      expect(elements.findCountEl.textContent).toBe('3 de 3');
    });

    it('marks the current hit brighter than the rest', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      key(elements.findInputEl, 'Enter');
      key(elements.findInputEl, 'Enter');
      const current = Array.from(
        elements.linesEl.querySelectorAll('mark.find-hit.current'),
      );
      expect(current).toHaveLength(1);
      expect(current[0]?.closest<HTMLElement>('.line')?.dataset.line).toBe(
        'GET /api 500 api down',
      );
      expect(current[0]?.previousSibling?.textContent).toContain('500 ');
    });

    it('moves with F3 and Shift+F3, and with the buttons', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      key(document, 'F3');
      expect(elements.findCountEl.textContent).toBe('2 de 3');
      key(document, 'F3', { shiftKey: true });
      expect(elements.findCountEl.textContent).toBe('1 de 3');
      elements.findPrevBtn.click();
      expect(elements.findCountEl.textContent).toBe('3 de 3');
      elements.findNextBtn.click();
      expect(elements.findCountEl.textContent).toBe('1 de 3');
    });

    it('searches what was just typed before moving on Enter', () => {
      pane.resetBuffer(sample());
      find.openFind();
      elements.findInputEl.value = 'boot';
      elements.findInputEl.dispatchEvent(new Event('input'));
      key(elements.findInputEl, 'Enter');
      expect(elements.findCountEl.textContent).toBe('1 de 1');
    });

    it('centres the hit it lands on and lets go of the live tail', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      key(elements.findInputEl, 'Enter');
      const target = scrolledIntoView.at(-1) as HTMLElement;
      expect(target.classList.contains('current')).toBe(true);
      expect(view.view.live.following).toBe(false);
    });

    it('draws a hit that lies outside the drawn window', () => {
      const many = Array.from({ length: 2000 }, (_, i) =>
        entry(i === 5 ? 'aguja' : `paja ${i}`),
      );
      pane.resetBuffer(many);
      find.openFind();
      search('aguja');
      expect(hits()).toEqual([]); // the tail is drawn, line 5 is not
      key(elements.findInputEl, 'Enter');
      expect(currentRow()).toBe('aguja');
    });

    it('opens the folded stack a hit is in when it lands there', () => {
      pane.resetBuffer([
        entry('Error: boom', { level: 'error' }),
        entry('    at a (x:1)'),
        entry('    at objetivo (x:2)'),
        entry('listo'),
      ]);
      find.openFind();
      search('objetivo');
      const target = (): HTMLElement | undefined =>
        Array.from(
          elements.linesEl.querySelectorAll<HTMLElement>('.line'),
        ).find((row) => row.dataset.line === '    at objetivo (x:2)');
      expect(target()?.classList.contains('folded')).toBe(true);
      key(elements.findInputEl, 'Enter');
      expect(target()?.classList.contains('folded')).toBe(false);
      expect(target()?.querySelector('mark.find-hit.current')).not.toBeNull();
    });
  });

  describe('streaming', () => {
    it('counts a line that arrives without recounting the buffer', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      pane.pushEntry(entry('api again'));
      expect(elements.findCountEl.textContent).toBe('1 de 4');
      pane.pushEntry(entry('nada'));
      expect(elements.findCountEl.textContent).toBe('1 de 4');
    });

    it('lands on the first hit to arrive when there was none', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('nuevo');
      pane.pushEntry(entry('algo nuevo'));
      expect(elements.findCountEl.textContent).toBe('1 de 1');
      expect(currentRow()).toBe('algo nuevo');
    });

    it('stays on the same hit when the oldest lines are dropped', () => {
      view.view.memoryCap = 500;
      pane.resetBuffer(
        Array.from({ length: 500 }, (_, i) =>
          entry(i % 100 === 0 ? `api ${i}` : `x ${i}`),
        ),
      );
      find.openFind();
      search('api');
      key(elements.findInputEl, 'Enter', { shiftKey: true }); // «api 400»
      for (let i = 0; i < pane.EDGE_CHUNK + 1; i += 1)
        pane.pushEntry(entry(`y ${i}`));
      // 301 lines dropped: «api 0» to «api 300» went with them.
      expect(elements.findCountEl.textContent).toBe('1 de 1');
      expect(currentRow()).toBe('api 400');
    });

    it('counts the matches of a fresh snapshot', () => {
      find.openFind();
      search('api');
      pane.resetBuffer(sample());
      expect(elements.findCountEl.textContent).toMatch(/de 3$/);
    });
  });

  describe('the ticks', () => {
    it('puts one tick per hit line on the right edge, after a short delay', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      vi.advanceTimersByTime(find.TICKS_DELAY_MS);
      const ticks = Array.from(
        elements.findTicksEl.querySelectorAll<HTMLElement>('.find-tick'),
      );
      expect(elements.findTicksEl.hidden).toBe(false);
      expect(ticks.map((t) => t.style.top)).toEqual(['12.5%', '62.5%']);
      expect(ticks.map((t) => t.classList.contains('current'))).toEqual([
        true,
        false,
      ]);
    });

    it('jumps to its line when a tick is pressed', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      vi.advanceTimersByTime(find.TICKS_DELAY_MS);
      elements.findTicksEl
        .querySelectorAll<HTMLElement>('.find-tick')[1]
        ?.click();
      expect(currentRow()).toBe('GET /api 500 api down');
      expect(elements.findCountEl.textContent).toBe('2 de 3');
    });

    it('hides the ticks once closed', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      vi.advanceTimersByTime(find.TICKS_DELAY_MS);
      find.closeFind();
      expect(elements.findTicksEl.hidden).toBe(true);
      expect(elements.findTicksEl.childElementCount).toBe(0);
    });
  });

  describe('entry points', () => {
    it('filters by what an entry point or a row action asks for', () => {
      pane.resetBuffer(sample());
      find.filterBy('boot');
      expect(elements.findEl.hidden).toBe(false);
      expect(pressed(elements.findOnlyBtn)).toBe(true);
      expect(drawnText()).toEqual(['boot']);
    });

    it('opens when an entry point pins a level, so the chip shows', () => {
      pane.setLevelFilter(['error']);
      expect(elements.findEl.hidden).toBe(false);
      expect(pressed(elements.levelErrorChip)).toBe(true);
    });

    it('turns «Solo coincidencias» off when a line is shown in context', () => {
      pane.resetBuffer(sample());
      find.filterBy('boot');
      elements.linesEl.querySelector<HTMLElement>('.line .ts')?.click();
      expect(pressed(elements.findOnlyBtn)).toBe(false);
      expect(drawnText()).toHaveLength(4);
      expect(hits()).toEqual(['boot']); // still marked
    });

    it('clears the box without closing it', () => {
      pane.resetBuffer(sample());
      find.openFind();
      search('api');
      find.clearFindQuery();
      expect(elements.findEl.hidden).toBe(false);
      expect(hits()).toEqual([]);
      expect(elements.findCountEl.textContent).toBe('');
    });
  });
});
