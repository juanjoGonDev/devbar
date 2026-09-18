// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachCrossContainerDragHandlers,
  attachDragHandlers,
  computeCrossContainerIndex,
  type CrossContainerMove,
} from '../renderer/dnd-helper.js';

/**
 * dnd-helper.test.ts
 *
 * `computeCrossContainerIndex` is the pure index-math seam for cross-
 * container drag-and-drop (D8). The DOM-wiring half around it runs here too,
 * under jsdom: jsdom ships no `DragEvent`/`DataTransfer`, so the smallest
 * stand-ins the module actually touches are defined below. The keyboard half
 * of the same helpers lives in `tests/dnd-keyboard.test.ts`.
 */

class FakeDataTransfer {
  effectAllowed = '';
  dropEffect = '';
  dragImage: Element | null = null;
  private readonly store = new Map<string, string>();
  setData(type: string, value: string): void {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.store.get(type) ?? '';
  }
  setDragImage(image: Element): void {
    this.dragImage = image;
  }
}

interface FakeDragEventInit extends MouseEventInit {
  dataTransfer?: FakeDataTransfer | null;
}

class FakeDragEvent extends MouseEvent {
  readonly dataTransfer: FakeDataTransfer | null;
  constructor(type: string, init: FakeDragEventInit = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
  }
}

// The handlers all begin with `event instanceof DragEvent`, which is a plain
// global lookup at dispatch time — defining it here is enough.
(globalThis as unknown as { DragEvent: unknown }).DragEvent = FakeDragEvent;

