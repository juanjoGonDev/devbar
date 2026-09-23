// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComboboxControl, ComboboxOption } from '../renderer/combobox.js';

/**
 * `renderer/combobox.ts` is the branch picker in the tray row: a text input
 * plus a body-level dropdown, driven entirely by focus, typing and arrow keys.
 * Only its pure height helper was covered (`combobox-host-height.test.ts`), so
 * every interactive path — filtering, highlighting, selection, the host-height
 * callbacks — was unverified. These tests drive the real widget under jsdom.
 */

type ComboboxModule = typeof import('../renderer/combobox.js');

const OPTIONS: ComboboxOption[] = [
  { value: 'develop', label: 'develop' },
  { value: 'feature/login', label: 'feature/login' },
  { value: 'main', label: 'main' },
];

function stubRect(el: Element, rect: Partial<DOMRect>): void {
  const full: DOMRect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  };
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => full,
  });
}

describe('renderer/combobox.ts', () => {
  let combobox: ComboboxModule;
  let setTrayHeight: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    document.body.innerHTML = '';
    setTrayHeight = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { setTrayHeight },
    });
    vi.resetModules();
    combobox = await import('../renderer/combobox.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(
    overrides: Partial<Parameters<ComboboxModule['createCombobox']>[0]> = {},
  ): { root: ComboboxControl; input: HTMLInputElement } {
    const root = combobox.createCombobox({
      value: null,
      options: OPTIONS,
      placeholder: 'Rama…',
      ...overrides,
    });
    document.body.appendChild(root);
    const input = root.querySelector('input');
    if (!input) throw new Error('combobox has no input');
    return { root, input };
  }

  function list(): HTMLElement {
    const nodes = document.querySelectorAll<HTMLElement>('.combobox-list');
    const el = nodes[nodes.length - 1];
    if (!el) throw new Error('no combobox list in the document');
    return el;
  }

  function items(): HTMLElement[] {
    return Array.from(list().querySelectorAll<HTMLElement>('.combobox-item'));
  }

  function labels(): string[] {
    return items().map((item) => item.textContent?.replace('✓', '') ?? '');
  }

  /**
   * The row drawn as highlighted. Queried by the ONE class rather than by
   * `.combobox-item.is-highlighted`: jsdom's selector engine caches a
   * compound selector's result and does not invalidate it when `classList`
   * changes, so the compound form reports a stale miss here.
   */
  function highlighted(): string | null {
    const els = list().getElementsByClassName('is-highlighted');
    const el = els[0];
    return el ? (el.textContent?.replace('✓', '') ?? '') : null;
  }

  function highlightCount(): number {
    return list().getElementsByClassName('is-highlighted').length;
  }

  function press(input: HTMLInputElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event;
  }

  function type(input: HTMLInputElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  describe('opening and closing', () => {
    it('starts closed, with no list and no open dropdown registered', () => {
      build();
      expect(list().style.display).toBe('none');
      expect(combobox.isComboboxOpen()).toBe(false);
    });

    it('opens the dropdown on focus', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      expect(list().style.display).toBe('block');
      expect(combobox.isComboboxOpen()).toBe(true);
    });

    it('lists every option when it opens', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()).toEqual(['develop', 'feature/login', 'main']);
    });

    it('closes on Escape and reports the dropdown as closed', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'Escape');
      expect(list().style.display).toBe('none');
      expect(combobox.isComboboxOpen()).toBe(false);
    });

    it('restores the selected label when Escape discards a half-typed query', () => {
      const { input } = build({ value: 'main' });
      input.dispatchEvent(new FocusEvent('focus'));
      type(input, 'feat');
      press(input, 'Escape');
      expect(input.value).toBe('main');
    });

    it('closes a while after the input loses focus', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      input.dispatchEvent(new FocusEvent('blur'));
      expect(combobox.isComboboxOpen()).toBe(true);
      vi.advanceTimersByTime(200);
      expect(combobox.isComboboxOpen()).toBe(false);
    });

    it('counts two open dropdowns and only closes when both are gone', () => {
      const first = build();
      const second = build();
      first.input.dispatchEvent(new FocusEvent('focus'));
      second.input.dispatchEvent(new FocusEvent('focus'));
      press(first.input, 'Escape');
      expect(combobox.isComboboxOpen()).toBe(true);
      press(second.input, 'Escape');
      expect(combobox.isComboboxOpen()).toBe(false);
    });

    it('records when the user last interacted, so the host can ignore the synthetic click', () => {
      const { input } = build();
      expect(combobox.lastComboboxInteractionAt()).toBe(0);
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'Escape');
      expect(combobox.lastComboboxInteractionAt()).toBe(Date.now());
    });
  });

  describe('filtering', () => {
    it('keeps only the options matching what was typed', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      type(input, 'e');
      expect(labels()).toEqual(['develop', 'feature/login']);
    });

    it('matches case-insensitively', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      type(input, 'MAIN');
      expect(labels()).toEqual(['main']);
    });

    it('opens the dropdown when typing into a closed combobox', () => {
      const { input } = build();
      type(input, 'main');
      expect(combobox.isComboboxOpen()).toBe(true);
      expect(labels()).toEqual(['main']);
    });

    it('shows every option again when the query is cleared', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      type(input, 'main');
      type(input, '');
      expect(labels()).toEqual(['develop', 'feature/login', 'main']);
    });

    it('shows EVERY branch when opening on a group that already has one checked out', () => {
      // Regression: the filter read `input.value`, which the widget itself
      // fills with the current branch. Opening the picker on a group sitting
      // on `main` therefore listed only `main` — every other branch was
      // hidden behind a query the user never typed, so the control could not
      // do the one thing it exists for until the text was deleted by hand.
      const { input } = build({ value: 'main' });
      expect(input.value).toBe('main');
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()).toEqual(['main', 'develop', 'feature/login']);
    });

    it('forgets the previous query once the dropdown is reopened', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      type(input, 'main');
      press(input, 'Escape');
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()).toEqual(['develop', 'feature/login', 'main']);
    });
  });

  describe('the current option', () => {
    it('hoists the checked-out branch to the top of the list', () => {
      const { input } = build({ value: 'main' });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()[0]).toBe('main');
    });

    it('marks it with a check and separates it from the rest', () => {
      const { input } = build({ value: 'main' });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(items()[0]?.querySelector('.combobox-check')?.textContent).toBe(
        '✓',
      );
      expect(list().querySelector('.combobox-separator')).not.toBeNull();
    });

    it('honours an option flagged `current` even when no value is set', () => {
      const { input } = build({
        value: null,
        options: [
          { value: 'develop', label: 'develop' },
          { value: 'main', label: 'main', current: true },
        ],
      });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()[0]).toBe('main');
    });

    it('draws no separator when the current option is the only one left', () => {
      const { input } = build({ value: 'main' });
      input.dispatchEvent(new FocusEvent('focus'));
      type(input, 'main');
      expect(list().querySelector('.combobox-separator')).toBeNull();
    });
  });

  describe('keyboard navigation', () => {
    it('highlights the first option on the first ArrowDown', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'ArrowDown');
      expect(highlighted()).toBe('develop');
    });

    it('walks down the list and stops at the last option', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      for (let i = 0; i < 5; i += 1) press(input, 'ArrowDown');
      expect(highlighted()).toBe('main');
    });

    it('walks back up and stops at the first option', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'ArrowDown');
      press(input, 'ArrowDown');
      press(input, 'ArrowUp');
      expect(highlighted()).toBe('develop');
      press(input, 'ArrowUp');
      expect(highlighted()).toBe('develop');
    });

    it('opens a closed dropdown on ArrowDown instead of moving the highlight', () => {
      const { input } = build();
      expect(combobox.isComboboxOpen()).toBe(false);
      press(input, 'ArrowDown');
      expect(combobox.isComboboxOpen()).toBe(true);
      expect(highlighted()).toBeNull();
    });

    it('swallows the arrow keys so the caret does not move', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      expect(press(input, 'ArrowDown').defaultPrevented).toBe(true);
      expect(press(input, 'ArrowUp').defaultPrevented).toBe(true);
    });

    it('selects the highlighted option on Enter', () => {
      const selected: string[] = [];
      const { input } = build({ onSelect: (value) => selected.push(value) });
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'ArrowDown');
      press(input, 'ArrowDown');
      expect(selected).toEqual([]);
      press(input, 'Enter');
      expect(selected).toEqual(['feature/login']);
    });

    it('selects the option the user can SEE highlighted, not the one underneath it', () => {
      // Regression: `renderList` hoists the checked-out branch to the top of
      // the list, but the Enter handler indexed into the UNHOISTED list. So
      // with a branch checked out, the highlight and the selection pointed at
      // different rows — arrow-down-then-Enter checked out a branch the user
      // had never highlighted.
      const selected: string[] = [];
      const { input } = build({
        value: 'main',
        onSelect: (value) => selected.push(value),
      });
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'ArrowDown');
      press(input, 'ArrowDown');
      const shown = highlighted();
      press(input, 'Enter');
      expect(shown).toBe('develop');
      expect(selected).toEqual([shown]);
    });

    it('just closes on Enter when nothing is highlighted', () => {
      const selected: string[] = [];
      const { input } = build({ onSelect: (value) => selected.push(value) });
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'Enter');
      expect(selected).toEqual([]);
      expect(combobox.isComboboxOpen()).toBe(false);
    });

    it('ignores keys it does not handle', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      expect(press(input, 'a').defaultPrevented).toBe(false);
      expect(combobox.isComboboxOpen()).toBe(true);
    });
  });

  describe('pointer selection', () => {
    it('highlights the option under the pointer', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      items()[1]?.dispatchEvent(new MouseEvent('mouseenter'));
      expect(highlighted()).toBe('feature/login');
    });

    it('moves the highlight off the option the keyboard had left behind', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'ArrowDown');
      expect(highlighted()).toBe('develop');
      items()[2]?.dispatchEvent(new MouseEvent('mouseenter'));
      expect(highlightCount()).toBe(1);
      expect(highlighted()).toBe('main');
    });

    it('does nothing when the pointer re-enters the option already highlighted', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      const second = items()[1];
      second?.dispatchEvent(new MouseEvent('mouseenter'));
      second?.dispatchEvent(new MouseEvent('mouseenter'));
      expect(highlighted()).toBe('feature/login');
    });

    it('selects the option on mousedown and writes its label into the input', () => {
      const selected: string[] = [];
      const { input } = build({ onSelect: (value) => selected.push(value) });
      input.dispatchEvent(new FocusEvent('focus'));
      items()[1]?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
      expect(selected).toEqual(['feature/login']);
      expect(input.value).toBe('feature/login');
      expect(combobox.isComboboxOpen()).toBe(false);
    });

    it('swallows the mousedown so the input never loses focus first', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      items()[0]?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('selects an option the pointer highlighted, keeping highlight and selection in step', () => {
      const selected: string[] = [];
      const { input } = build({
        value: 'main',
        onSelect: (value) => selected.push(value),
      });
      input.dispatchEvent(new FocusEvent('focus'));
      items()[2]?.dispatchEvent(new MouseEvent('mouseenter'));
      const shown = highlighted();
      press(input, 'Enter');
      expect(shown).toBe('feature/login');
      expect(selected).toEqual([shown]);
    });
  });

  describe('accessibility', () => {
    it('announces itself as a combobox wired to its own listbox', () => {
      const { input } = build();
      expect(input.getAttribute('role')).toBe('combobox');
      expect(input.getAttribute('aria-autocomplete')).toBe('list');
      expect(list().getAttribute('role')).toBe('listbox');
      expect(input.getAttribute('aria-controls')).toBe(list().id);
      expect(list().id).not.toBe('');
    });

    it('gives each combobox on the page its own listbox id', () => {
      const first = build();
      const second = build();
      const firstId = first.input.getAttribute('aria-controls');
      const secondId = second.input.getAttribute('aria-controls');
      expect(firstId).not.toBe(secondId);
      expect(document.getElementById(secondId ?? '')).toBe(list());
    });

    it('reports whether the dropdown is expanded', () => {
      const { input } = build();
      expect(input.getAttribute('aria-expanded')).toBe('false');
      input.dispatchEvent(new FocusEvent('focus'));
      expect(input.getAttribute('aria-expanded')).toBe('true');
      press(input, 'Escape');
      expect(input.getAttribute('aria-expanded')).toBe('false');
    });

    it('points at the highlighted option so a screen reader follows the arrows', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      expect(input.hasAttribute('aria-activedescendant')).toBe(false);
      press(input, 'ArrowDown');
      const active = items()[0];
      expect(active?.id).not.toBe('');
      expect(input.getAttribute('aria-activedescendant')).toBe(active?.id);
    });

    it('drops the active option when the dropdown closes', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'ArrowDown');
      press(input, 'Escape');
      expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    });

    it('marks every row as an option and flags the checked-out one as selected', () => {
      const { input } = build({ value: 'main' });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(
        items().every((item) => item.getAttribute('role') === 'option'),
      ).toBe(true);
      expect(items()[0]?.getAttribute('aria-selected')).toBe('true');
      expect(items()[1]?.getAttribute('aria-selected')).toBe('false');
    });

    it('hides the decorative separator from assistive tech', () => {
      const { input } = build({ value: 'main' });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(
        list()
          .querySelector('.combobox-separator')
          ?.getAttribute('aria-hidden'),
      ).toBe('true');
    });

    it('announces the loading placeholder as an option nobody can pick', () => {
      const { root, input } = build({ value: null, options: [] });
      root.setLoading(true);
      input.dispatchEvent(new FocusEvent('focus'));
      const loading = list().querySelector('.combobox-loading');
      expect(loading?.textContent).toBe('Cargando…');
      expect(loading?.getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('programmatic updates', () => {
    it('replaces the options and refreshes the input label', () => {
      const { root, input } = build({ value: 'main' });
      root.setOptions([{ value: 'main', label: 'origin/main' }]);
      expect(input.value).toBe('origin/main');
    });

    it('re-renders an open list when the options land', () => {
      const { root, input } = build({ value: null, options: [] });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(items()).toHaveLength(0);
      root.setOptions(OPTIONS);
      expect(labels()).toEqual(['develop', 'feature/login', 'main']);
    });

    it('shows the loading row only while the list is open and empty', () => {
      const { root, input } = build({ value: null, options: [] });
      input.dispatchEvent(new FocusEvent('focus'));
      root.setLoading(true);
      expect(labels()).toEqual(['Cargando…']);
      root.setLoading(false);
      expect(labels()).toEqual([]);
    });

    it('prefers real options over the loading row', () => {
      const { root, input } = build();
      root.setLoading(true);
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()).toEqual(['develop', 'feature/login', 'main']);
    });

    it('moves the value without touching the option list', () => {
      const { root, input } = build({ value: 'main' });
      root.setValue('develop');
      expect(input.value).toBe('develop');
      input.dispatchEvent(new FocusEvent('focus'));
      expect(labels()[0]).toBe('develop');
    });

    it('empties the label when the value is cleared', () => {
      const { root, input } = build({ value: 'main' });
      root.setValue(null);
      expect(input.value).toBe('');
    });
  });

  describe('host height', () => {
    it('asks the host to grow so the open list fits', () => {
      const { input } = build();
      combobox.setComboboxHostHooks({ measureContentHeight: () => 120 });
      input.dispatchEvent(new FocusEvent('focus'));
      stubRect(list(), { bottom: 400 });
      vi.advanceTimersByTime(32);
      expect(setTrayHeight).toHaveBeenCalledWith(412);
    });

    it('stays quiet while the list is closed', () => {
      build();
      combobox.setComboboxHostHooks({ measureContentHeight: () => 120 });
      vi.advanceTimersByTime(32);
      expect(setTrayHeight).not.toHaveBeenCalled();
    });

    it('stays quiet when the list has no measurable box yet', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      stubRect(list(), { bottom: 0 });
      vi.advanceTimersByTime(32);
      expect(setTrayHeight).not.toHaveBeenCalled();
    });

    it('re-measures when new options change the list height', () => {
      const { root, input } = build({ value: null, options: [] });
      combobox.setComboboxHostHooks({ measureContentHeight: () => 0 });
      input.dispatchEvent(new FocusEvent('focus'));
      stubRect(list(), { bottom: 300 });
      vi.advanceTimersByTime(32);
      setTrayHeight.mockClear();
      root.setOptions(OPTIONS);
      vi.advanceTimersByTime(32);
      expect(setTrayHeight).toHaveBeenCalledWith(312);
    });

    it('re-measures when the loading row replaces the list', () => {
      const { root, input } = build({ value: null, options: [] });
      input.dispatchEvent(new FocusEvent('focus'));
      stubRect(list(), { bottom: 200 });
      vi.advanceTimersByTime(32);
      setTrayHeight.mockClear();
      root.setLoading(true);
      vi.advanceTimersByTime(32);
      expect(setTrayHeight).toHaveBeenCalledWith(212);
    });

    it('re-measures after each keystroke narrows the list', () => {
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      stubRect(list(), { bottom: 250 });
      setTrayHeight.mockClear();
      type(input, 'main');
      vi.advanceTimersByTime(32);
      expect(setTrayHeight).toHaveBeenCalledWith(262);
    });
  });

  describe('host hooks', () => {
    it('flushes the render the host deferred while the dropdown was open', () => {
      const flushPendingRender = vi.fn();
      combobox.setComboboxHostHooks({ flushPendingRender });
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      expect(flushPendingRender).not.toHaveBeenCalled();
      press(input, 'Escape');
      expect(flushPendingRender).toHaveBeenCalledTimes(1);
    });

    it('lets the host shrink back once the dropdown is gone', () => {
      const scheduleTrayResize = vi.fn();
      combobox.setComboboxHostHooks({ scheduleTrayResize });
      const { input } = build();
      input.dispatchEvent(new FocusEvent('focus'));
      press(input, 'Escape');
      expect(scheduleTrayResize).toHaveBeenCalledTimes(1);
    });

    it('defers the flush until the selection has been written', async () => {
      const flushPendingRender = vi.fn();
      combobox.setComboboxHostHooks({ flushPendingRender });
      let resolveSelect: () => void = () => undefined;
      const { input } = build({
        onSelect: () =>
          new Promise<void>((resolve) => {
            resolveSelect = resolve;
          }),
      });
      input.dispatchEvent(new FocusEvent('focus'));
      items()[0]?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
      expect(flushPendingRender).not.toHaveBeenCalled();
      resolveSelect();
      await vi.advanceTimersByTimeAsync(0);
      expect(flushPendingRender).toHaveBeenCalledTimes(1);
    });
  });

  describe('positioning', () => {
    it('left-aligns the list under the input when there is room to its right', () => {
      const { input } = build();
      stubRect(input, { left: 40, right: 150, bottom: 30 });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(list().style.left).toBe('40px');
      expect(list().style.right).toBe('auto');
      expect(list().style.top).toBe('36px');
    });

    it('right-aligns the list when the input sits against the right edge', () => {
      const { input } = build();
      stubRect(input, { left: 900, right: 1000, bottom: 30 });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(list().style.left).toBe('auto');
      expect(list().style.right).toBe('24px');
    });

    it('never starts the list left of the margin', () => {
      const { input } = build();
      stubRect(input, { left: 2, right: 110, bottom: 30 });
      input.dispatchEvent(new FocusEvent('focus'));
      expect(list().style.left).toBe('10px');
    });

    it('repositions the list when a resize moves the input', () => {
      const { input } = build();
      stubRect(input, { left: 40, right: 150, bottom: 30 });
      input.dispatchEvent(new FocusEvent('focus'));
      stubRect(input, { left: 200, right: 310, bottom: 80 });
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(32);
      expect(list().style.left).toBe('200px');
      expect(list().style.top).toBe('86px');
    });

    it('leaves the list alone when a resize did not move the input', () => {
      const { input } = build();
      stubRect(input, { left: 40, right: 150, bottom: 30 });
      input.dispatchEvent(new FocusEvent('focus'));
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(32);
      stubRect(input, { left: 600, right: 710, bottom: 30 });
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(32);
      expect(list().style.left).toBe('600px');
    });

    it('ignores a resize while the dropdown is closed', () => {
      const { input } = build();
      stubRect(input, { left: 40, right: 150, bottom: 30 });
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(32);
      expect(list().style.left).toBe('');
      expect(input.value).toBe('');
    });
  });
});
