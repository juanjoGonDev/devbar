import { describe, expect, it } from 'vitest';
import { pipelineSummaryText } from '../renderer/pipeline/summary.js';
import { block, graph } from './helpers/pipeline.js';

describe('renderer/pipeline/summary.ts', () => {
  it('counts every placed script, frames included', () => {
    const pipeline = graph([block('A', ['a', 'b']), 'C'], ['trigger>A']);
    expect(pipelineSummaryText(pipeline)).toBe('3 scripts');
  });

  it('uses the singular for one script', () => {
    expect(pipelineSummaryText(graph(['A'], []))).toBe('1 script');
  });

  it('reads an empty pipeline as zero scripts', () => {
    expect(pipelineSummaryText(graph([], []))).toBe('0 scripts');
  });
});
