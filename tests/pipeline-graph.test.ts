import { describe, expect, it } from 'vitest';
import {
  PIPELINE_GRID,
  PIPELINE_TRIGGER,
  autoLayout,
  blockOf,
  blocksToSkip,
  canConnect,
  descendants,
  disconnectedBlocks,
  pipelineRefKey,
  placedRefKeys,
  readyBlocks,
  runnableBlocks,
  runnableScriptCount,
  topologicalOrder,
  wouldCreateCycle,
  type BlockRunStatus,
  type ConnectRejection,
} from '../src/pipeline-graph.js';
import { block, graph, ref } from './helpers/pipeline.js';

/**
 * `src/pipeline-graph.ts` — the pure DAG behind the pre-script pipeline:
 * which blocks may run, in what order, and where they sit on the canvas.
 */

/** trigger→[A,B]→C; C→D→E; C→F→G — the branching example of the spec. */
const BRANCHING = graph(
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  ['trigger>A', 'trigger>B', 'A>C', 'B>C', 'C>D', 'D>E', 'C>F', 'F>G'],
);

function statuses(
  entries: Record<string, BlockRunStatus>,
): Map<string, BlockRunStatus> {
  return new Map(Object.entries(entries));
}

describe('src/pipeline-graph.ts', () => {
  it('names the trigger with the literal the edges use', () => {
    expect(PIPELINE_TRIGGER).toBe('trigger');
  });

  describe('placed scripts', () => {
    it('keys a ref by both of its ids', () => {
      expect(pipelineRefKey(ref('s', 'g'))).toBe('g::s');
    });

    it('lists every placed script and finds the block holding one', () => {
      const pipeline = graph([block('F', ['x', 'y']), 'B'], []);
      expect([...placedRefKeys(pipeline)]).toEqual(['g::x', 'g::y', 'g::B']);
      expect(blockOf(pipeline, ref('y'))?.id).toBe('F');
      expect(blockOf(pipeline, ref('nope'))).toBeNull();
    });
  });

  describe('topologicalOrder', () => {
    it('puts every block after all of its sources', () => {
      const order = topologicalOrder(BRANCHING);
      for (const edge of BRANCHING.edges) {
        if (edge.from === PIPELINE_TRIGGER) continue;
        expect(order.indexOf(edge.from)).toBeLessThan(order.indexOf(edge.to));
      }
      expect(order).toHaveLength(7);
    });

    it('breaks ties by the order the blocks are stored in', () => {
      const pipeline = graph(['B', 'A'], ['trigger>A', 'trigger>B']);
      expect(topologicalOrder(pipeline)).toEqual(['B', 'A']);
    });

    it('still lists disconnected blocks', () => {
      const pipeline = graph(['A', 'X'], ['trigger>A']);
      expect(topologicalOrder(pipeline)).toEqual(['A', 'X']);
    });
  });

  describe('disconnectedBlocks / runnableBlocks', () => {
    it('calls a block with no incoming edge disconnected', () => {
      const pipeline = graph(['A', 'X', 'Y'], ['trigger>A', 'X>Y']);
      expect(disconnectedBlocks(pipeline)).toEqual(['X']);
    });

    it('runs only blocks every source of which can run', () => {
      // Y hangs off the disconnected X; C also waits for X, so neither can
      // ever start even though C is reachable from the trigger.
      const pipeline = graph(
        ['A', 'C', 'X', 'Y'],
        ['trigger>A', 'A>C', 'X>C', 'X>Y'],
      );
      expect(runnableBlocks(pipeline)).toEqual(['A']);
    });

    it('counts only the scripts of runnable blocks', () => {
      const pipeline = graph(
        [block('A', ['a1', 'a2']), 'B', 'X'],
        ['trigger>A', 'A>B'],
      );
      expect(runnableScriptCount(pipeline)).toBe(3);
    });
  });

  describe('readyBlocks', () => {
    it('starts every block hanging off the trigger at once', () => {
      expect(readyBlocks(BRANCHING, statuses({}))).toEqual(['A', 'B']);
    });

    it('makes a join wait for ALL of its sources', () => {
      expect(
        readyBlocks(BRANCHING, statuses({ A: 'done', B: 'running' })),
      ).toEqual([]);
      expect(
        readyBlocks(BRANCHING, statuses({ A: 'done', B: 'done' })),
      ).toEqual(['C']);
    });

    it('lets each branch advance without waiting for the other', () => {
      const base = { A: 'done', B: 'done', C: 'done' } as const;
      // D is done while F still runs: E starts now.
      expect(
        readyBlocks(BRANCHING, statuses({ ...base, D: 'done', F: 'running' })),
      ).toEqual(['E']);
      // F is done while D still runs: G starts now.
      expect(
        readyBlocks(BRANCHING, statuses({ ...base, D: 'running', F: 'done' })),
      ).toEqual(['G']);
    });

    it('never offers a block that is not pending', () => {
      expect(
        readyBlocks(BRANCHING, statuses({ A: 'running', B: 'skipped' })),
      ).toEqual([]);
    });

    it('never offers a disconnected block', () => {
      const pipeline = graph(['A', 'X'], ['trigger>A']);
      expect(readyBlocks(pipeline, statuses({}))).toEqual(['A']);
    });
  });

  describe('descendants / blocksToSkip', () => {
    it('lists everything downstream of a block', () => {
      expect(descendants(BRANCHING, 'C').sort()).toEqual(['D', 'E', 'F', 'G']);
      expect(descendants(BRANCHING, 'E')).toEqual([]);
    });

    it('skips the pending descendants of a failed block only', () => {
      const skip = blocksToSkip(
        BRANCHING,
        'D',
        statuses({ A: 'done', B: 'done', C: 'done', F: 'running' }),
      );
      expect(skip).toEqual(['E']);
    });
  });

  describe('wouldCreateCycle / canConnect', () => {
    it('detects an edge back into an ancestor', () => {
      expect(wouldCreateCycle(BRANCHING, 'G', 'C')).toBe(true);
      expect(wouldCreateCycle(BRANCHING, 'E', 'G')).toBe(false);
    });

    it('treats a self edge as a cycle', () => {
      expect(wouldCreateCycle(BRANCHING, 'A', 'A')).toBe(true);
    });

    it('explains why an edge cannot be added', () => {
      const self: ConnectRejection | null = canConnect(BRANCHING, 'A', 'A');
      expect(self).toBe('self');
      expect(canConnect(BRANCHING, 'A', 'trigger')).toBe('into_trigger');
      expect(canConnect(BRANCHING, 'A', 'C')).toBe('duplicate');
      expect(canConnect(BRANCHING, 'G', 'A')).toBe('cycle');
      expect(canConnect(BRANCHING, 'A', 'nope')).toBe('unknown_block');
      expect(canConnect(BRANCHING, 'E', 'G')).toBeNull();
      expect(canConnect(BRANCHING, 'trigger', 'E')).toBeNull();
    });
  });

  describe('autoLayout', () => {
    it('places each block one column right of its deepest source', () => {
      const laid = autoLayout(BRANCHING);
      const at = (id: string) => laid.blocks.find((b) => b.id === id);
      const column = (n: number) =>
        PIPELINE_GRID.originX + n * PIPELINE_GRID.columnGap;
      expect(at('A')?.x).toBe(column(1));
      expect(at('B')?.x).toBe(column(1));
      expect(at('C')?.x).toBe(column(2));
      expect(at('D')?.x).toBe(column(3));
      expect(at('E')?.x).toBe(column(4));
      expect(at('G')?.x).toBe(column(4));
    });

    it('stacks a column in a stable row order', () => {
      const laid = autoLayout(BRANCHING);
      const at = (id: string) => laid.blocks.find((b) => b.id === id);
      const row = (n: number) =>
        PIPELINE_GRID.originY + n * PIPELINE_GRID.rowGap;
      expect(at('A')?.y).toBe(row(0));
      expect(at('B')?.y).toBe(row(1));
      expect(at('D')?.y).toBe(row(0));
      expect(at('F')?.y).toBe(row(1));
    });

    it('uses the longest path, not the shortest', () => {
      const pipeline = graph(['A', 'B'], ['trigger>A', 'A>B', 'trigger>B']);
      const laid = autoLayout(pipeline);
      expect(laid.blocks[1]?.x).toBe(
        PIPELINE_GRID.originX + 2 * PIPELINE_GRID.columnGap,
      );
    });

    it('puts a disconnected block in the first column', () => {
      const laid = autoLayout(graph(['X'], []));
      expect(laid.blocks[0]?.x).toBe(
        PIPELINE_GRID.originX + PIPELINE_GRID.columnGap,
      );
    });

    it('keeps blocks and edges otherwise untouched', () => {
      const laid = autoLayout(BRANCHING);
      expect(laid.edges).toEqual(BRANCHING.edges);
      expect(laid.blocks.map((b) => b.id)).toEqual(
        BRANCHING.blocks.map((b) => b.id),
      );
    });
  });
});
