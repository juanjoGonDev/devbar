import { describe, it, expect } from 'vitest';
import {
  computeCrossContainerIndex,
  planKeyboardMove,
} from '../renderer/dnd-helper.js';

/**
 * dnd-helper.test.ts
 *
 * `computeCrossContainerIndex` is the pure index-math seam for cross-
 * container drag-and-drop (D8): the DOM-wiring half (`attachCrossContainer-
 * DragHandlers`) has no jsdom in this repo's test runner (`vitest.config.ts`
 * declares no environment), matching the pre-existing, untested
 * `attachDragHandlers` in this same module.
 */

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

/**
 * `planKeyboardMove` is the pure index-math seam for keyboard grab-and-move
 * reordering (WCAG 2.1.1): the DOM-wiring half (grab/arrow/drop/cancel key
 * handling inside `attachDragHandlers`/`attachCrossContainerDragHandlers`)
 * has no jsdom in this suite, same precedent as `computeCrossContainerIndex`
 * above. `containers` is the zone's containers in top-to-bottom order — a
 * single-entry array for a plain single-container list, or every sibling
 * container sharing a cross-container zone.
 */
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
