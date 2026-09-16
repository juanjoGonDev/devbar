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
    Promise.resolve(onReorder(ids)).catch((error: unknown) =>
      console.error('Reorder failed:', error),
    );
  });

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
      Promise.resolve(onReorder([...(containers[0]?.itemIds ?? [])])).catch(
        (error: unknown) => console.error('Reorder failed:', error),
      );
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

// ─────────────────────────── Keyboard reordering ───────────────────────────
//
// WCAG 2.1.1 (Keyboard): every list above is reachable only by pointer drag.
// This section adds a keyboard-operable "grab and move" path on the SAME
// `.drag-handle` element, wired once here — from inside `attachDragHandlers`
// and `attachCrossContainerDragHandlers` themselves — so all five call sites
// get identical behaviour with no per-call-site key handling.

export interface KeyboardMoveContainer {
  id: string;
  itemIds: readonly string[];
}

export type KeyboardMoveDirection = 'up' | 'down';

export interface PlanKeyboardMoveInput {
  containers: readonly KeyboardMoveContainer[];
  containerId: string;
  index: number;
  direction: KeyboardMoveDirection;
}

export interface KeyboardMoveTarget {
  containerId: string;
  index: number;
}

/**
 * Pure index math for one keyboard-driven reorder step (grab-and-move).
 *
 * - Moving within a container: one step up/down, no boundary crossed.
 * - At a container's top/bottom edge: crosses into the previous/next
 *   container in `containers` ORDER when one exists, landing at its
 *   bottom/top respectively so the crossing feels spatially continuous
 *   (moving up out of the top of container N lands at the bottom of
 *   container N-1, moving down out of the bottom of N lands at the top of
 *   N+1). With no such neighbour the move is impossible (`null`) — matching
 *   a single-container list, which "just stops at the ends".
 */
export function planKeyboardMove(
  input: PlanKeyboardMoveInput,
): KeyboardMoveTarget | null {
  const { containers, containerId, index, direction } = input;
  const containerIndex = containers.findIndex((c) => c.id === containerId);
  if (containerIndex < 0) return null;
  const container = containers[containerIndex];
  if (!container || index < 0 || index >= container.itemIds.length) return null;

  if (direction === 'up') {
    if (index > 0) return { containerId, index: index - 1 };
    const previous = containers[containerIndex - 1];
    if (!previous) return null;
    return { containerId: previous.id, index: previous.itemIds.length };
  }

  if (index < container.itemIds.length - 1)
    return { containerId, index: index + 1 };
  const next = containers[containerIndex + 1];
  if (!next) return null;
  return { containerId: next.id, index: 0 };
}

// ── Keyboard DOM wiring ──────────────────────────────────────────────────
//
// Below this point every function touches `Element`/`Document`, so NONE of
// it runs under `pnpm test` (`vitest.config.ts` declares no DOM environment)
// — it is exercised only by grab/move/drop/cancel wiring called from
// `attachDragHandlers`/`attachCrossContainerDragHandlers`, never at module
// import time, and is verified by direct code inspection rather than a test.
//
// Design choice: unlike pointer drag — whose `drop` handler above physically
// moves the DOM node before its `onReorder`/`onMove` promise settles — the
// keyboard path never mutates list DOM itself, not even at drop. It tracks
// the move purely as data (a working copy of every container's item ids)
// and, on drop, calls the exact same `onReorder`/`onMove` callback the
// pointer path already uses. That callback already re-renders from the
// persisted truth at all five call sites, so the end state is identical to
// a pointer drag's. This generalizes D8's own rationale (never assume an
// optimistic move survives a write that can prune or reject it) to the
// keyboard path, and keeps this untestable surface as small as possible:
// the only DOM writes below are toggling `.dragging`, moving focus, and
// updating the shared announcer's text.

/** Tried in order against an item's (or a container's enclosing) card to
 * find a human-readable label — covers every row shape across the five
 * lists without any call site having to pass a name in. `.step-label` is
 * checked first because a `.prestep-card` (a pipeline step, reordered as a
 * plain single-container item) also CONTAINS nested `.prescript-row strong`
 * script names — checking the step's own label first stops that descent. */
const ITEM_LABEL_SELECTORS = [
  '.step-label',
  '.nav-name',
  '.sub-name',
  'strong',
];

