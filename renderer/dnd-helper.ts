let dragSourceId: string | null = null;
let dragContainer: HTMLElement | null = null;

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
export function attachDragHandlers(
  container: HTMLElement,
  onReorder: (orderedIds: string[]) => unknown,
): void {
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
    const card = asElement(event.target)?.closest<HTMLElement>('[data-id]');
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
    const card = asElement(event.target)?.closest<HTMLElement>('[data-id]');
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
    const targetCard = asElement(event.target)?.closest<HTMLElement>(
      '[data-id]',
    );
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
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>('[data-id]'),
    );
    const ids = cards
      .map((c) => c.dataset.id)
      .filter((id): id is string => Boolean(id));
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
    Promise.resolve(onReorder(ids)).catch((error: unknown) =>
      console.error('Reorder failed:', error),
    );
  });
}
