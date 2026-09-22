import { attachKeyboardReordering, resolveLabel } from './tray/dnd-keyboard.js';

let dragSourceId: string | null = null;
let dragContainer: HTMLElement | null = null;

/** Sentinel container id for a plain single-container list (used by the
 * keyboard reordering adapter below) — there is only ever one entry in its
 * `containers` array, so the exact string is never compared against a
 * sibling; it only has to be stable within one call. */
const SINGLE_CONTAINER_ID = '__single__';

function asElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}
function clearDragVisuals(container: HTMLElement): void {
  container
    .querySelectorAll<HTMLElement>(
      '.drag-over-before, .drag-over-after, .dragging',
    )
    .forEach((node) =>
      node.classList.remove('drag-over-before', 'drag-over-after', 'dragging'),
    );
}
/**
 * Callers re-render their list and call this again on the SAME persistent
 * container, so the pointer listeners are attached once and the callback is
 * refreshed in place — adding them per render made one drop fire `onReorder`
 * once per render since the window opened, costing N reorder round trips and
 * N full reloads. (`attachKeyboardReordering` below is already idempotent by
 * design: it re-enhances the newly rendered handles every time, which is why
 * the whole function cannot simply be guarded.)
 */
const pointerReorderHandlers = new WeakMap<
  HTMLElement,
  (orderedIds: string[]) => unknown
>();

export function attachDragHandlers(
  container: HTMLElement,
  onReorder: (orderedIds: string[]) => unknown,
): void {
  const alreadyAttached = pointerReorderHandlers.has(container);
  pointerReorderHandlers.set(container, onReorder);
  const reorder = (orderedIds: string[]): void => {
    Promise.resolve(pointerReorderHandlers.get(container)?.(orderedIds)).catch(
      (error: unknown) => console.error('Reorder failed:', error),
    );
  };
  if (alreadyAttached) {
    attachKeyboardReorderingFor(container, reorder);
    return;
  }
  container.addEventListener('dragstart', (event) => {
    if (!(event instanceof DragEvent)) return;
    const handle = asElement(event.target)?.closest<HTMLElement>(
      '.drag-handle',
    );
    const card = handle?.closest<HTMLElement>('[data-id]');
    const id = card?.dataset.id;
    if (!card || !id) {
      event.preventDefault();
      return;
    }
    dragSourceId = id;
    dragContainer = container;
    card.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      try {
        event.dataTransfer.setDragImage(card, 20, 20);
      } catch {}
    }
  });
  container.addEventListener('dragend', () => {
    dragSourceId = null;
    dragContainer = null;
    clearDragVisuals(container);
  });
  container.addEventListener('dragover', (event) => {
    if (
      !(event instanceof DragEvent) ||
      !dragSourceId ||
      dragContainer !== container
    )
      return;
    const card = directChildCard(event.target, container);
    if (!card || card.dataset.id === dragSourceId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    container.querySelectorAll<HTMLElement>('[data-id]').forEach((item) => {
      if (item !== card)
        item.classList.remove('drag-over-before', 'drag-over-after');
    });
    card.classList.toggle('drag-over-before', before);
    card.classList.toggle('drag-over-after', !before);
  });
  container.addEventListener('dragleave', (event) => {
    const card = directChildCard(event.target, container);
    if (!card) return;
    if (
      event.relatedTarget instanceof Node &&
      card.contains(event.relatedTarget)
    )
      return;
    card.classList.remove('drag-over-before', 'drag-over-after');
  });
  container.addEventListener('drop', (event) => {
    if (!(event instanceof DragEvent)) return;
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData('text/plain') || dragSourceId;
    const targetCard = directChildCard(event.target, container);
    const targetId = targetCard?.dataset.id;
    if (!targetCard || !sourceId || !targetId || sourceId === targetId) {
      clearDragVisuals(container);
      return;
    }
    const before =
      event.clientY <
      targetCard.getBoundingClientRect().top +
        targetCard.getBoundingClientRect().height / 2;
    clearDragVisuals(container);
    const cards = Array.from(container.children).filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && Boolean(node.dataset.id),
    );
    const ids = directChildIds(container);
    const from = ids.indexOf(sourceId);
    if (from < 0) return;
    ids.splice(from, 1);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(before ? at : at + 1, 0, sourceId);
    const dragged = cards.find((c) => c.dataset.id === sourceId);
    if (dragged) {
      if (before) container.insertBefore(dragged, targetCard);
      else container.insertBefore(dragged, targetCard.nextSibling);
    }
    reorder(ids);
  });

  attachKeyboardReorderingFor(container, reorder);
}

