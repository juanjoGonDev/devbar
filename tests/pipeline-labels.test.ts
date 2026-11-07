import { describe, it, expect } from 'vitest';
import {
  formatPipelineFailure,
  formatPipelineRunName,
  formatScriptCount,
  PIPELINE_LOG_GROUP_ID,
  PIPELINE_LOG_NAME,
} from '../src/pipeline-labels.js';

describe('formatPipelineRunName', () => {
  it('stamps the start time so consecutive runs are told apart in the log list', () => {
    // Local-time constructor: the expected clock reading is timezone-independent.
    const at = new Date(2026, 8, 10, 12, 47, 13).getTime();
    expect(formatPipelineRunName(at)).toBe('Workflow · 12:47:13.000');
  });

  it('zero-pads so the labels stay column-aligned', () => {
    const at = new Date(2026, 8, 10, 9, 5, 4).getTime();
    expect(formatPipelineRunName(at)).toBe('Workflow · 09:05:04.000');
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

describe('formatScriptCount', () => {
  it('uses the singular for one script', () => {
    expect(formatScriptCount(1)).toBe('1 script');
  });

  it('uses the plural for anything else', () => {
    expect(formatScriptCount(0)).toBe('0 scripts');
    expect(formatScriptCount(8)).toBe('8 scripts');
  });
});

describe('formatPipelineFailure', () => {
  it("reads the runner's failure reason as a sentence", () => {
    expect(formatPipelineFailure('scripts_failed:1', 8)).toBe(
      'Falló 1 script de 8',
    );
    expect(formatPipelineFailure('scripts_failed:3', 8)).toBe(
      'Fallaron 3 scripts de 8',
    );
  });

  it('returns null for a reason it does not know', () => {
    expect(formatPipelineFailure('boom', 8)).toBeNull();
    expect(formatPipelineFailure(null, 8)).toBeNull();
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
    expect(PIPELINE_LOG_NAME).toBe('Workflows');
  });
});
