import { describe, it, expect } from 'vitest';
import { computeCrossContainerIndex } from '../renderer/dnd-helper.js';

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
