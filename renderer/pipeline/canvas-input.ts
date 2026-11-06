import {
  panBy,
  toWorld,
  wheelZoom,
  type Point,
  type Viewport,
} from './viewport.js';
import { rectOf, outputPin } from './geometry.js';
import type { Pipeline } from '../../src/domain-types.js';

/** Screen pixels a press has to travel before it counts as a drag. */
const DRAG_THRESHOLD = 3;

export interface CanvasInputDeps {
  /** The viewport element: its box is the screen frame of every gesture. */
  canvas: HTMLElement;
  getView(): Viewport;
  setView(view: Viewport): void;
  getPipeline(): Pipeline;
  /** A block is being dragged: draw it at (`x`, `y`), over `target`. */
  previewMove(
    blockId: string,
    x: number,
    y: number,
    target: string | null,
  ): void;
  /** The drag ended at (`x`, `y`); `target` is the block it was dropped on. */
  finishMove(
    blockId: string,
    x: number,
    y: number,
    target: string | null,
  ): void;
  /** Where a connection being dragged from `fromId` would land. */
  hitTarget(point: Point, exclude: string): string | null;
  previewConnection(
    from: Point | null,
    to: Point | null,
    target: string | null,
  ): void;
  finishConnection(fromId: string, toId: string | null): void;
}

export interface CanvasInput {
  /** True once, right after a drag: the click it ends with is not a click. */
  consumeDragClick(): boolean;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/** Whether a key press belongs to a text field, not to the canvas. */
function isTyping(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return element.closest('input, textarea, select, [contenteditable]') !== null;
}

/**
 * Every pointer gesture of the canvas, in one place:
 * - Space held + drag, a middle-button drag, or a drag on empty canvas pans;
 * - Ctrl/Cmd + wheel (a trackpad pinch arrives that way) zooms around the
 *   cursor, a plain wheel or two-finger scroll pans;
 * - a drag from an output pin draws a live connection;
 * - a drag on a block moves it (and dropping it on another joins them).
 */
export function attachCanvasInput(deps: CanvasInputDeps): CanvasInput {
  const { canvas } = deps;
  let spaceHeld = false;
  let hovering = false;
  let dragged = false;

  const local = (event: MouseEvent): Point => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const world = (event: MouseEvent): Point => {
    const at = local(event);
    return toWorld(deps.getView(), at.x, at.y);
  };

  /** Runs `onMove` per pointer move until the button is released. */
  function track(
    down: PointerEvent,
    onMove: (move: PointerEvent, travelled: boolean) => void,
    onUp: (up: PointerEvent, travelled: boolean) => void,
  ): void {
    let travelled = false;
    const move = (event: PointerEvent): void => {
      travelled =
        travelled ||
        Math.hypot(
          event.clientX - down.clientX,
          event.clientY - down.clientY,
        ) >= DRAG_THRESHOLD;
      onMove(event, travelled);
    };
    const up = (event: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (travelled) dragged = true;
      onUp(event, travelled);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function pan(down: PointerEvent): void {
    canvas.classList.add('is-panning');
    let lastX = down.clientX;
    let lastY = down.clientY;
    track(
      down,
      (move) => {
        deps.setView(
          panBy(deps.getView(), move.clientX - lastX, move.clientY - lastY),
        );
        lastX = move.clientX;
        lastY = move.clientY;
      },
      () => canvas.classList.remove('is-panning'),
    );
  }

  function connect(down: PointerEvent, fromId: string): void {
    const fromRect = rectOf(deps.getPipeline(), fromId);
    if (!fromRect) return;
    const from = outputPin(fromRect);
    track(
      down,
      (move) => {
        const to = world(move);
        deps.previewConnection(from, to, deps.hitTarget(to, fromId));
      },
      (up, travelled) => {
        deps.previewConnection(null, null, null);
        if (travelled)
          deps.finishConnection(fromId, deps.hitTarget(world(up), fromId));
      },
    );
  }

  function move(down: PointerEvent, blockId: string): void {
    const block = deps.getPipeline().blocks.find((b) => b.id === blockId);
    if (!block) return;
    const start = world(down);
    const origin = { x: block.x, y: block.y };
    const at = (
      event: PointerEvent,
    ): { x: number; y: number; target: string | null } => {
      const now = world(event);
      return {
        x: Math.round(origin.x + now.x - start.x),
        y: Math.round(origin.y + now.y - start.y),
        target: deps.hitTarget(now, blockId),
      };
    };
    canvas.classList.add('is-dragging');
    track(
      down,
      (event, travelled) => {
        if (!travelled) return;
        const next = at(event);
        deps.previewMove(blockId, next.x, next.y, next.target);
      },
      (event, travelled) => {
        canvas.classList.remove('is-dragging');
        if (!travelled) return;
        const next = at(event);
        deps.finishMove(blockId, next.x, next.y, next.target);
      },
    );
  }

  canvas.addEventListener('pointerdown', (down) => {
    dragged = false;
    const target = asElement(down.target);
    if (down.button === 1 || (down.button === 0 && spaceHeld)) {
      down.preventDefault();
      pan(down);
      return;
    }
    if (down.button !== 0 || !target) return;
    if (
      target.closest(
        '.pipeline-stub, .pipeline-node-toolbar, .pipeline-edge-delete',
      )
    )
      return;
    const pin = target.closest<HTMLElement>('.pipeline-pin.is-out');
    if (pin?.dataset.block) {
      down.preventDefault();
      connect(down, pin.dataset.block);
      return;
    }
    const block = target.closest<HTMLElement>('.pipeline-block');
    if (block?.dataset.block) {
      move(down, block.dataset.block);
      return;
    }
    if (target.closest('.pipeline-trigger')) return;
    pan(down);
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const at = local(event);
        deps.setView(wheelZoom(deps.getView(), event.deltaY, at.x, at.y));
        return;
      }
      // Shift turns a mouse wheel's vertical delta into a horizontal pan.
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      deps.setView(panBy(deps.getView(), -dx, -dy));
    },
    { passive: false },
  );

  canvas.addEventListener('pointerenter', () => {
    hovering = true;
  });
  canvas.addEventListener('pointerleave', () => {
    hovering = false;
  });

  const canPan = (event: KeyboardEvent): boolean => {
    if (isTyping(event.target)) return false;
    const owner = canvas.parentElement;
    return (
      hovering ||
      (owner !== null &&
        owner.isConnected &&
        document.activeElement instanceof Node &&
        owner.contains(document.activeElement))
    );
  };

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (!canPan(event)) return;
    event.preventDefault();
    if (spaceHeld) return;
    spaceHeld = true;
    canvas.classList.add('is-pan-ready');
  });
  window.addEventListener('keyup', (event) => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    spaceHeld = false;
    canvas.classList.remove('is-pan-ready');
  });
  window.addEventListener('blur', () => {
    spaceHeld = false;
    canvas.classList.remove('is-pan-ready');
  });

  return {
    consumeDragClick: () => {
      const was = dragged;
      dragged = false;
      return was;
    },
  };
}
