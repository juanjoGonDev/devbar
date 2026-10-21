import { TRIGGER_RECT, blockRect, contentBounds } from './geometry.js';
import { pipelineRefKey } from '../../src/pipeline-graph.js';
import type { Pipeline } from '../../src/domain-types.js';
import type { Point, Rect, Viewport } from './viewport.js';

const MAP_WIDTH = 168;
const MAP_HEIGHT = 96;
const MAP_PAD = 8;

interface MinimapInput {
  pipeline: Pipeline;
  view: Viewport;
  /** The canvas's size on screen; 0×0 while it is not laid out. */
  canvas: { width: number; height: number };
  selectedKey: string | null;
}

interface MapTransform {
  scale: number;
  originX: number;
  originY: number;
}

function union(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    x: left,
    y: top,
    width: Math.max(a.x + a.width, b.x + b.width) - left,
    height: Math.max(a.y + a.height, b.y + b.height) - top,
  };
}

function visibleWorld(input: MinimapInput): Rect {
  const { view, canvas } = input;
  return {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    width: canvas.width / view.zoom,
    height: canvas.height / view.zoom,
  };
}

/** Fits the graph and the visible area together into the map, centred. */
function transformFor(input: MinimapInput): MapTransform {
  const content = contentBounds(input.pipeline);
  const visible = visibleWorld(input);
  const bounds =
    visible.width > 0 && visible.height > 0 ? union(content, visible) : content;
  const scale = Math.min(
    (MAP_WIDTH - MAP_PAD * 2) / Math.max(1, bounds.width),
    (MAP_HEIGHT - MAP_PAD * 2) / Math.max(1, bounds.height),
  );
  return {
    scale,
    originX: (MAP_WIDTH - bounds.width * scale) / 2 - bounds.x * scale,
    originY: (MAP_HEIGHT - bounds.height * scale) / 2 - bounds.y * scale,
  };
}

function box(className: string, rect: Rect, t: MapTransform): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  node.style.left = `${rect.x * t.scale + t.originX}px`;
  node.style.top = `${rect.y * t.scale + t.originY}px`;
  node.style.width = `${Math.max(2, rect.width * t.scale)}px`;
  node.style.height = `${Math.max(2, rect.height * t.scale)}px`;
  return node;
}

export interface Minimap {
  element: HTMLElement;
  render(input: MinimapInput): void;
}

/**
 * The bottom-right overview: every block as a small bar, the visible area as
 * a rectangle. A click or a drag on it centres the canvas on that spot.
 */
export function createMinimap(onCenter: (world: Point) => void): Minimap {
  const element = document.createElement('div');
  element.className = 'pipeline-minimap';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Minimapa');
  let transform: MapTransform = { scale: 1, originX: 0, originY: 0 };
  // Frozen while dragging: the visible area is part of what the map fits, so
  // refitting under the pointer would make the drag chase its own tail.
  let dragging = false;

  function render(input: MinimapInput): void {
    if (!dragging) transform = transformFor(input);
    const parts = [
      box('pipeline-minimap-item is-trigger', TRIGGER_RECT, transform),
    ];
    for (const block of input.pipeline.blocks) {
      const item = box('pipeline-minimap-item', blockRect(block), transform);
      if (block.scripts.length > 1) item.classList.add('is-frame');
      if (
        block.scripts.some((ref) => pipelineRefKey(ref) === input.selectedKey)
      )
        item.classList.add('is-selected');
      parts.push(item);
    }
    const visible = visibleWorld(input);
    if (visible.width > 0 && visible.height > 0)
      parts.push(box('pipeline-minimap-view', visible, transform));
    element.replaceChildren(...parts);
  }

  function centerAt(event: MouseEvent): void {
    const rect = element.getBoundingClientRect();
    onCenter({
      x: (event.clientX - rect.left - transform.originX) / transform.scale,
      y: (event.clientY - rect.top - transform.originY) / transform.scale,
    });
  }

  element.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    dragging = true;
    centerAt(down);
    const onMove = (move: PointerEvent): void => centerAt(move);
    const onUp = (): void => {
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  return { element, render };
}
