/**
 * dnd-helper.js — shared drag-and-drop reorder utility.
 *
 * Usage:
 *   attachDragHandlers(container, items, onReorder)
 *
 * - container: the parent DOM element that holds the draggable cards
 * - items: (unused) — the function reads children from container at event time
 * - onReorder: async (orderedIds: string[]) => void — called with new order after drop
 *
 * Each child card MUST have:
 *   - dataset.id = the item id
 *   - a child with class "drag-handle" that acts as the grip
 */

let dragSourceId = null;
let dragContainer = null;

function cssEscape(s) {
  return String(s).replace(/(["\\\[\]:.#])/g, '\\$1');
}

function clearDragVisuals(container) {
  for (const n of container.querySelectorAll('.drag-over-before, .drag-over-after, .dragging')) {
    n.classList.remove('drag-over-before', 'drag-over-after', 'dragging');
  }
}

/**
 * Attach drag handlers to all current AND future children of `container`.
 * Uses event delegation: listeners go on the container itself.
 * The grip is the element with class `drag-handle` inside each card.
 *
 * @param {HTMLElement} container
 * @param {Function} onReorder - async (orderedIds: string[]) => void
 */
function attachDragHandlers(container, onReorder) {
  // ── dragstart (via handle) ───────────────────────────────────────────
  container.addEventListener('dragstart', (e) => {
    // Only start if the drag originated from a .drag-handle inside a [data-id] card
    const handle = e.target.closest('.drag-handle');
    if (!handle) { e.preventDefault(); return; }
    const card = handle.closest('[data-id]');
    if (!card) { e.preventDefault(); return; }

    dragSourceId = card.dataset.id;
    dragContainer = container;
    card.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSourceId);
      try { e.dataTransfer.setDragImage(card, 20, 20); } catch (_) {}
    }
  });

  // ── dragend ───────────────────────────────────────────────────────────
  container.addEventListener('dragend', () => {
    dragSourceId = null;
    dragContainer = null;
    clearDragVisuals(container);
  });

  // ── dragover (drop target indicator) ─────────────────────────────────
  container.addEventListener('dragover', (e) => {
    if (!dragSourceId || dragContainer !== container) return;
    const card = e.target.closest('[data-id]');
    if (!card || card.dataset.id === dragSourceId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    // Clear indicators on siblings first
    for (const c of container.querySelectorAll('[data-id]')) {
      if (c !== card) c.classList.remove('drag-over-before', 'drag-over-after');
    }
    if (before) {
      card.classList.add('drag-over-before');
      card.classList.remove('drag-over-after');
    } else {
      card.classList.add('drag-over-after');
      card.classList.remove('drag-over-before');
    }
  });

  // ── dragleave ─────────────────────────────────────────────────────────
  container.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    // Only remove if we actually left the card (not entered a child)
    if (card.contains(e.relatedTarget)) return;
    card.classList.remove('drag-over-before', 'drag-over-after');
  });

  // ── drop ─────────────────────────────────────────────────────────────
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const sourceId = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || dragSourceId;
    const targetCard = e.target.closest('[data-id]');
    if (!targetCard || !sourceId || sourceId === targetCard.dataset.id) {
      clearDragVisuals(container);
      return;
    }
    const targetId = targetCard.dataset.id;
    const rect = targetCard.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    clearDragVisuals(container);

    const cards = Array.from(container.querySelectorAll('[data-id]'));
    const ids = cards.map((c) => c.dataset.id);
    const fromIdx = ids.indexOf(sourceId);
    if (fromIdx < 0) return;
    ids.splice(fromIdx, 1);
    const insertIdx = ids.indexOf(targetId);
    if (insertIdx < 0) return;
    ids.splice(before ? insertIdx : insertIdx + 1, 0, sourceId);

    // Optimistic DOM reorder
    const draggedCard = container.querySelector(`[data-id="${cssEscape(sourceId)}"]`);
    if (draggedCard) {
      if (before) container.insertBefore(draggedCard, targetCard);
      else container.insertBefore(draggedCard, targetCard.nextSibling);
    }

    try {
      await onReorder(ids);
    } catch (err) {
      console.error('Reorder failed:', err);
    }
  });
}

// CommonJS export (renderer context)
if (typeof module !== 'undefined') {
  module.exports = { attachDragHandlers };
}