function attachKeyboardReorderingFor(
  container: HTMLElement,
  reorder: (orderedIds: string[]) => void,
): void {
  attachKeyboardReordering(container, {
    snapshotContainers: () => [
      {
        id: SINGLE_CONTAINER_ID,
        // Own children only: a step card holds a script list whose rows also
        // carry `data-id`, and counting those would compute step positions
        // against a list that is not the step list.
        itemIds: directChildIds(container),
      },
    ],
    containerIdOf: () => SINGLE_CONTAINER_ID,
    nameContainer: () => null,
    commit: (_itemId, containers) => {
      reorder([...(containers[0]?.itemIds ?? [])]);
    },
  });
}

// ── Cross-container drag (pipeline editor: dragging a script between steps) ──
//
// `attachDragHandlers` above is deliberately single-container: its shared
// `dragContainer` check REJECTS a cross-container drop, and it has no way to
// accept a drop on an EMPTY container (no `[data-id]` card to anchor on). The
// pipeline editor needs both, so this is a NEW function rather than a change
// to `attachDragHandlers` — its 4 existing call sites depend on today's
// single-container guard (D8 in the design).

/**
 * The `[data-id]` card that is a DIRECT CHILD of `container`, or `null`.
 *
 * A reorderable list's items are its own children, and `closest()` happily
 * walks past the container into whatever encloses it. Both shapes here nest:
 * a pipeline step card holds a script list whose rows also carry `data-id`,
 * and the step list encloses all of it. An unscoped lookup therefore resolved
 * a step drag hovering a script row to THAT ROW — drawing an insertion line
 * inside a step, which promises a nesting the model does not have, feeding
 * script ids into a step reorder, and handing `insertBefore` a node that is
 * not a child of the container (a DOM NotFoundError).
 */
function directChildCard(
  target: EventTarget | null,
  container: HTMLElement,
): HTMLElement | null {
  let card = asElement(target)?.closest<HTMLElement>('[data-id]') ?? null;
  while (card && card.parentElement !== container) {
    card = card.parentElement?.closest<HTMLElement>('[data-id]') ?? null;
  }
  return card;
}

/** The ids of `container`'s own item children, in DOM order. A reorder payload
 * must never include ids from a nested list. */
function directChildIds(container: HTMLElement): string[] {
  return Array.from(container.children)
    .map((node) => (node instanceof HTMLElement ? node.dataset.id : undefined))
    .filter((id): id is string => Boolean(id));
}

export interface CrossContainerMove {
  sourceContainerId: string;
  targetContainerId: string;
  itemId: string;
  index: number;
}

/**
 * Pure index math for a cross-container (or same-container) drop.
 *
 * - No target card (empty container, or the drop landed on the container
 *   itself rather than a card): append — `targetIds.length`, which is `0`
 *   when the container is empty.
 * - Same container as the source: the dragged item is removed from
 *   `targetIds` FIRST, so a same-container drop degrades cleanly to a
 *   reorder (matching `attachDragHandlers`'s own reorder math).
 * - Cross container: `targetIds` is used as-is — the item is not there yet.
 */
export function computeCrossContainerIndex(input: {
  targetIds: readonly string[];
  sourceContainerId: string;
  targetContainerId: string;
  itemId: string;
  targetCardId: string | null;
  before: boolean;
}): number {
  const {
    targetIds,
    sourceContainerId,
    targetContainerId,
    targetCardId,
    before,
  } = input;
  const ids = [...targetIds];
  if (sourceContainerId === targetContainerId) {
    const sourceIndex = ids.indexOf(input.itemId);
    if (sourceIndex >= 0) ids.splice(sourceIndex, 1);
  }
  if (targetCardId === null) return ids.length;
  const targetIndex = ids.indexOf(targetCardId);
  if (targetIndex < 0) return ids.length;
  return before ? targetIndex : targetIndex + 1;
}

/** Module-level drag state for cross-container drags — separate from
 * `dragSourceId`/`dragContainer` above so a cross-container drag can never be
 * confused with a sibling `attachDragHandlers` container's own drag. */
let crossState: {
  zone: string;
  sourceContainer: HTMLElement;
  sourceId: string;
} | null = null;

/**
 * Wires drag/drop for one container within a named `zone` — only containers
 * sharing the same zone accept drops from each other (e.g. every step's
 * script list in the pipeline editor). The helper never moves DOM nodes
 * itself (D8): the caller re-renders from the write's response, since that
 * write can prune or reject the move.
 */
