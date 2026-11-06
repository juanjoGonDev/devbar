import { describe, expect, it } from 'vitest';
import {
  PIPELINE_GRID,
  emptyPipeline,
  fromLegacySteps,
  normalizePipeline,
  pruneRefs,
  validatePipeline,
  type PipelineValidation,
} from '../src/pipeline-graph.js';
import { block, blockList, edgeList, graph, ref } from './helpers/pipeline.js';

/**
 * `src/pipeline-graph.ts` — reading a stored/imported pipeline (lenient),
 * validating one the renderer sends (strict), migrating the old flat list of
 * steps, and pruning refs to scripts that no longer exist.
 */

let counter = 0;
const ids = (): string => `id${++counter}`;

describe('src/pipeline-graph.ts normalization', () => {
  describe('normalizePipeline', () => {
    it('reads anything that is not a pipeline as an empty one', () => {
      expect(normalizePipeline(undefined)).toEqual(emptyPipeline());
      expect(normalizePipeline('x')).toEqual(emptyPipeline());
    });

    it('keeps a well-formed pipeline as it is', () => {
      const pipeline = graph(
        [block('A', ['A'], 10, 20), block('B', ['B'], 30, 40)],
        ['trigger>A', 'A>B'],
      );
      expect(normalizePipeline(structuredClone(pipeline))).toEqual(pipeline);
    });

    it('keeps each script only in its first placement', () => {
      const raw = graph([block('A', ['x', 'y']), block('B', ['y'])], []);
      expect(blockList(normalizePipeline(raw))).toEqual(['A:x,y']);
    });

    it('drops blank refs, empty blocks and the edges they had', () => {
      const raw = {
        blocks: [
          { id: 'A', scripts: [{ groupId: '', scriptId: 'x' }], x: 0, y: 0 },
          block('B'),
        ],
        edges: [
          { from: 'trigger', to: 'A' },
          { from: 'A', to: 'B' },
        ],
      };
      const next = normalizePipeline(raw);
      expect(blockList(next)).toEqual(['B:B']);
      expect(edgeList(next)).toEqual([]);
    });

    it('drops dangling, duplicate, self, into-trigger and cyclic edges', () => {
      const raw = graph(
        ['A', 'B'],
        ['trigger>A', 'trigger>A', 'A>A', 'A>trigger', 'A>ghost', 'A>B', 'B>A'],
      );
      expect(edgeList(normalizePipeline(raw))).toEqual(['trigger>A', 'A>B']);
    });

    it('re-ids a duplicate block id and one named like the trigger', () => {
      const raw = graph([block('A', ['x']), block('A', ['y']), 'trigger'], []);
      const next = normalizePipeline(raw, ids);
      const blockIds = next.blocks.map((b) => b.id);
      expect(new Set(blockIds).size).toBe(3);
      expect(blockIds[0]).toBe('A');
      expect(blockIds).not.toContain('trigger');
    });

    it('keeps «Todos OK» off only when it was explicitly turned off', () => {
      const raw = {
        blocks: [
          { id: 'A', scripts: [ref('A')], requireAll: false },
          { id: 'B', scripts: [ref('B')] },
          { id: 'C', scripts: [ref('C')], requireAll: 'no' },
        ],
        edges: [],
      };
      expect(normalizePipeline(raw).blocks.map((b) => b.requireAll)).toEqual([
        false,
        true,
        true,
      ]);
    });

    it('defaults a missing position to 0', () => {
      const next = normalizePipeline({
        blocks: [{ id: 'A', scripts: [ref('A')] }],
        edges: [],
      });
      expect(next.blocks[0]).toMatchObject({ x: 0, y: 0 });
    });
  });

  describe('validatePipeline', () => {
    const resolves = () => true;

    it('accepts a valid graph, positions included', () => {
      const pipeline = graph(
        [block('A', ['A'], 1, 2), 'B'],
        ['trigger>A', 'A>B'],
      );
      const result: PipelineValidation = validatePipeline(pipeline, {
        resolves,
      });
      expect(result).toEqual({ ok: true, pipeline });
    });

    it.each([
      ['a non-object', 'x', 'El pipeline debe ser un objeto'],
      [
        'a cycle',
        graph(['A', 'B'], ['trigger>A', 'A>B', 'B>A']),
        'El pipeline tiene un ciclo',
      ],
      [
        'a script placed twice',
        graph([block('A', ['x']), block('B', ['x'])], []),
        'Un script aparece en más de un bloque',
      ],
      [
        'a repeated block id',
        graph([block('A', ['x']), block('A', ['y'])], []),
        'Dos bloques comparten id',
      ],
      [
        'an edge to an unknown block',
        graph(['A'], ['A>ghost']),
        'Una conexión apunta a un bloque inexistente',
      ],
      [
        'a duplicate edge',
        graph(['A'], ['trigger>A', 'trigger>A']),
        'Conexión repetida',
      ],
      [
        'a self edge',
        graph(['A'], ['A>A']),
        'Un bloque no puede depender de sí mismo',
      ],
      [
        'an edge into the trigger',
        graph(['A'], ['A>trigger']),
        'Nada puede conectarse hacia el disparador',
      ],
      [
        'an empty block',
        { blocks: [{ id: 'A', scripts: [], x: 0, y: 0 }], edges: [] },
        'Un bloque no tiene scripts',
      ],
    ])('rejects %s', (_name, value, error) => {
      expect(validatePipeline(value, { resolves })).toEqual({
        ok: false,
        error,
      });
    });

    it('rejects a ref the caller cannot resolve', () => {
      const result = validatePipeline(graph(['A'], []), {
        resolves: (r) => r.scriptId !== 'A',
      });
      expect(result).toEqual({
        ok: false,
        error: 'Un bloque referencia un grupo o script inexistente',
      });
    });

    it('carries «Todos OK» through, defaulting it to on', () => {
      const result = validatePipeline({
        blocks: [
          { id: 'A', scripts: [ref('A')], requireAll: false },
          { id: 'B', scripts: [ref('B')] },
        ],
        edges: [],
      });
      expect(
        result.ok && result.pipeline.blocks.map((b) => b.requireAll),
      ).toEqual([false, true]);
    });

    it('mints ids for blocks that carry none and defaults positions', () => {
      const result = validatePipeline(
        { blocks: [{ scripts: [ref('x')] }], edges: [] },
        { resolves, newId: ids },
      );
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.pipeline.blocks[0]).toMatchObject({ x: 0, y: 0 });
    });
  });

  describe('fromLegacySteps', () => {
    it('chains each step after the previous one, from the trigger', () => {
      const next = fromLegacySteps([
        { id: 's1', mode: 'parallel', scripts: [ref('a'), ref('b')] },
        { id: 's2', mode: 'serial', scripts: [ref('c')] },
      ]);
      expect(blockList(next)).toEqual(['s1:a,b', 's2:c']);
      expect(edgeList(next)).toEqual(['trigger>s1', 's1>s2']);
    });

    it('splits a serial step with several scripts into consecutive blocks', () => {
      const next = fromLegacySteps(
        [{ id: 's1', mode: 'serial', scripts: [ref('a'), ref('b'), ref('c')] }],
        ids,
      );
      const [first, second, third] = next.blocks.map((b) => b.id);
      expect(first).toBe('s1');
      expect(blockList(next).map((entry) => entry.split(':')[1])).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(edgeList(next)).toEqual([
        'trigger>s1',
        `s1>${second}`,
        `${second}>${third}`,
      ]);
    });

    it('skips empty steps without breaking the chain', () => {
      const next = fromLegacySteps([
        { id: 's1', scripts: [ref('a')] },
        { id: 's2', scripts: [] },
        { id: 's3', scripts: [ref('c')] },
      ]);
      expect(edgeList(next)).toEqual(['trigger>s1', 's1>s3']);
    });

    it('keeps a script only in its first step', () => {
      const next = fromLegacySteps([
        { id: 's1', scripts: [ref('a')] },
        { id: 's2', scripts: [ref('a')] },
      ]);
      expect(blockList(next)).toEqual(['s1:a']);
    });

    it('re-ids a missing or repeated step id', () => {
      const next = fromLegacySteps(
        [
          { id: 's1', scripts: [ref('a')] },
          { id: 's1', scripts: [ref('b')] },
          { scripts: [ref('c')] },
        ],
        ids,
      );
      expect(new Set(next.blocks.map((b) => b.id)).size).toBe(3);
    });

    it('lays the chain out left to right', () => {
      const next = fromLegacySteps([
        { id: 's1', scripts: [ref('a')] },
        { id: 's2', scripts: [ref('b')] },
      ]);
      expect(next.blocks.map((b) => b.x)).toEqual([
        PIPELINE_GRID.originX + PIPELINE_GRID.columnGap,
        PIPELINE_GRID.originX + 2 * PIPELINE_GRID.columnGap,
      ]);
    });

    it('reads a non-array as an empty pipeline', () => {
      expect(fromLegacySteps('nope' as unknown as unknown[])).toEqual(
        emptyPipeline(),
      );
    });
  });

  describe('pruneRefs', () => {
    it('drops refs that no longer resolve', () => {
      const frame = graph([block('F', ['x', 'y'])], ['trigger>F']);
      const next = pruneRefs(frame, (r) => r.scriptId !== 'x');
      expect(blockList(next)).toEqual(['F:y']);
    });

    it('bridges an emptied block so what came after it still runs', () => {
      const chain = graph(['A', 'B', 'C'], ['trigger>A', 'A>B', 'B>C']);
      const next = pruneRefs(chain, (r) => r.scriptId !== 'B');
      expect(blockList(next)).toEqual(['A:A', 'C:C']);
      expect(edgeList(next)).toEqual(['trigger>A', 'A>C']);
    });

    it('returns the same pipeline when every ref resolves', () => {
      const chain = graph(['A'], ['trigger>A']);
      expect(pruneRefs(chain, () => true)).toBe(chain);
    });
  });
});
