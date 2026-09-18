// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachKeyboardReordering,
  planKeyboardMove,
  resolveLabel,
  type KeyboardMoveContainer,
  type KeyboardMoveDirection,
  type KeyboardMoveTarget,
  type KeyboardReorderAdapter,
} from '../renderer/tray/dnd-keyboard.js';

/**
 * `planKeyboardMove` is the pure index-math seam for keyboard grab-and-move
 * reordering (WCAG 2.1.1). `containers` is the zone's containers in
 * top-to-bottom order — a single-entry array for a plain single-container
 * list, or every sibling container sharing a cross-container zone.
 *
 * The rest of the module is DOM wiring: the shared announcer, the enhanced
 * handles and the one document-level key listener. It runs under jsdom here,
 * driven through `attachKeyboardReordering` with a test adapter, which is the
 * same seam `attachDragHandlers`/`attachCrossContainerDragHandlers` use.
 */

interface Commit {
  itemId: string;
  from: KeyboardMoveTarget;
  to: KeyboardMoveTarget;
  containers: readonly KeyboardMoveContainer[];
}

describe('renderer/tray/dnd-keyboard.ts', () => {
  afterEach(() => {
    // The grab is a module-level singleton and the key listener is installed
    // once per document, so an unfinished grab would leak into the next test.
    for (const handle of document.querySelectorAll<HTMLElement>('.drag-handle'))
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    document.body.innerHTML = '';
  });

  function build(spec: Record<string, readonly string[]>): {
    containers: HTMLElement[];
    commits: Commit[];
    names: Record<string, string | null>;
  } {
    const containers: HTMLElement[] = [];
    for (const [containerId, itemIds] of Object.entries(spec)) {
      const container = document.createElement('div');
      container.dataset.containerId = containerId;
      for (const itemId of itemIds) {
        const card = document.createElement('div');
        card.dataset.id = itemId;
        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        card.appendChild(handle);
        const name = document.createElement('strong');
        name.textContent = itemId.toUpperCase();
        card.appendChild(name);
        container.appendChild(card);
      }
      document.body.appendChild(container);
      containers.push(container);
    }
    return { containers, commits: [], names: {} };
  }

  function adapterFor(
    world: ReturnType<typeof build>,
    nameContainer: (id: string) => string | null = () => null,
  ): KeyboardReorderAdapter {
    return {
      snapshotContainers: () =>
        world.containers.map((container) => ({
          id: container.dataset.containerId ?? '',
          itemIds: Array.from(
            container.children,
            (node) => (node as HTMLElement).dataset.id ?? '',
          ),
        })),
      containerIdOf: (card) => card.parentElement?.dataset.containerId ?? '',
      nameContainer,
      commit: (itemId, containers, from, to) => {
        world.commits.push({ itemId, containers, from, to });
      },
    };
  }

  function wire(
    spec: Record<string, readonly string[]>,
    nameContainer?: (id: string) => string | null,
  ): ReturnType<typeof build> {
    const world = build(spec);
    const adapter = adapterFor(world, nameContainer);
    for (const container of world.containers)
      attachKeyboardReordering(container, adapter);
    return world;
  }

  function handleFor(itemId: string): HTMLElement {
    const handle = document.querySelector<HTMLElement>(
      `[data-id="${itemId}"] .drag-handle`,
    );
    if (!handle) throw new Error(`no handle for ${itemId}`);
    return handle;
  }

  function arrowFor(direction: KeyboardMoveDirection): string {
    return direction === 'up' ? 'ArrowUp' : 'ArrowDown';
  }

  function press(itemId: string, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    handleFor(itemId).dispatchEvent(event);
    return event;
  }

  function announced(): string {
    return document.getElementById('dnd-keyboard-announcer')?.textContent ?? '';
  }

  describe('planKeyboardMove', () => {
    it('moves one position up within the same container', () => {
      const target = planKeyboardMove({
        containers: [{ id: 'list-1', itemIds: ['a', 'b', 'c'] }],
        containerId: 'list-1',
        index: 1,
        direction: 'up',
      });
      expect(target).toEqual({ containerId: 'list-1', index: 0 });
    });

    it('moves one position down within the same container', () => {
      const target = planKeyboardMove({
        containers: [{ id: 'list-1', itemIds: ['a', 'b', 'c'] }],
        containerId: 'list-1',
        index: 0,
        direction: 'down',
      });
      expect(target).toEqual({ containerId: 'list-1', index: 1 });
    });

    it('is a no-op at the top edge of a single-container list', () => {
      const target = planKeyboardMove({
        containers: [{ id: 'list-1', itemIds: ['a', 'b', 'c'] }],
        containerId: 'list-1',
        index: 0,
        direction: 'up',
      });
      expect(target).toBeNull();
    });

    it('is a no-op at the bottom edge of a single-container list', () => {
      const target = planKeyboardMove({
        containers: [{ id: 'list-1', itemIds: ['a', 'b', 'c'] }],
        containerId: 'list-1',
        index: 2,
        direction: 'down',
      });
      expect(target).toBeNull();
    });

    it('crosses up into the end of the previous container', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a', 'b'] },
          { id: 'step-2', itemIds: ['x', 'y'] },
        ],
        containerId: 'step-2',
        index: 0,
        direction: 'up',
      });
      expect(target).toEqual({ containerId: 'step-1', index: 2 });
    });

    it('crosses down into the start of the next container', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a', 'b'] },
          { id: 'step-2', itemIds: ['x', 'y'] },
        ],
        containerId: 'step-1',
        index: 1,
        direction: 'down',
      });
      expect(target).toEqual({ containerId: 'step-2', index: 0 });
    });

    it('crossing up from the very first container is a no-op (no previous container)', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a'] },
          { id: 'step-2', itemIds: ['x'] },
        ],
        containerId: 'step-1',
        index: 0,
        direction: 'up',
      });
      expect(target).toBeNull();
    });

    it('crossing down from the very last container is a no-op (no next container)', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a'] },
          { id: 'step-2', itemIds: ['x'] },
        ],
        containerId: 'step-2',
        index: 0,
        direction: 'down',
      });
      expect(target).toBeNull();
    });

    it('crosses out of a container holding only the grabbed item, landing at the end of the previous one', () => {
      // "step-2" holds ONLY the item being moved — index 0 is simultaneously
      // the top AND the bottom edge (length 1), so this pins down that an
      // upward cross still resolves to the previous container instead of
      // getting confused by the double boundary.
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a', 'b'] },
          { id: 'step-2', itemIds: ['solo'] },
          { id: 'step-3', itemIds: ['x'] },
        ],
        containerId: 'step-2',
        index: 0,
        direction: 'up',
      });
      expect(target).toEqual({ containerId: 'step-1', index: 2 });
    });

    it('crosses out of a container holding only the grabbed item, landing at the start of the next one', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a', 'b'] },
          { id: 'step-2', itemIds: ['solo'] },
          { id: 'step-3', itemIds: ['x'] },
        ],
        containerId: 'step-2',
        index: 0,
        direction: 'down',
      });
      expect(target).toEqual({ containerId: 'step-3', index: 0 });
    });

    it('crosses into an empty container when moving down', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: ['a', 'b'] },
          { id: 'step-2', itemIds: [] },
        ],
        containerId: 'step-1',
        index: 1,
        direction: 'down',
      });
      expect(target).toEqual({ containerId: 'step-2', index: 0 });
    });

    it('crosses into an empty container when moving up', () => {
      const target = planKeyboardMove({
        containers: [
          { id: 'step-1', itemIds: [] },
          { id: 'step-2', itemIds: ['a', 'b'] },
        ],
        containerId: 'step-2',
        index: 0,
        direction: 'up',
      });
      expect(target).toEqual({ containerId: 'step-1', index: 0 });
    });

    it('returns null when the container id is not found', () => {
      const target = planKeyboardMove({
        containers: [{ id: 'step-1', itemIds: ['a'] }],
        containerId: 'missing',
        index: 0,
        direction: 'up',
      });
      expect(target).toBeNull();
    });

    it('returns null when the index is out of range for its container', () => {
      const target = planKeyboardMove({
        containers: [{ id: 'step-1', itemIds: ['a'] }],
        containerId: 'step-1',
        index: 5,
        direction: 'up',
      });
      expect(target).toBeNull();
    });
  });

  describe('resolveLabel', () => {
    it('finds nothing in nothing', () => {
      expect(resolveLabel(null)).toBeNull();
    });

    it('prefers a step label over a script name nested inside it', () => {
      const card = document.createElement('div');
      card.innerHTML =
        '<span class="step-label">Paso 1</span><div class="prescript-row"><strong>build</strong></div>';
      expect(resolveLabel(card)).toBe('Paso 1');
    });

    it('falls back through the row shapes to a plain strong', () => {
      const card = document.createElement('div');
      card.innerHTML = '<strong>  build  </strong>';
      expect(resolveLabel(card)).toBe('build');
    });

    it('reports nothing when no shape carries a name', () => {
      const card = document.createElement('div');
      card.innerHTML = '<span>sin nombre</span>';
      expect(resolveLabel(card)).toBeNull();
    });
  });

  describe('the drag handle', () => {
    it('becomes a focusable button for the keyboard', () => {
      wire({ 'list-1': ['a'] });
      const handle = handleFor('a');
      expect(handle.tabIndex).toBe(0);
      expect(handle.getAttribute('role')).toBe('button');
    });

    it('names itself after the item it reorders', () => {
      wire({ 'list-1': ['a'] });
      expect(handleFor('a').getAttribute('aria-label')).toBe('Reordenar A');
    });

    it('falls back to a generic name for an item with no label', () => {
      const container = document.createElement('div');
      container.dataset.containerId = 'list-1';
      container.innerHTML =
        '<div data-id="x"><span class="drag-handle"></span></div>';
      document.body.appendChild(container);
      attachKeyboardReordering(container, {
        snapshotContainers: () => [{ id: 'list-1', itemIds: ['x'] }],
        containerIdOf: () => 'list-1',
        nameContainer: () => null,
        commit: () => undefined,
      });
      expect(handleFor('x').getAttribute('aria-label')).toBe(
        'Reordenar elemento sin nombre',
      );
    });

    it('points every handle at ONE shared instructions element', () => {
      wire({ 'list-1': ['a', 'b'] });
      const described = handleFor('a').getAttribute('aria-describedby');
      expect(described).toBe('dnd-keyboard-instructions');
      expect(handleFor('b').getAttribute('aria-describedby')).toBe(described);
      expect(
        document.querySelectorAll('#dnd-keyboard-instructions'),
      ).toHaveLength(1);
    });

    it('spells out the keys in that shared element', () => {
      wire({ 'list-1': ['a'] });
      expect(
        document.getElementById('dnd-keyboard-instructions')?.textContent,
      ).toBe(
        'Espacio o Intro para agarrar. Flechas para mover. Espacio o Intro para soltar. Escape para cancelar.',
      );
    });
  });

  describe('grabbing an item', () => {
    it('grabs on Space and says so', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      expect(announced()).toContain('Agarrado «A»');
    });

    it('grabs on Enter too', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('a', 'Enter');
      expect(announced()).toContain('Agarrado «A»');
    });

    it('marks the grabbed card so it reads as being dragged', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      expect(
        document.querySelector('[data-id="a"]')?.classList.contains('dragging'),
      ).toBe(true);
    });

    it('swallows the grab key so the page does not scroll', () => {
      wire({ 'list-1': ['a', 'b'] });
      expect(press('a', ' ').defaultPrevented).toBe(true);
    });

    it('announces through ONE shared polite live region', () => {
      wire({ 'list-1': ['a'] });
      press('a', ' ');
      const region = document.getElementById('dnd-keyboard-announcer');
      expect(region?.getAttribute('aria-live')).toBe('polite');
      expect(region?.getAttribute('role')).toBe('status');
      expect(document.querySelectorAll('#dnd-keyboard-announcer')).toHaveLength(
        1,
      );
    });

    it('ignores every other key while nothing is grabbed', () => {
      wire({ 'list-1': ['a', 'b'] });
      const event = press('a', 'ArrowDown');
      expect(event.defaultPrevented).toBe(false);
      expect(announced()).toBe('');
    });

    it('ignores a keypress that did not come from a handle', () => {
      wire({ 'list-1': ['a', 'b'] });
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
      expect(announced()).toBe('');
    });

    it('ignores a handle in a container nobody registered', () => {
      document.body.innerHTML =
        '<div data-container-id="x"><div data-id="a"><span class="drag-handle"></span></div></div>';
      press('a', ' ');
      expect(announced()).toBe('');
    });

    it('refuses to grab an item the snapshot does not know about', () => {
      const world = build({ 'list-1': ['a'] });
      const container = world.containers[0];
      if (!container) throw new Error('no container');
      attachKeyboardReordering(container, {
        ...adapterFor(world),
        snapshotContainers: () => [{ id: 'list-1', itemIds: [] }],
      });
      press('a', ' ');
      expect(announced()).toBe('');
    });
  });

  describe('moving a grabbed item', () => {
    it('announces the new position on the way down', () => {
      wire({ 'list-1': ['a', 'b', 'c'] });
      press('a', ' ');
      press('a', 'ArrowDown');
      expect(announced()).toBe('Posición 2 de 3.');
    });

    it('announces the new position on the way back up', () => {
      wire({ 'list-1': ['a', 'b', 'c'] });
      press('c', ' ');
      press('c', 'ArrowUp');
      expect(announced()).toBe('Posición 2 de 3.');
    });

    it('names the container when crossing into another one', () => {
      wire({ 'step-1': ['a'], 'step-2': ['x'] }, (id) => `Paso ${id}`);
      press('a', ' ');
      press('a', 'ArrowDown');
      expect(announced()).toBe('Paso step-2, posición 1 de 2.');
    });

    it('says nothing new at the end of the list', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('b', ' ');
      const grabbed = announced();
      press('b', 'ArrowDown');
      expect(announced()).toBe(grabbed);
    });

    it('swallows the arrow keys while grabbed', () => {
      const directions: KeyboardMoveDirection[] = ['down', 'up'];
      wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      for (const direction of directions)
        expect(
          press('a', arrowFor(direction)).defaultPrevented,
          `${direction} should be swallowed`,
        ).toBe(true);
    });

    it('ignores arrows arriving from a different handle', () => {
      wire({ 'list-1': ['a', 'b', 'c'] });
      press('a', ' ');
      press('b', 'ArrowDown');
      expect(announced()).toContain('Agarrado «A»');
    });
  });

  describe('dropping', () => {
    it('commits the move it just planned', () => {
      const world = wire({ 'list-1': ['a', 'b', 'c'] });
      press('a', ' ');
      press('a', 'ArrowDown');
      press('a', 'Enter');
      expect(world.commits).toEqual([
        {
          itemId: 'a',
          containers: [{ id: 'list-1', itemIds: ['b', 'a', 'c'] }],
          from: { containerId: 'list-1', index: 0 },
          to: { containerId: 'list-1', index: 1 },
        },
      ]);
    });

    it('commits a cross-container move with both sides', () => {
      const world = wire({ 'step-1': ['a', 'b'], 'step-2': ['x'] });
      press('b', ' ');
      press('b', 'ArrowDown');
      press('b', 'Enter');
      expect(world.commits[0]?.from).toEqual({
        containerId: 'step-1',
        index: 1,
      });
      expect(world.commits[0]?.to).toEqual({ containerId: 'step-2', index: 0 });
    });

    it('drops on Space as well as Enter', () => {
      const world = wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      press('a', 'ArrowDown');
      press('a', ' ');
      expect(world.commits).toHaveLength(1);
    });

    it('writes nothing when the item never left its place', () => {
      const world = wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      press('a', 'ArrowUp');
      press('a', 'Enter');
      expect(world.commits).toEqual([]);
    });

    it('announces where the item landed', () => {
      wire({ 'list-1': ['a', 'b', 'c'] });
      press('a', ' ');
      press('a', 'ArrowDown');
      press('a', 'Enter');
      expect(announced()).toBe('Soltado «A», posición 2 de 3.');
    });

    it('takes the dragging mark off and hands focus back to the handle', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      press('a', 'Enter');
      expect(
        document.querySelector('[data-id="a"]')?.classList.contains('dragging'),
      ).toBe(false);
      expect(document.activeElement).toBe(handleFor('a'));
    });

    it('lets the next grab start from scratch', () => {
      const world = wire({ 'list-1': ['a', 'b', 'c'] });
      press('a', ' ');
      press('a', 'Enter');
      press('c', ' ');
      press('c', 'ArrowUp');
      press('c', 'Enter');
      expect(world.commits).toHaveLength(1);
      expect(world.commits[0]?.itemId).toBe('c');
    });
  });

  describe('cancelling', () => {
    it('writes nothing and says the item went back', () => {
      const world = wire({ 'list-1': ['a', 'b', 'c'] });
      press('a', ' ');
      press('a', 'ArrowDown');
      press('a', 'Escape');
      expect(world.commits).toEqual([]);
      expect(announced()).toBe('Cancelado. «A» vuelve a su posición original.');
    });

    it('takes the dragging mark off', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      press('a', 'Escape');
      expect(
        document.querySelector('[data-id="a"]')?.classList.contains('dragging'),
      ).toBe(false);
    });

    it('cancels when focus leaves the handle mid-grab', () => {
      const world = wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      press('a', 'ArrowDown');
      handleFor('a').dispatchEvent(
        new FocusEvent('focusout', { bubbles: true }),
      );
      expect(world.commits).toEqual([]);
      expect(announced()).toContain('Cancelado');
    });

    it('ignores focus leaving some other handle', () => {
      wire({ 'list-1': ['a', 'b'] });
      press('a', ' ');
      handleFor('b').dispatchEvent(
        new FocusEvent('focusout', { bubbles: true }),
      );
      expect(announced()).toContain('Agarrado');
    });
  });

  describe('nested lists', () => {
    it('gives the handle to the registered container nearest to it', () => {
      const outer = document.createElement('div');
      outer.dataset.containerId = 'outer';
      const inner = document.createElement('div');
      inner.dataset.containerId = 'inner';
      inner.innerHTML =
        '<div data-id="script"><span class="drag-handle"></span><strong>Script</strong></div>';
      const outerCard = document.createElement('div');
      outerCard.dataset.id = 'step';
      outerCard.appendChild(inner);
      outer.appendChild(outerCard);
      document.body.appendChild(outer);

      const outerCommit = vi.fn();
      const innerCommit = vi.fn();
      const base: Omit<KeyboardReorderAdapter, 'commit' | 'containerIdOf'> = {
        snapshotContainers: () => [
          { id: 'outer', itemIds: ['step'] },
          { id: 'inner', itemIds: ['script', 'other'] },
        ],
        nameContainer: () => null,
      };
      attachKeyboardReordering(outer, {
        ...base,
        containerIdOf: () => 'outer',
        commit: outerCommit,
      });
      attachKeyboardReordering(inner, {
        ...base,
        containerIdOf: () => 'inner',
        commit: innerCommit,
      });

      press('script', ' ');
      press('script', 'ArrowDown');
      press('script', 'Enter');
      expect(innerCommit).toHaveBeenCalledTimes(1);
      expect(outerCommit).not.toHaveBeenCalled();
    });

    it('re-registering a container just swaps its adapter', () => {
      const world = wire({ 'list-1': ['a', 'b'] });
      const second: Commit[] = [];
      const container = world.containers[0];
      if (!container) throw new Error('no container');
      attachKeyboardReordering(container, {
        ...adapterFor(world),
        commit: (itemId, containers, from, to) => {
          second.push({ itemId, containers, from, to });
        },
      });
      press('a', ' ');
      press('a', 'ArrowDown');
      press('a', 'Enter');
      expect(world.commits).toEqual([]);
      expect(second).toHaveLength(1);
    });
  });
});
