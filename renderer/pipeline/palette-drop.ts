import type { Point } from './viewport.js';

/**
 * Where a pre-script dragged from the panel lands on the canvas:
 * - on a block's body → `join` it (run in parallel with it);
 * - on an output pin, a "+" stub or the trigger → a new block wired `after`
 *   that one;
 * - anywhere else → a new, disconnected block at that world point.
 */
type PaletteDrop =
  | { kind: 'join'; blockId: string }
  | { kind: 'after'; fromId: string }
  | { kind: 'place'; at: Point };

export interface PaletteDropDeps {
  /** Where chips are dragged from. */
  panel: HTMLElement;
  /** Where they are dropped. */
  canvas: HTMLElement;
  /** A client point in world coordinates. */
  toWorld(clientX: number, clientY: number): Point;
  onDragStart(): void;
  onDrop(refKey: string, drop: PaletteDrop): void;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function planFor(target: Element | null): {
  lit: Element | null;
  drop: Exclude<PaletteDrop, { kind: 'place' }> | null;
} {
  const after = target?.closest<HTMLElement>(
    '.pipeline-pin.is-out, .pipeline-stub, .pipeline-trigger',
  );
  if (after?.dataset.block)
    return { lit: after, drop: { kind: 'after', fromId: after.dataset.block } };
  const block = target?.closest<HTMLElement>('.pipeline-block');
  if (block?.dataset.block)
    return { lit: block, drop: { kind: 'join', blockId: block.dataset.block } };
  return { lit: null, drop: null };
}

/**
 * Native HTML5 drag-and-drop from the panel's chips onto the canvas. It never
 * moves DOM nodes itself: it reports where the drop landed, and the editor
 * writes the next pipeline and repaints from it.
 */
export function attachPaletteDrop(deps: PaletteDropDeps): void {
  let dragging: string | null = null;
  let lit: Element | null = null;

  const light = (next: Element | null): void => {
    if (lit === next) return;
    lit?.classList.remove('is-drop-target');
    lit = next;
    lit?.classList.add('is-drop-target');
  };

  deps.panel.addEventListener('dragstart', (event) => {
    const chip = asElement(event.target)?.closest<HTMLElement>(
      '.pipeline-chip',
    );
    const key = chip?.dataset.ref;
    // A placed pre-script can be placed only once.
    if (!chip || !key || chip.classList.contains('is-placed')) {
      event.preventDefault();
      return;
    }
    dragging = key;
    chip.classList.add('dragging');
    deps.onDragStart();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', key);
    }
  });

  deps.panel.addEventListener('dragend', () => {
    dragging = null;
    light(null);
    deps.panel
      .querySelectorAll('.dragging')
      .forEach((chip) => chip.classList.remove('dragging'));
  });

  deps.canvas.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    light(planFor(asElement(event.target)).lit);
  });

  deps.canvas.addEventListener('dragleave', (event) => {
    if (
      event.relatedTarget instanceof Node &&
      deps.canvas.contains(event.relatedTarget)
    )
      return;
    light(null);
  });

  deps.canvas.addEventListener('drop', (event) => {
    const key = dragging;
    dragging = null;
    light(null);
    if (!key) return;
    event.preventDefault();
    const plan = planFor(asElement(event.target)).drop;
    deps.onDrop(
      key,
      plan ?? { kind: 'place', at: deps.toWorld(event.clientX, event.clientY) },
    );
  });
}