function resolveLabel(root: Element | null): string | null {
  if (!root) return null;
  for (const selector of ITEM_LABEL_SELECTORS) {
    const text = root.querySelector<HTMLElement>(selector)?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

const ANNOUNCER_ID = 'dnd-keyboard-announcer';
const INSTRUCTIONS_ID = 'dnd-keyboard-instructions';
const KEYBOARD_INSTRUCTIONS_TEXT =
  'Espacio o Intro para agarrar. Flechas para mover. Espacio o Intro para soltar. Escape para cancelar.';

/** Finds an existing shared element by id, or creates and appends it once —
 * the "shared aria-live region, created once, not one per list" contract. */
function ensureSharedElement(
  doc: Document,
  id: string,
  configure: (el: HTMLElement) => void,
): HTMLElement {
  const existing = doc.getElementById(id);
  if (existing) return existing;
  const el = doc.createElement('div');
  el.id = id;
  el.className = 'sr-only';
  configure(el);
  doc.body.appendChild(el);
  return el;
}

function announce(doc: Document, message: string): void {
  const region = ensureSharedElement(doc, ANNOUNCER_ID, (el) => {
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
  });
  region.textContent = message;
}

function describedByInstructions(doc: Document): string {
  ensureSharedElement(doc, INSTRUCTIONS_ID, (el) => {
    el.textContent = KEYBOARD_INSTRUCTIONS_TEXT;
  });
  return INSTRUCTIONS_ID;
}

function enhanceHandle(handle: HTMLElement, doc: Document): void {
  handle.tabIndex = 0;
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-describedby', describedByInstructions(doc));
  const name = resolveLabel(handle.closest<HTMLElement>('[data-id]'));
  handle.setAttribute(
    'aria-label',
    `Reordenar ${name ?? 'elemento sin nombre'}`,
  );
}

interface MutableKeyboardContainer {
  id: string;
  itemIds: string[];
}

interface KeyboardReorderAdapter {
  /** Every container in this keyboard interaction, top-to-bottom, resolved
   * fresh at grab time. A plain `attachDragHandlers` list always returns its
   * one container; a cross-container zone returns every sibling sharing it. */
  snapshotContainers(): KeyboardMoveContainer[];
  /** The id of the container a given card currently lives in. */
  containerIdOf(card: HTMLElement): string;
  /** A human-readable name for a container, or `null` for a list with no
   * meaningful container identity (a plain single-container list). */
  nameContainer(containerId: string): string | null;
  /** Commits the planned move through the real pointer-drag callback. Called
   * only when the final position differs from where the grab started. */
  commit(
    itemId: string,
    containers: readonly KeyboardMoveContainer[],
    from: KeyboardMoveTarget,
    to: KeyboardMoveTarget,
  ): void;
}

interface KeyboardGrabState {
  adapter: KeyboardReorderAdapter;
  handle: HTMLElement;
  itemId: string;
  itemName: string;
  originContainerId: string;
  originIndex: number;
  currentContainerId: string;
  currentIndex: number;
  containers: MutableKeyboardContainer[];
}

/** Module-level singleton: at most one row can be keyboard-grabbed anywhere
 * at a time, mirroring `dragSourceId`/`crossState` above. */
let grabbed: KeyboardGrabState | null = null;

function moveGrab(direction: KeyboardMoveDirection, doc: Document): void {
  const state = grabbed;
  if (!state) return;
  const target = planKeyboardMove({
    containers: state.containers,
    containerId: state.currentContainerId,
    index: state.currentIndex,
    direction,
  });
  if (!target) return; // boundary reached — no-op, matching a single-container list
  const from = state.containers.find((c) => c.id === state.currentContainerId);
  if (from) {
    const pos = from.itemIds.indexOf(state.itemId);
    if (pos >= 0) from.itemIds.splice(pos, 1);
  }
  const to = state.containers.find((c) => c.id === target.containerId);
  if (to) to.itemIds.splice(target.index, 0, state.itemId);
  state.currentContainerId = target.containerId;
  state.currentIndex = target.index;
  const total = to ? to.itemIds.length : 1;
  const containerName = state.adapter.nameContainer(target.containerId);
  const position = containerName
    ? `${containerName}, posición ${target.index + 1} de ${total}.`
    : `Posición ${target.index + 1} de ${total}.`;
  announce(doc, position);
}

function dropGrab(doc: Document): void {
  const state = grabbed;
  if (!state) return;
  grabbed = null;
  state.handle.closest<HTMLElement>('[data-id]')?.classList.remove('dragging');
  const moved =
    state.originContainerId !== state.currentContainerId ||
    state.originIndex !== state.currentIndex;
  if (moved) {
    state.adapter.commit(
      state.itemId,
      state.containers,
      { containerId: state.originContainerId, index: state.originIndex },
      { containerId: state.currentContainerId, index: state.currentIndex },
    );
  }
  const total =
    state.containers.find((c) => c.id === state.currentContainerId)?.itemIds
      .length ?? 1;
  announce(
    doc,
    `Soltado «${state.itemName}», posición ${state.currentIndex + 1} de ${total}.`,
  );
  state.handle.focus();
}

function cancelGrab(doc: Document): void {
  const state = grabbed;
  if (!state) return;
  grabbed = null;
  state.handle.closest<HTMLElement>('[data-id]')?.classList.remove('dragging');
  announce(
    doc,
    `Cancelado. «${state.itemName}» vuelve a su posición original.`,
  );
}

/**
 * Registers a container for keyboard reordering.
 *
 * The key listener is attached ONCE PER DOCUMENT, not per container, and the
 * owning container is resolved by walking up from the focused handle. That is
 * deliberate: these containers nest (a pipeline script list lives inside the
 * step list, and both are registered), so a per-container listener meant one
 * keypress reached two of them — the inner one grabbing the row and the outer
 * one reading the very same key as a drop. With a single listener there is no
 * propagation between listeners to reason about, no `stopPropagation` to
 * remember in five branches, and no need to guard against listeners piling up
 * on a container the caller re-registers on every render.
 */
const keyboardAdapters = new WeakMap<HTMLElement, KeyboardReorderAdapter>();
const keyboardWiredDocuments = new WeakSet<Document>();

function attachKeyboardReordering(
  container: HTMLElement,
  adapter: KeyboardReorderAdapter,
): void {
  container
    .querySelectorAll<HTMLElement>('.drag-handle')
    .forEach((handle) => enhanceHandle(handle, container.ownerDocument));

  // Re-registering the same container just refreshes its adapter, so the
  // caller may call this on every render.
  container.dataset.dndKeyboard = 'true';
  keyboardAdapters.set(container, adapter);
  wireDocumentKeyboard(container.ownerDocument);
}

/** The registered container nearest the handle owns it: exactly one wins, by
 * DOM distance, with no dependence on listener order or event propagation. */
function ownerOf(handle: HTMLElement): {
  container: HTMLElement;
  adapter: KeyboardReorderAdapter;
} | null {
  const container = handle.closest<HTMLElement>('[data-dnd-keyboard="true"]');
  const adapter = container ? keyboardAdapters.get(container) : undefined;
  return container && adapter ? { container, adapter } : null;
}

function wireDocumentKeyboard(doc: Document): void {
  if (keyboardWiredDocuments.has(doc)) return;
  keyboardWiredDocuments.add(doc);

  doc.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    const handle = asElement(event.target)?.closest<HTMLElement>(
      '.drag-handle',
    );
    if (!handle) return;
    const owner = ownerOf(handle);
    if (!owner) return;
    const card = handle.closest<HTMLElement>('[data-id]');
    const itemId = card?.dataset.id;
    if (!card || !itemId) return;

    if (!grabbed) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      const containers = owner.adapter.snapshotContainers();
      const containerId = owner.adapter.containerIdOf(card);
      const home = containers.find((c) => c.id === containerId);
      const index = home ? home.itemIds.indexOf(itemId) : -1;
      if (!home || index < 0) return;
      const itemName = resolveLabel(card) ?? 'elemento sin nombre';
      grabbed = {
        adapter: owner.adapter,
        handle,
        itemId,
        itemName,
        originContainerId: containerId,
        originIndex: index,
        currentContainerId: containerId,
        currentIndex: index,
        containers: containers.map((c) => ({
          id: c.id,
          itemIds: [...c.itemIds],
        })),
      };
      card.classList.add('dragging');
      announce(
        doc,
        `Agarrado «${itemName}». Flechas para mover, Enter para soltar, Escape para cancelar.`,
      );
      return;
    }

    if (grabbed.handle !== handle) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      cancelGrab(doc);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      dropGrab(doc);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveGrab('up', doc);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveGrab('down', doc);
    }
  });

  doc.addEventListener('focusout', (event) => {
    if (!grabbed || event.target !== grabbed.handle) return;
    cancelGrab(doc);
  });
}
