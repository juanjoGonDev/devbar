import { describe, expect, it } from 'vitest';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  TRIGGER_RECT,
  blockRect,
  contentBounds,
  edgeMidpoint,
  edgePath,
  freeSpot,
  hitBlock,
  inputPin,
  nodeOffset,
  outputPin,
  spreadColumns,
} from '../renderer/pipeline/geometry.js';
import { PIPELINE_GRID } from '../src/pipeline-graph.js';
import type { Pipeline, PipelineBlock } from '../src/domain-types.js';

function block(id: string, x: number, y: number, scripts = 1): PipelineBlock {
  return {
    id,
    x,
    y,
    requireAll: true,
    scripts: Array.from({ length: scripts }, (_, i) => ({
      groupId: 'g',
      scriptId: `${id}-${i}`,
    })),
  };
}

function pipeline(...blocks: PipelineBlock[]): Pipeline {
  return { blocks, edges: [] };
}

describe('renderer/pipeline/geometry.ts', () => {
  describe('blockRect', () => {
    it('draws a lone script as a compact 148×40 node', () => {
      expect(blockRect(block('a', 300, 40))).toEqual({
        x: 300,
        y: 40,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
      expect(NODE_WIDTH).toBe(148);
      expect(NODE_HEIGHT).toBe(40);
    });

    it('wraps a parallel block in a frame that holds every node', () => {
      const rect = blockRect(block('a', 0, 0, 2));
      expect(rect.width).toBe(NODE_WIDTH + 28);
      expect(rect.height).toBe(20 + 40 + 12 + 40 + 20);
      expect(nodeOffset(1, 2)).toEqual({ x: 14, y: 72 });
      expect(nodeOffset(0, 1)).toEqual({ x: 0, y: 0 });
    });
  });

  it('puts the input pin on the left middle and the output on the right', () => {
    const rect = { x: 10, y: 20, width: 100, height: 40 };
    expect(inputPin(rect)).toEqual({ x: 10, y: 40 });
    expect(outputPin(rect)).toEqual({ x: 110, y: 40 });
  });

  it('places the trigger on the grid origin', () => {
    expect(TRIGGER_RECT.x).toBe(PIPELINE_GRID.originX);
    expect(TRIGGER_RECT.y).toBe(PIPELINE_GRID.originY);
  });

  describe('edges', () => {
    it('draws a cubic curve between two pins', () => {
      expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 50 })).toBe(
        'M 0 0 C 50 0, 50 50, 100 50',
      );
    });

    it('bends a backwards edge out so it never folds onto itself', () => {
      expect(edgePath({ x: 100, y: 0 }, { x: 0, y: 0 })).toBe(
        'M 100 0 C 160 0, -60 0, 0 0',
      );
    });

    it('finds the middle of the curve for its delete button', () => {
      expect(edgeMidpoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({
        x: 50,
        y: 25,
      });
    });
  });

  describe('contentBounds', () => {
    it('covers the trigger and every block', () => {
      const bounds = contentBounds(pipeline(block('a', 600, 400)));
      expect(bounds).toEqual({
        x: TRIGGER_RECT.x,
        y: TRIGGER_RECT.y,
        width: 600 + NODE_WIDTH - TRIGGER_RECT.x,
        height: 400 + NODE_HEIGHT - TRIGGER_RECT.y,
      });
    });
  });

  describe('hitBlock', () => {
    const graph = pipeline(block('a', 300, 40), block('b', 300, 200));

    it('finds the block under a point', () => {
      expect(hitBlock(graph, { x: 310, y: 210 })).toBe('b');
    });

    it('counts a point just left of the body, over the input pin', () => {
      expect(hitBlock(graph, { x: 292, y: 60 })).toBe('a');
    });

    it('skips the block being dragged and empty space', () => {
      expect(hitBlock(graph, { x: 310, y: 50 }, 'a')).toBeNull();
      expect(hitBlock(graph, { x: 0, y: 500 })).toBeNull();
    });
  });

  describe('freeSpot', () => {
    it('keeps a spot nothing covers', () => {
      expect(freeSpot(pipeline(block('a', 0, 0)), 400, 0)).toEqual({
        x: 400,
        y: 0,
      });
    });

    it('moves down a row until the spot is clear', () => {
      const graph = pipeline(block('a', 400, 0), block('b', 400, 120));
      expect(freeSpot(graph, 400, 0)).toEqual({ x: 400, y: 240 });
    });
  });

  describe('spreadColumns', () => {
    it('pushes a block down when a taller frame above would cover it', () => {
      const graph = pipeline(block('f', 300, 40, 3), block('n', 300, 160));
      const spread = spreadColumns(graph);
      const frame = blockRect(block('f', 300, 40, 3));
      expect(spread.blocks[1]?.y).toBe(frame.y + frame.height + 80);
      expect(spread.blocks[0]?.y).toBe(40);
    });

    it('returns the same pipeline when nothing overlaps', () => {
      const graph = pipeline(block('a', 300, 40), block('b', 300, 160));
      expect(spreadColumns(graph)).toBe(graph);
    });
  });
});
