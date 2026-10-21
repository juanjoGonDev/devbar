import { attachKeyboardReordering } from './tray/dnd-keyboard.js';

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
        // Own children only: a card can hold a nested list whose rows also
        // carry `data-id`, and counting those would compute positions
        // against a list that is not this one.
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

// ── Direct-child lookups shared by the pointer and keyboard paths ───────

/**
 * The `[data-id]` card that is a DIRECT CHILD of `container`, or `null`.
 *
 * A reorderable list's items are its own children, and `closest()` happily
 * walks past the container into whatever encloses it. When a card holds a
 * nested list whose rows also carry `data-id`, an unscoped lookup resolves a
 * drag hovering a nested row to THAT ROW — drawing an insertion line inside
 * the card, feeding nested ids into the outer reorder, and handing
 * `insertBefore` a node that is not a child of the container (a DOM
 * NotFoundError).
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