/** Cards have no layout in jsdom, so the drop midpoint has to be declared. */
function stubCardRect(card: Element, top = 0, height = 20): void {
  Object.defineProperty(card, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

describe('renderer/dnd-helper.ts', () => {
  let transfer: FakeDataTransfer;

  beforeEach(() => {
    document.body.innerHTML = '';
    transfer = new FakeDataTransfer();
  });

  afterEach(() => {
    // The drag state is a module-level singleton; end any drag a test left open.
    document.dispatchEvent(new FakeDragEvent('dragend', { bubbles: true }));
    for (const handle of document.querySelectorAll<HTMLElement>('.drag-handle'))
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    document.body.innerHTML = '';
  });

  function buildList(
    itemIds: readonly string[],
    options: { containerId?: string } = {},
  ): HTMLElement {
    const container = document.createElement('div');
    if (options.containerId)
      container.dataset.containerId = options.containerId;
    itemIds.forEach((itemId, index) => {
      const card = document.createElement('div');
      card.dataset.id = itemId;
      stubCardRect(card, index * 20);
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      card.appendChild(handle);
      const name = document.createElement('strong');
      name.textContent = itemId.toUpperCase();
      card.appendChild(name);
      container.appendChild(card);
    });
    document.body.appendChild(container);
    return container;
  }

  function cardIn(container: HTMLElement, itemId: string): HTMLElement {
    const card = container.querySelector<HTMLElement>(`[data-id="${itemId}"]`);
    if (!card) throw new Error(`no card ${itemId}`);
    return card;
  }

  function handleIn(container: HTMLElement, itemId: string): HTMLElement {
    const handle = cardIn(container, itemId).querySelector<HTMLElement>(
      '.drag-handle',
    );
    if (!handle) throw new Error(`no handle for ${itemId}`);
    return handle;
  }

  function fire(
    target: Element,
    type: string,
    init: FakeDragEventInit = {},
  ): FakeDragEvent {
    const event = new FakeDragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }

  function orderOf(container: HTMLElement): string[] {
    return Array.from(
      container.children,
      (node) => (node as HTMLElement).dataset.id ?? '',
    );
  }

  function pressKey(handle: HTMLElement, key: string): void {
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  describe('computeCrossContainerIndex', () => {
    it('appends into an empty container (index 0)', () => {
      const index = computeCrossContainerIndex({
        targetIds: [],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-2',
        itemId: 'script-a',
        targetCardId: null,
        before: false,
      });
      expect(index).toBe(0);
    });

    it('appends when the drop lands on the container itself, not on a card (index = targetIds.length)', () => {
      const index = computeCrossContainerIndex({
        targetIds: ['script-x', 'script-y'],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-2',
        itemId: 'script-a',
        targetCardId: null,
        before: false,
      });
      expect(index).toBe(2);
    });

    it('inserts before the target card in a cross-container move', () => {
      const index = computeCrossContainerIndex({
        targetIds: ['script-x', 'script-y'],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-2',
        itemId: 'script-a',
        targetCardId: 'script-y',
        before: true,
      });
      expect(index).toBe(1);
    });

    it('inserts after the target card in a cross-container move', () => {
      const index = computeCrossContainerIndex({
        targetIds: ['script-x', 'script-y'],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-2',
        itemId: 'script-a',
        targetCardId: 'script-x',
        before: false,
      });
      expect(index).toBe(1);
    });

    it('same-container reorder: computes the index AFTER removing the dragged item', () => {
      // Dragging "script-a" from index 0 to after "script-c": the DOM's raw
      // targetIds still include "script-a" at index 0, so the index must be
      // computed against the list with it already removed, or the result
      // would be off by one.
      const index = computeCrossContainerIndex({
        targetIds: ['script-a', 'script-b', 'script-c'],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-1',
        itemId: 'script-a',
        targetCardId: 'script-c',
        before: false,
      });
      expect(index).toBe(2);
    });

    it('same-container reorder before the target also accounts for the removed item', () => {
      const index = computeCrossContainerIndex({
        targetIds: ['script-a', 'script-b', 'script-c'],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-1',
        itemId: 'script-c',
        targetCardId: 'script-a',
        before: true,
      });
      expect(index).toBe(0);
    });

    it('a cross-container move does NOT remove the item from targetIds (it is not there yet)', () => {
      // Cross-container: itemId belongs to a DIFFERENT container's list, so it
      // must never be found/removed from the target's own targetIds.
      const index = computeCrossContainerIndex({
        targetIds: ['script-b', 'script-c'],
        sourceContainerId: 'step-1',
        targetContainerId: 'step-2',
        itemId: 'script-b', // same id string can coincidentally collide; must not be treated as "already there"
        targetCardId: 'script-c',
        before: false,
      });
      expect(index).toBe(2);
    });
  });

  describe('attachDragHandlers', () => {
    it('carries the dragged id in the drag payload', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      expect(transfer.getData('text/plain')).toBe('a');
      expect(transfer.effectAllowed).toBe('move');
    });

    it('marks the card as dragging and uses it as the drag image', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      expect(cardIn(container, 'a').classList.contains('dragging')).toBe(true);
      expect(transfer.dragImage).toBe(cardIn(container, 'a'));
    });

    it('refuses a drag that did not start on a handle', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      const event = fire(cardIn(container, 'a'), 'dragstart');
      expect(event.defaultPrevented).toBe(true);
      expect(cardIn(container, 'a').classList.contains('dragging')).toBe(false);
    });

    it('starts a drag even when the browser gives no dataTransfer', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart', { dataTransfer: null });
      expect(cardIn(container, 'a').classList.contains('dragging')).toBe(true);
    });

    it('draws the insertion line above a card the pointer is over its top half', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'b'), 'dragover', { clientY: 22 });
      expect(
        cardIn(container, 'b').classList.contains('drag-over-before'),
      ).toBe(true);
    });

    it('draws it below when the pointer is past the middle', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'b'), 'dragover', { clientY: 38 });
      expect(cardIn(container, 'b').classList.contains('drag-over-after')).toBe(
        true,
      );
    });

    it('accepts the drop by cancelling the dragover', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      const event = fire(cardIn(container, 'b'), 'dragover', { clientY: 22 });
      expect(event.defaultPrevented).toBe(true);
      expect(transfer.dropEffect).toBe('move');
    });

    it('ignores a dragover on the card being dragged', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      const event = fire(cardIn(container, 'a'), 'dragover', { clientY: 5 });
      expect(event.defaultPrevented).toBe(false);
    });

    it('ignores a dragover when no drag of its own is in flight', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      const event = fire(cardIn(container, 'b'), 'dragover', { clientY: 22 });
      expect(event.defaultPrevented).toBe(false);
    });

    it('drops the indicator when the pointer leaves the card', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'b'), 'dragover', { clientY: 22 });
      fire(cardIn(container, 'b'), 'dragleave');
      expect(
        cardIn(container, 'b').classList.contains('drag-over-before'),
      ).toBe(false);
    });

    it('keeps it while the pointer only moves between the card’s own children', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'b'), 'dragover', { clientY: 22 });
      fire(cardIn(container, 'b'), 'dragleave', {
        relatedTarget: handleIn(container, 'b'),
      });
      expect(
        cardIn(container, 'b').classList.contains('drag-over-before'),
      ).toBe(true);
    });

    it('reorders the list and reports the new order', () => {
      const container = buildList(['a', 'b', 'c']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'c'), 'drop', { clientY: 58 });
      expect(orders).toEqual([['b', 'c', 'a']]);
      expect(orderOf(container)).toEqual(['b', 'c', 'a']);
    });

    it('drops a card above the one it landed on', () => {
      const container = buildList(['a', 'b', 'c']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      fire(handleIn(container, 'c'), 'dragstart');
      fire(cardIn(container, 'a'), 'drop', { clientY: 2 });
      expect(orders).toEqual([['c', 'a', 'b']]);
      expect(orderOf(container)).toEqual(['c', 'a', 'b']);
    });

    it('falls back to the in-flight id when the payload is empty', () => {
      const container = buildList(['a', 'b']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      fire(handleIn(container, 'a'), 'dragstart', { dataTransfer: null });
      fire(cardIn(container, 'b'), 'drop', {
        clientY: 38,
        dataTransfer: null,
      });
      expect(orders).toEqual([['b', 'a']]);
    });

    it('reports ONE reorder per drop however many times the list re-rendered', () => {
      // Callers re-render their list and call attachDragHandlers again on the
      // same persistent container. Adding the pointer listeners per render
      // made one drop fire onReorder once per render since the window opened,
      // costing a reorder round trip and a full reload each time.
      const container = buildList(['a', 'b']);
      const orders: string[][] = [];
      const onReorder = (ids: string[]): void => {
        orders.push([...ids]);
      };
      attachDragHandlers(container, onReorder);
      attachDragHandlers(container, onReorder);
      attachDragHandlers(container, onReorder);
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'b'), 'drop', { clientY: 38 });
      expect(orders).toEqual([['b', 'a']]);
    });

    it('calls the newest callback after a re-render, not the first one', () => {
      const container = buildList(['a', 'b']);
      const seen: string[] = [];
      attachDragHandlers(container, () => seen.push('stale'));
      attachDragHandlers(container, () => seen.push('current'));
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'b'), 'drop', { clientY: 38 });
      expect(seen).toEqual(['current']);
    });

    it('writes nothing when the drop lands on the dragged card itself', () => {
      const container = buildList(['a', 'b']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      fire(handleIn(container, 'a'), 'dragstart');
      fire(cardIn(container, 'a'), 'drop', { clientY: 5 });
      expect(orders).toEqual([]);
      expect(cardIn(container, 'a').classList.contains('dragging')).toBe(false);
    });

    it('writes nothing when the drop misses every card', () => {
      const container = buildList(['a', 'b']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      fire(handleIn(container, 'a'), 'dragstart');
      fire(container, 'drop', { clientY: 5 });
      expect(orders).toEqual([]);
    });

    it('writes nothing when the dragged id is not in this list', () => {
      const container = buildList(['a', 'b']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      fire(handleIn(container, 'a'), 'dragstart');
      transfer.setData('text/plain', 'ghost');
      fire(cardIn(container, 'b'), 'drop', { clientY: 22 });
      expect(orders).toEqual([]);
    });

    it('clears the dragging mark when the drag ends without a drop', () => {
      const container = buildList(['a', 'b']);
      attachDragHandlers(container, () => undefined);
      fire(handleIn(container, 'a'), 'dragstart');
      fire(container, 'dragend');
      expect(cardIn(container, 'a').classList.contains('dragging')).toBe(false);
    });

    it('logs a reorder the caller could not persist', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const container = buildList(['a', 'b']);
        attachDragHandlers(container, () => Promise.reject(new Error('nope')));
        fire(handleIn(container, 'a'), 'dragstart');
        fire(cardIn(container, 'b'), 'drop', { clientY: 38 });
        await Promise.resolve();
        await Promise.resolve();
        expect(error).toHaveBeenCalledWith(
          'Reorder failed:',
          expect.anything(),
        );
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('a drag never resolves a card outside its own list', () => {
    function nestedLists(): { steps: HTMLElement; scripts: HTMLElement } {
      const steps = buildList(['step-1']);
      const scripts = document.createElement('div');
      scripts.dataset.containerId = 'step-1';
      for (const scriptId of ['script-a', 'script-b']) {
        const row = document.createElement('div');
        row.dataset.id = scriptId;
        stubCardRect(row);
        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        row.appendChild(handle);
        scripts.appendChild(row);
      }
      cardIn(steps, 'step-1').appendChild(scripts);
      return { steps, scripts };
    }

    it('reorders the steps, never the script rows nested inside them', () => {
      const { steps } = nestedLists();
      const second = document.createElement('div');
      second.dataset.id = 'step-2';
      stubCardRect(second, 20);
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      second.appendChild(handle);
      steps.appendChild(second);

      const orders: string[][] = [];
      attachDragHandlers(steps, (ids) => orders.push([...ids]));
      fire(handleIn(steps, 'step-2'), 'dragstart');
      // The pointer is over a SCRIPT row, which lives inside step-1's card.
      fire(
        steps.querySelector<HTMLElement>('[data-id="script-a"]') ?? steps,
        'drop',
        { clientY: 2 },
      );
      expect(orders).toEqual([['step-2', 'step-1']]);
    });

    it('never feeds nested ids into a step reorder', () => {
      const { steps } = nestedLists();
      const second = document.createElement('div');
      second.dataset.id = 'step-2';
      stubCardRect(second, 20);
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      second.appendChild(handle);
      steps.appendChild(second);

      const orders: string[][] = [];
      attachDragHandlers(steps, (ids) => orders.push([...ids]));
      fire(handleIn(steps, 'step-2'), 'dragstart');
      fire(cardIn(steps, 'step-1'), 'drop', { clientY: 2 });
      expect(orders[0]).not.toContain('script-a');
    });
  });

  describe('attachCrossContainerDragHandlers', () => {
    function zone(): { first: HTMLElement; second: HTMLElement } {
      const first = buildList(['x', 'y'], { containerId: 'step-1' });
      const second = buildList(['z'], { containerId: 'step-2' });
      return { first, second };
    }

    it('records the zone on the container for the keyboard path', () => {
      const { first } = zone();
      attachCrossContainerDragHandlers(first, 'scripts', () => undefined);
      expect(first.dataset.dndZone).toBe('scripts');
    });

    it('carries the dragged id and stops the enclosing list seeing the drag', () => {
      const { first } = zone();
      attachCrossContainerDragHandlers(first, 'scripts', () => undefined);
      const outer = vi.fn();
      document.body.addEventListener('dragstart', outer);
      fire(handleIn(first, 'x'), 'dragstart');
      document.body.removeEventListener('dragstart', outer);
      expect(transfer.getData('text/plain')).toBe('x');
      expect(outer).not.toHaveBeenCalled();
    });

    it('refuses a drag that did not start on a handle', () => {
      const { first } = zone();
      attachCrossContainerDragHandlers(first, 'scripts', () => undefined);
      const event = fire(cardIn(first, 'x'), 'dragstart');
      expect(event.defaultPrevented).toBe(true);
    });

    it('lights the whole target container while a valid drag is over it', () => {
      const { first, second } = zone();
      const moves: CrossContainerMove[] = [];
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', (move) =>
          moves.push(move),
        );
      fire(handleIn(first, 'x'), 'dragstart');
      fire(cardIn(second, 'z'), 'dragover', { clientY: 2 });
      expect(second.classList.contains('drop-into')).toBe(true);
    });

    it('offers an append drop when the pointer is over bare container background', () => {
      const { first, second } = zone();
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', () => undefined);
      fire(handleIn(first, 'x'), 'dragstart');
      fire(second, 'dragover', { clientY: 2 });
      expect(second.classList.contains('drop-zone-active')).toBe(true);
    });

    it('ignores a drag from a different zone', () => {
      const { first, second } = zone();
      attachCrossContainerDragHandlers(first, 'scripts', () => undefined);
      attachCrossContainerDragHandlers(second, 'otra-zona', () => undefined);
      fire(handleIn(first, 'x'), 'dragstart');
      const event = fire(cardIn(second, 'z'), 'dragover', { clientY: 2 });
      expect(event.defaultPrevented).toBe(false);
    });

    it('clears the affordances when the pointer leaves the container', () => {
      const { first, second } = zone();
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', () => undefined);
      fire(handleIn(first, 'x'), 'dragstart');
      fire(second, 'dragover', { clientY: 2 });
      fire(second, 'dragleave');
      expect(second.classList.contains('drop-zone-active')).toBe(false);
      expect(second.classList.contains('drop-into')).toBe(false);
    });

    it('keeps them while the pointer stays inside the container', () => {
      const { first, second } = zone();
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', () => undefined);
      fire(handleIn(first, 'x'), 'dragstart');
      fire(second, 'dragover', { clientY: 2 });
      fire(second, 'dragleave', { relatedTarget: cardIn(second, 'z') });
      expect(second.classList.contains('drop-into')).toBe(true);
    });

    it('moves an item into another container at the dropped position', () => {
      const { first, second } = zone();
      const moves: CrossContainerMove[] = [];
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', (move) =>
          moves.push(move),
        );
      fire(handleIn(first, 'x'), 'dragstart');
      fire(cardIn(second, 'z'), 'drop', { clientY: 2 });
      expect(moves).toEqual([
        {
          sourceContainerId: 'step-1',
          targetContainerId: 'step-2',
          itemId: 'x',
          index: 0,
        },
      ]);
    });

    it('appends when the drop lands on the container background', () => {
      const { first, second } = zone();
      const moves: CrossContainerMove[] = [];
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', (move) =>
          moves.push(move),
        );
      fire(handleIn(first, 'y'), 'dragstart');
      fire(second, 'drop', { clientY: 2 });
      expect(moves[0]?.index).toBe(1);
    });

    it('degrades to a reorder inside one container', () => {
      const { first } = zone();
      const moves: CrossContainerMove[] = [];
      attachCrossContainerDragHandlers(first, 'scripts', (move) =>
        moves.push(move),
      );
      fire(handleIn(first, 'x'), 'dragstart');
      fire(cardIn(first, 'y'), 'drop', { clientY: 38 });
      expect(moves[0]).toEqual({
        sourceContainerId: 'step-1',
        targetContainerId: 'step-1',
        itemId: 'x',
        index: 1,
      });
    });

    it('writes nothing when an item is dropped back onto itself', () => {
      const { first } = zone();
      const moves: CrossContainerMove[] = [];
      attachCrossContainerDragHandlers(first, 'scripts', (move) =>
        moves.push(move),
      );
      fire(handleIn(first, 'x'), 'dragstart');
      fire(cardIn(first, 'x'), 'drop', { clientY: 2 });
      expect(moves).toEqual([]);
    });

    it('ignores a drop with no drag of its zone in flight', () => {
      const { first } = zone();
      const moves: CrossContainerMove[] = [];
      attachCrossContainerDragHandlers(first, 'scripts', (move) =>
        moves.push(move),
      );
      const event = fire(cardIn(first, 'y'), 'drop', { clientY: 2 });
      expect(event.defaultPrevented).toBe(false);
      expect(moves).toEqual([]);
    });

    it('clears every affordance when the drag ends without a drop', () => {
      const { first, second } = zone();
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', () => undefined);
      fire(handleIn(first, 'x'), 'dragstart');
      fire(second, 'dragover', { clientY: 2 });
      fire(second, 'dragend');
      expect(second.classList.contains('drop-zone-active')).toBe(false);
      expect(second.classList.contains('drop-into')).toBe(false);
    });

    it('logs a move the caller could not persist', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { first, second } = zone();
        for (const container of [first, second])
          attachCrossContainerDragHandlers(container, 'scripts', () =>
            Promise.reject(new Error('nope')),
          );
        fire(handleIn(first, 'x'), 'dragstart');
        fire(cardIn(second, 'z'), 'drop', { clientY: 2 });
        await Promise.resolve();
        await Promise.resolve();
        expect(error).toHaveBeenCalledWith(
          'Cross-container move failed:',
          expect.anything(),
        );
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('keyboard reordering reaches the same callbacks', () => {
    it('reorders a plain list from the keyboard', () => {
      const container = buildList(['a', 'b', 'c']);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      const handle = handleIn(container, 'a');
      pressKey(handle, ' ');
      pressKey(handle, 'ArrowDown');
      pressKey(handle, 'Enter');
      expect(orders).toEqual([['b', 'a', 'c']]);
    });

    it('counts only its own children when planning that move', () => {
      const container = buildList(['a', 'b']);
      const nested = document.createElement('div');
      nested.dataset.id = 'nested';
      cardIn(container, 'a').appendChild(nested);
      const orders: string[][] = [];
      attachDragHandlers(container, (ids) => orders.push([...ids]));
      const handle = handleIn(container, 'a');
      pressKey(handle, ' ');
      pressKey(handle, 'ArrowDown');
      pressKey(handle, 'Enter');
      expect(orders).toEqual([['b', 'a']]);
    });

    it('crosses containers from the keyboard', () => {
      const first = buildList(['x'], { containerId: 'step-1' });
      const second = buildList(['z'], { containerId: 'step-2' });
      const moves: CrossContainerMove[] = [];
      for (const container of [first, second])
        attachCrossContainerDragHandlers(container, 'scripts', (move) =>
          moves.push(move),
        );
      const handle = handleIn(first, 'x');
      pressKey(handle, ' ');
      pressKey(handle, 'ArrowDown');
      pressKey(handle, 'Enter');
      expect(moves).toEqual([
        {
          sourceContainerId: 'step-1',
          targetContainerId: 'step-2',
          itemId: 'x',
          index: 0,
        },
      ]);
    });

    it('announces the step a crossing item landed in by name', () => {
      const steps = buildList(['step-1', 'step-2']);
      const lists: HTMLElement[] = [];
      for (const stepId of ['step-1', 'step-2']) {
        const stepCard = cardIn(steps, stepId);
        const label = document.createElement('span');
        label.className = 'step-label';
        label.textContent = `Paso ${stepId.slice(-1)}`;
        stepCard.insertBefore(label, stepCard.firstChild);
        const scripts = buildList(stepId === 'step-1' ? ['s1'] : ['s2'], {
          containerId: stepId,
        });
        stepCard.appendChild(scripts);
        lists.push(scripts);
      }
      for (const container of lists)
        attachCrossContainerDragHandlers(container, 'scripts', () => undefined);
      const list = lists[0];
      if (!list) throw new Error('no script list');
      const handle = handleIn(list, 's1');
      pressKey(handle, ' ');
      pressKey(handle, 'ArrowDown');
      expect(
        document.getElementById('dnd-keyboard-announcer')?.textContent,
      ).toBe('Paso 2, posición 1 de 2.');
    });
  });
});
