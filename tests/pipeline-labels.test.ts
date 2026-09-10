import { describe, it, expect } from 'vitest';
import {
  formatScriptLabel,
  formatPipelineRunName,
  formatStepCount,
  formatStepMode,
} from '../src/pipeline-labels.js';

describe('formatScriptLabel', () => {
  it('puts the group before the script so same-named scripts stay distinguishable', () => {
    expect(formatScriptLabel('Back', 'Make setup')).toBe('Back · Make setup');
    expect(formatScriptLabel('Automator', 'Make setup')).toBe(
      'Automator · Make setup',
    );
  });

  it('never collapses two same-named scripts from different groups', () => {
    expect(formatScriptLabel('Back', 'Make setup')).not.toBe(
      formatScriptLabel('Automator', 'Make setup'),
    );
  });

  it('falls back to the script alone when the group has no usable name', () => {
    expect(formatScriptLabel('', 'Make setup')).toBe('Make setup');
    expect(formatScriptLabel('   ', 'Make setup')).toBe('Make setup');
  });
});

describe('formatPipelineRunName', () => {
  it('stamps the start time so consecutive runs are told apart in the log list', () => {
    // Local-time constructor: the expected clock reading is timezone-independent.
    const at = new Date(2026, 8, 10, 12, 47, 13).getTime();
    expect(formatPipelineRunName(at)).toBe('Pipeline · 12:47:13');
  });

  it('zero-pads so the labels stay column-aligned', () => {
    const at = new Date(2026, 8, 10, 9, 5, 4).getTime();
    expect(formatPipelineRunName(at)).toBe('Pipeline · 09:05:04');
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
