import { describe, it, expect } from 'vitest';
import {
  formatPipelineRunName,
  formatStepCount,
  formatStepMode,
  PIPELINE_LOG_GROUP_ID,
  PIPELINE_LOG_NAME,
} from '../src/pipeline-labels.js';

describe('formatPipelineRunName', () => {
  it('stamps the start time so consecutive runs are told apart in the log list', () => {
    // Local-time constructor: the expected clock reading is timezone-independent.
    const at = new Date(2026, 8, 10, 12, 47, 13).getTime();
    expect(formatPipelineRunName(at)).toBe('Pipeline · 12:47:13.000');
  });

  it('zero-pads so the labels stay column-aligned', () => {
    const at = new Date(2026, 8, 10, 9, 5, 4).getTime();
    expect(formatPipelineRunName(at)).toBe('Pipeline · 09:05:04.000');
  });

  it('distinguishes two runs inside the same second', () => {
    // runIds are Date.now() stamps; a cancel-and-retry can land twice in one
    // second, and the sidebar shows only this label to tell the logs apart.
    const at = new Date(2026, 8, 10, 12, 47, 13).getTime();
    expect(formatPipelineRunName(at + 120)).not.toBe(
      formatPipelineRunName(at + 880),
    );
  });

  it('gives two runs a second apart different labels', () => {
    const first = new Date(2026, 8, 10, 12, 46, 14).getTime();
    const second = new Date(2026, 8, 10, 12, 47, 13).getTime();
    expect(formatPipelineRunName(first)).not.toBe(
      formatPipelineRunName(second),
    );
  });
});

describe('formatStepCount', () => {
  it('uses the singular for one step', () => {
    expect(formatStepCount(1)).toBe('1 paso');
  });

  it('uses the plural for anything else', () => {
    expect(formatStepCount(0)).toBe('0 pasos');
    expect(formatStepCount(2)).toBe('2 pasos');
  });
});

describe('formatStepMode', () => {
  it('reads in the same language as the rest of the app', () => {
    expect(formatStepMode('serial')).toBe('serie');
    expect(formatStepMode('parallel')).toBe('paralelo');
  });
});

// Single source of truth shared by `main.ts` (which builds the sidebar data)
// and `renderer/logs.ts` (which has to single out this one bucket to render
// it right after "Todo" and without per-run children) — a typo in either
// place duplicating this string by hand would silently break that matching.
describe('PIPELINE_LOG_GROUP_ID / PIPELINE_LOG_NAME', () => {
  it('is the shared sentinel identifying the pipeline bucket, never a real group id', () => {
    expect(PIPELINE_LOG_GROUP_ID).toBe('__pipeline__');
  });

  it('is the shared display name for that bucket', () => {
    expect(PIPELINE_LOG_NAME).toBe('Pipeline de pre-scripts');
  });
});
