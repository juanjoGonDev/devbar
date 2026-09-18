/**
 * Keyboard "grab and move" reordering — the WCAG 2.1.1 (Keyboard) half of
 * `renderer/dnd-helper.ts`.
 *
 * Every reorderable list in the app is reachable by pointer drag only. This
 * module adds a keyboard-operable path on the SAME `.drag-handle` element,
 * wired from inside `attachDragHandlers` and `attachCrossContainerDragHandlers`
 * themselves, so all five call sites get identical behaviour with no
 * per-call-site key handling.
 *
 * It lives beside the pointer-drag helper rather than inside it because the
 * two halves share nothing but the handle: the pointer half owns DOM moves and
 * drop indicators, this half owns a data-only working copy, the shared
 * announcer and the document-level key listener.
 */
import { closestElement } from '../dom.js';

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
// Below this point every function touches `Element`/`Document`, so it runs
// under jsdom (`tests/dnd-keyboard.test.ts` declares the environment per
// file) rather than in the plain node environment the pure index math uses.
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

export function resolveLabel(root: Element | null): string | null {
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

export interface KeyboardReorderAdapter {
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

export function attachKeyboardReordering(
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
    const handle = closestElement(event.target, '.drag-handle');
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
