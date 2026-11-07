/**
 * Pure geometry of the pipeline canvas, in world pixels: how big a block is
 * drawn, where its pins sit, the curve of an edge, and the hit tests the
 * pointer gestures use. A block's stored `x`/`y` is its top-left corner.
 */
import { PIPELINE_GRID } from '../../src/pipeline-graph.js';
import type { Pipeline, PipelineBlock } from '../../src/domain-types.js';
import type { Point, Rect } from './viewport.js';

export const NODE_WIDTH = 148;
export const NODE_HEIGHT = 40;
const TRIGGER_WIDTH = 132;
/** Inner padding of a parallel frame, and the gap between its nodes. */
const FRAME_PAD_X = 14;
const FRAME_PAD_Y = 20;
const FRAME_GAP = 12;
/** How far left of a body a drop still counts as landing on its input pin. */
const PIN_REACH = 12;
/** Vertical room `spreadColumns` keeps between two blocks of a column. */
const COLUMN_GAP = PIPELINE_GRID.rowGap - NODE_HEIGHT;

/** The fixed trigger, where `autoLayout` puts column 0. */
export const TRIGGER_RECT: Rect = {
  x: PIPELINE_GRID.originX,
  y: PIPELINE_GRID.originY,
  width: TRIGGER_WIDTH,
  height: NODE_HEIGHT,
};

export function blockRect(block: PipelineBlock): Rect {
  const count = block.scripts.length;
  if (count < 2)
    return { x: block.x, y: block.y, width: NODE_WIDTH, height: NODE_HEIGHT };
  return {
    x: block.x,
    y: block.y,
    width: NODE_WIDTH + FRAME_PAD_X * 2,
    height: FRAME_PAD_Y * 2 + count * NODE_HEIGHT + (count - 1) * FRAME_GAP,
  };
}

/** Where the `index`-th node of a block of `count` sits inside it. */
export function nodeOffset(index: number, count: number): Point {
  if (count < 2) return { x: 0, y: 0 };
  return {
    x: FRAME_PAD_X,
    y: FRAME_PAD_Y + index * (NODE_HEIGHT + FRAME_GAP),
  };
}

export function inputPin(rect: Rect): Point {
  return { x: rect.x, y: rect.y + rect.height / 2 };
}

export function outputPin(rect: Rect): Point {
  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
}

/** The rect of a block id, or of the trigger. */
export function rectOf(pipeline: Pipeline, id: string): Rect | null {
  if (id === 'trigger') return TRIGGER_RECT;
  const found = pipeline.blocks.find((block) => block.id === id);
  return found ? blockRect(found) : null;
}

function controls(from: Point, to: Point): [Point, Point] {
  // A backwards edge (target left of the source) bends out instead of
  // folding onto itself, as n8n does.
  const dx = to.x >= from.x ? (to.x - from.x) / 2 : 60;
  return [
    { x: from.x + dx, y: from.y },
    { x: to.x - dx, y: to.y },
  ];
}

/** The SVG path of an edge: a horizontal-tangent cubic between two pins. */
export function edgePath(from: Point, to: Point): string {
  const [c1, c2] = controls(from, to);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/** The curve at t = 0.5, where the edge's delete button goes. */
export function edgeMidpoint(from: Point, to: Point): Point {
  const [c1, c2] = controls(from, to);
  return {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
}

/** The box around the trigger and every block. */
export function contentBounds(pipeline: Pipeline): Rect {
  const rects = [TRIGGER_RECT, ...pipeline.blocks.map(blockRect)];
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function contains(rect: Rect, point: Point, reachLeft = 0): boolean {
  return (
    point.x >= rect.x - reachLeft &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** The topmost block under `point` (its input pin included), or null. */
export function hitBlock(
  pipeline: Pipeline,
  point: Point,
  exclude?: string,
): string | null {
  for (let i = pipeline.blocks.length - 1; i >= 0; i--) {
    const block = pipeline.blocks[i];
    if (!block || block.id === exclude) continue;
    if (contains(blockRect(block), point, PIN_REACH)) return block.id;
  }
  return null;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * The first spot at (`x`, `y`) or a whole number of rows below it where a
 * new single node covers nothing already drawn.
 */
export function freeSpot(pipeline: Pipeline, x: number, y: number): Point {
  const rects = [TRIGGER_RECT, ...pipeline.blocks.map(blockRect)];
  let top = y;
  for (let guard = 0; guard < 200; guard++) {
    const candidate = { x, y: top, width: NODE_WIDTH, height: NODE_HEIGHT };
    if (!rects.some((rect) => overlaps(rect, candidate))) break;
    top += PIPELINE_GRID.rowGap;
  }
  return { x, y: top };
}

/**
 * `autoLayout` spaces rows for single nodes; a parallel frame is taller. This
 * pushes each block of a column down just enough to clear the one above it.
 * The same pipeline back when nothing had to move.
 */
export function spreadColumns(pipeline: Pipeline): Pipeline {
  const moved = new Map<string, number>();
  const columns = new Map<number, PipelineBlock[]>();
  for (const block of pipeline.blocks)
    columns.set(block.x, [...(columns.get(block.x) ?? []), block]);
  for (const column of columns.values()) {
    const sorted = [...column].sort((a, b) => a.y - b.y);
    let floor = -Infinity;
    for (const block of sorted) {
      const y = Math.max(block.y, floor);
      if (y !== block.y) moved.set(block.id, y);
      floor = y + blockRect(block).height + COLUMN_GAP;
    }
  }
  if (moved.size === 0) return pipeline;
  return {
    blocks: pipeline.blocks.map((block) =>
      moved.has(block.id)
        ? { ...block, y: moved.get(block.id) ?? block.y }
        : block,
    ),
    edges: pipeline.edges,
  };
}
