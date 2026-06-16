import { describe, it, expect } from 'vitest';
import { normalizePreStep, normalizePreScript } from '../src/groups-model.js';

/**
 * config-store-prescripts.test.js
 *
 * config-store requires electron-store (Electron context) and cannot be
 * imported in a pure Vitest environment. We therefore test the CRUD logic
 * that lives in the normalizer layer (normalizePreStep / normalizePreScript)
 * and verify the reorder algorithm inline — both mirror exactly what
 * config-store's savePreStep / reorderPreSteps / savePreScript etc. do.
 *
 * The normalizer tests ensure the data shapes produced by each CRUD
 * function are correct; the reorder tests validate the id-based splice
 * logic (same algorithm used in reorderPreSteps / reorderPreScripts /
 * reorderActions in config-store.js).
 */

// ─── Reorder algorithm (mirrors config-store's reorder helpers) ───────────────

function reorderById(items, orderedIds) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const seen = new Set();
  const sorted = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) {
      sorted.push(byId.get(id));
      seen.add(id);
    }
  }
  for (const x of items) {
    if (!seen.has(x.id)) sorted.push(x);
  }
  return sorted;
}

// ─── normalizePreStep (savePreStep contract) ──────────────────────────────────

describe('savePreStep contract — normalizePreStep', () => {
  it('creates a new step with defaults for minimal input', () => {
    const step = normalizePreStep({});
    expect(step.mode).toBe('parallel');
    expect(step.scripts).toEqual([]);
    expect(typeof step.id).toBe('string');
    expect(step.id.length).toBeGreaterThan(0);
  });

  it('preserves provided id (upsert identity)', () => {
    const step = normalizePreStep({ id: 'step-abc' });
    expect(step.id).toBe('step-abc');
  });

  it('normalizes scripts within the step', () => {
    const step = normalizePreStep({
      id: 'step-1',
      mode: 'serial',
      scripts: [{ id: 'sc-1', name: 'Install', command: 'pnpm install' }],
    });
    expect(step.scripts).toHaveLength(1);
    expect(step.scripts[0].id).toBe('sc-1');
  });

  it('defaults unknown mode to parallel', () => {
    const step = normalizePreStep({ mode: 'batch' });
    expect(step.mode).toBe('parallel');
  });
});

// ─── normalizePreScript (savePreScript contract) ──────────────────────────────

describe('savePreScript contract — normalizePreScript', () => {
  it('creates a script with defaults for minimal input', () => {
    const sc = normalizePreScript({});
    expect(sc.name).toBe('Unnamed');
    expect(sc.command).toBe('');
    expect(sc.args).toEqual([]);
    expect(sc.env).toEqual([]);
    expect(sc.inheritGroupEnv).toBe(false);
    expect(typeof sc.id).toBe('string');
  });

  it('preserves provided id', () => {
    const sc = normalizePreScript({
      id: 'sc-abc',
      name: 'Build',
      command: 'pnpm build',
    });
    expect(sc.id).toBe('sc-abc');
  });

  it('trims name whitespace', () => {
    const sc = normalizePreScript({ name: '  Build  ', command: 'pnpm build' });
    expect(sc.name).toBe('Build');
  });

  it('preserves args as array', () => {
    const sc = normalizePreScript({
      command: 'pnpm',
      args: ['install', '--frozen'],
    });
    expect(sc.args).toEqual(['install', '--frozen']);
  });

  it('normalizes env entries', () => {
    const sc = normalizePreScript({
      command: 'echo',
      env: [{ key: 'NODE_ENV', value: 'production', enabled: true }],
    });
    expect(sc.env).toHaveLength(1);
    expect(sc.env[0].key).toBe('NODE_ENV');
  });

  it('inherits inheritGroupEnv from raw value', () => {
    expect(normalizePreScript({ inheritGroupEnv: true }).inheritGroupEnv).toBe(
      true,
    );
    expect(normalizePreScript({ inheritGroupEnv: false }).inheritGroupEnv).toBe(
      false,
    );
  });
});

// ─── deletePreStep contract ───────────────────────────────────────────────────

describe('deletePreStep contract', () => {
  it('removes a step by id', () => {
    const steps = [
      { id: 's1', mode: 'parallel', scripts: [] },
      { id: 's2', mode: 'serial', scripts: [] },
    ];
    const result = steps.filter((s) => s.id !== 's1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s2');
  });

  it('is a no-op for unknown step id', () => {
    const steps = [{ id: 's1', mode: 'parallel', scripts: [] }];
    const result = steps.filter((s) => s.id !== 'nonexistent');
    expect(result).toHaveLength(1);
  });
});

// ─── reorderPreSteps contract ─────────────────────────────────────────────────

describe('reorderPreSteps contract — reorder algorithm', () => {
  it('reorders steps to match orderedIds', () => {
    const steps = [
      { id: 's1', mode: 'parallel', scripts: [] },
      { id: 's2', mode: 'serial', scripts: [] },
      { id: 's3', mode: 'parallel', scripts: [] },
    ];
    const result = reorderById(steps, ['s3', 's1', 's2']);
    expect(result.map((s) => s.id)).toEqual(['s3', 's1', 's2']);
  });

  it('appends unknown ids at the end', () => {
    const steps = [{ id: 's1' }, { id: 's2' }];
    const result = reorderById(steps, ['s2']); // s1 not mentioned
    expect(result.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('ignores ids not in the current list', () => {
    const steps = [{ id: 's1' }, { id: 's2' }];
    const result = reorderById(steps, ['s3', 's1', 's2']); // s3 doesn't exist
    expect(result.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('does not duplicate items', () => {
    const steps = [{ id: 's1' }, { id: 's2' }];
    const result = reorderById(steps, ['s1', 's1', 's2']); // duplicate
    const ids = result.map((s) => s.id);
    const deduped = [...new Set(ids)];
    expect(ids).toEqual(deduped);
  });
});

// ─── deletePreScript contract ─────────────────────────────────────────────────

describe('deletePreScript contract', () => {
  it('removes a script by id from a step', () => {
    const scripts = [{ id: 'sc1' }, { id: 'sc2' }];
    const result = scripts.filter((sc) => sc.id !== 'sc1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sc2');
  });
});

// ─── reorderPreScripts contract ───────────────────────────────────────────────

describe('reorderPreScripts contract', () => {
  it('reorders scripts within a step', () => {
    const scripts = [{ id: 'sc1' }, { id: 'sc2' }, { id: 'sc3' }];
    const result = reorderById(scripts, ['sc3', 'sc1', 'sc2']);
    expect(result.map((sc) => sc.id)).toEqual(['sc3', 'sc1', 'sc2']);
  });
});
