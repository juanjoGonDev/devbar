import { describe, expect, it } from 'vitest';
import {
  PIPELINE_GRID,
  addBlock,
  blockOf,
  connect,
  disconnect,
  extractFromBlock,
  joinIntoBlock,
  moveBlock,
  newBlockId,
  removeBlock,
  removeScript,
  setRequireAll,
  type AddBlockOptions,
} from '../src/pipeline-graph.js';
import { block, blockList, edgeList, graph, ref } from './helpers/pipeline.js';

/**
 * `src/pipeline-graph.ts` editing operations — what the canvas calls for each
 * gesture. Every one is pure and returns the SAME object when it is a no-op,
 * so the caller can skip the write.
 */

const CHAIN = graph(['A', 'B', 'C'], ['trigger>A', 'A>B', 'B>C']);

describe('src/pipeline-graph.ts editing', () => {
  describe('addBlock', () => {
    it('adds a single-script block wired from its source', () => {
      const next = addBlock(CHAIN, ref('N'), { id: 'N', from: 'C' });
      expect(blockList(next)).toContain('N:N');
      expect(edgeList(next)).toContain('C>N');
    });

    it('places it one column right of its source by default', () => {
      const laid = graph([block('A', ['A'], 100, 60)], ['trigger>A']);
      const next = addBlock(laid, ref('N'), { id: 'N', from: 'A' });
      const added = next.blocks.find((b) => b.id === 'N');
      expect(added?.x).toBe(100 + PIPELINE_GRID.columnGap);
      expect(added?.y).toBe(60);
    });

    it('honours an explicit position', () => {
      const options: AddBlockOptions = { id: 'N', x: 5, y: 7 };
      const next = addBlock(CHAIN, ref('N'), options);
      expect(next.blocks.find((b) => b.id === 'N')).toMatchObject({
        x: 5,
        y: 7,
      });
    });

    it('moves a script that was already placed, leaving no empty block', () => {
      const next = addBlock(CHAIN, ref('C'), { id: 'N', from: 'A' });
      expect(blockList(next)).toEqual(['A:A', 'B:B', 'N:C']);
      expect(edgeList(next)).toEqual(['trigger>A', 'A>B', 'A>N']);
    });

    it('mints an id when none is given', () => {
      const next = addBlock(CHAIN, ref('N'));
      const added = blockOf(next, ref('N'));
      expect(added?.id).toBeTruthy();
      expect(added?.id).not.toBe('trigger');
    });

    it('ignores an unknown source', () => {
      const next = addBlock(CHAIN, ref('N'), { id: 'N', from: 'nope' });
      expect(edgeList(next)).toEqual(edgeList(CHAIN));
    });
  });

  describe('newBlockId', () => {
    it('mints a different id every time', () => {
      expect(newBlockId()).not.toBe(newBlockId());
    });
  });

  describe('joinIntoBlock', () => {
    it('turns a block into a parallel frame', () => {
      const next = joinIntoBlock(CHAIN, ref('C'), 'B');
      expect(blockList(next)).toEqual(['A:A', 'B:B,C']);
      expect(edgeList(next)).toEqual(['trigger>A', 'A>B']);
    });

    it('accepts a script that was not placed yet', () => {
      const next = joinIntoBlock(CHAIN, ref('N'), 'A');
      expect(blockList(next)[0]).toBe('A:A,N');
    });

    it('is a no-op into its own block or an unknown one', () => {
      expect(joinIntoBlock(CHAIN, ref('A'), 'A')).toBe(CHAIN);
      expect(joinIntoBlock(CHAIN, ref('A'), 'nope')).toBe(CHAIN);
    });
  });

  describe('extractFromBlock', () => {
    const FRAME = graph(
      [block('A'), block('F', ['x', 'y'], 10, 20), block('C')],
      ['trigger>A', 'A>F', 'F>C'],
    );

    it('gives the script its own block with the same wiring', () => {
      const next = extractFromBlock(FRAME, ref('y'), { id: 'Y' });
      expect(blockList(next)).toEqual(['A:A', 'F:x', 'C:C', 'Y:y']);
      expect(edgeList(next)).toEqual(['trigger>A', 'A>F', 'F>C', 'A>Y', 'Y>C']);
      expect(next.blocks[3]).toMatchObject({
        x: 10,
        y: 20 + PIPELINE_GRID.rowGap,
      });
    });

    it('leaves a single-script block alone', () => {
      expect(extractFromBlock(FRAME, ref('A'))).toBe(FRAME);
      expect(extractFromBlock(FRAME, ref('missing'))).toBe(FRAME);
    });
  });

  describe('setRequireAll', () => {
    it('turns «Todos OK» off for one block only', () => {
      const next = setRequireAll(CHAIN, 'B', false);
      expect(next.blocks.map((b) => b.requireAll)).toEqual([true, false, true]);
    });

    it('returns the same pipeline for a no-op or an unknown block', () => {
      expect(setRequireAll(CHAIN, 'B', true)).toBe(CHAIN);
      expect(setRequireAll(CHAIN, 'nope', false)).toBe(CHAIN);
    });

    it('creates new blocks with «Todos OK» on', () => {
      const next = addBlock(CHAIN, ref('D'), { from: 'C' });
      expect(next.blocks.at(-1)?.requireAll).toBe(true);
    });
  });

  describe('removeScript / removeBlock', () => {
    it('removes an emptied block together with its edges', () => {
      const next = removeScript(CHAIN, ref('B'));
      expect(blockList(next)).toEqual(['A:A', 'C:C']);
      expect(edgeList(next)).toEqual(['trigger>A']);
    });

    it('keeps a frame that still holds scripts', () => {
      const frame = graph([block('F', ['x', 'y'])], ['trigger>F']);
      const next = removeScript(frame, ref('x'));
      expect(blockList(next)).toEqual(['F:y']);
      expect(edgeList(next)).toEqual(['trigger>F']);
    });

    it('is a no-op for a script that is not placed', () => {
      expect(removeScript(CHAIN, ref('nope'))).toBe(CHAIN);
    });

    it('removes a block by id', () => {
      expect(blockList(removeBlock(CHAIN, 'A'))).toEqual(['B:B', 'C:C']);
      expect(removeBlock(CHAIN, 'nope')).toBe(CHAIN);
    });
  });

  describe('connect / disconnect', () => {
    it('adds a valid edge', () => {
      const pipeline = graph(['A', 'B'], ['trigger>A']);
      expect(edgeList(connect(pipeline, 'A', 'B'))).toEqual([
        'trigger>A',
        'A>B',
      ]);
    });

    it('rejects a cycle, a duplicate, a self edge and an edge into the trigger', () => {
      expect(connect(CHAIN, 'C', 'A')).toBe(CHAIN);
      expect(connect(CHAIN, 'A', 'B')).toBe(CHAIN);
      expect(connect(CHAIN, 'A', 'A')).toBe(CHAIN);
      expect(connect(CHAIN, 'A', 'trigger')).toBe(CHAIN);
    });

    it('removes an edge', () => {
      expect(edgeList(disconnect(CHAIN, 'A', 'B'))).toEqual([
        'trigger>A',
        'B>C',
      ]);
      expect(disconnect(CHAIN, 'C', 'A')).toBe(CHAIN);
    });
  });

  describe('moveBlock', () => {
    it('moves a block to a new position', () => {
      const next = moveBlock(CHAIN, 'B', 300, 40);
      expect(next.blocks[1]).toMatchObject({ id: 'B', x: 300, y: 40 });
    });

    it('is a no-op for an unknown block or the same spot', () => {
      expect(moveBlock(CHAIN, 'nope', 1, 1)).toBe(CHAIN);
      expect(moveBlock(CHAIN, 'A', 0, 0)).toBe(CHAIN);
    });
  });
});