export function attachCrossContainerDragHandlers(
  container: HTMLElement,
  zone: string,
  onMove: (move: CrossContainerMove) => unknown,
): void {
  // Bookkeeping only — read by the keyboard adapter below to find every
  // sibling container sharing this zone. Nothing in the existing
  // pointer-drag logic reads this attribute.
  container.dataset.dndZone = zone;

  container.addEventListener('dragstart', (event) => {
    if (!(event instanceof DragEvent)) return;
    const handle = asElement(event.target)?.closest<HTMLElement>(
      '.drag-handle',
    );
    const card = handle?.closest<HTMLElement>('[data-id]');
    const id = card?.dataset.id;
    if (!card || !id) {
      event.preventDefault();
      return;
    }
    // These containers are nested inside the step cards that
    // `attachDragHandlers` watches, and both match on `[data-id]`: without
    // this, dragging a script row is also read as dragging its step.
    event.stopPropagation();
    crossState = { zone, sourceContainer: container, sourceId: id };
    card.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      try {
        event.dataTransfer.setDragImage(card, 20, 20);
      } catch {}
    }
  });
  container.addEventListener('dragend', () => {
    crossState = null;
    clearDragVisuals(container);
    container.classList.remove('drop-zone-active');
    container.classList.remove('drop-into');
  });
  container.addEventListener('dragover', (event) => {
    if (
      !(event instanceof DragEvent) ||
      !crossState ||
      crossState.zone !== zone
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    // Whole-card drop-target affordance — active for the entire duration of
    // a valid dragover, on top of (not instead of) the more specific
    // empty-container/insertion-point indicators below.
    container.classList.add('drop-into');
    const card = directChildCard(event.target, container);
    container.querySelectorAll<HTMLElement>('[data-id]').forEach((node) => {
      if (node !== card)
        node.classList.remove('drag-over-before', 'drag-over-after');
    });
    if (!card) {
      // Empty container, or the drop landed on the container's own
      // background rather than a card — the affordance for an append drop.
      container.classList.add('drop-zone-active');
      return;
    }
    container.classList.remove('drop-zone-active');
    if (card.dataset.id === crossState.sourceId) return;
    const rect = card.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    card.classList.toggle('drag-over-before', before);
    card.classList.toggle('drag-over-after', !before);
  });
  container.addEventListener('dragleave', (event) => {
    if (
      event.relatedTarget instanceof Node &&
      container.contains(event.relatedTarget)
    )
      return;
    container.classList.remove('drop-zone-active');
    container.classList.remove('drop-into');
    clearDragVisuals(container);
  });
  container.addEventListener('drop', (event) => {
    if (
      !(event instanceof DragEvent) ||
      !crossState ||
      crossState.zone !== zone
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const state = crossState;
    const sourceId =
      event.dataTransfer?.getData('text/plain') || state.sourceId;
    const targetCard = directChildCard(event.target, container);
    const before = targetCard
      ? event.clientY <
        targetCard.getBoundingClientRect().top +
          targetCard.getBoundingClientRect().height / 2
      : false;
    clearDragVisuals(container);
    container.classList.remove('drop-zone-active');
    container.classList.remove('drop-into');
    crossState = null;
    const sourceContainerId = state.sourceContainer.dataset.containerId || '';
    const targetContainerId = container.dataset.containerId || '';
    const targetCardId = targetCard?.dataset.id ?? null;
    if (targetCardId === sourceId && sourceContainerId === targetContainerId) {
      return; // dropped on itself, in the same container — no-op
    }
    const targetIds = directChildIds(container);
    const index = computeCrossContainerIndex({
      targetIds,
      sourceContainerId,
      targetContainerId,
      itemId: sourceId,
      targetCardId,
      before,
    });
    Promise.resolve(
      onMove({ sourceContainerId, targetContainerId, itemId: sourceId, index }),
    ).catch((error: unknown) =>
      console.error('Cross-container move failed:', error),
    );
  });

  attachKeyboardReordering(container, {
    snapshotContainers: () => {
      const doc = container.ownerDocument;
      return Array.from(doc.querySelectorAll<HTMLElement>('[data-dnd-zone]'))
        .filter((el) => el.dataset.dndZone === zone)
        .map((el) => ({
          id: el.dataset.containerId ?? '',
          itemIds: directChildIds(el),
        }));
    },
    containerIdOf: (card) => {
      const owner = card.closest<HTMLElement>('[data-dnd-zone]');
      return owner?.dataset.containerId ?? '';
    },
    nameContainer: (containerId) => {
      const doc = container.ownerDocument;
      const owner = Array.from(
        doc.querySelectorAll<HTMLElement>('[data-dnd-zone]'),
      ).find((el) => el.dataset.containerId === containerId);
      return resolveLabel(owner?.closest<HTMLElement>('[data-id]') ?? null);
    },
    commit: (itemId, _containers, from, to) => {
      Promise.resolve(
        onMove({
          sourceContainerId: from.containerId,
          targetContainerId: to.containerId,
          itemId,
          index: to.index,
        }),
      ).catch((error: unknown) =>
        console.error('Cross-container move failed:', error),
      );
    },
  });
}
