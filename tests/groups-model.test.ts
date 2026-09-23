import { describe, it, expect, vi } from 'vitest';
import type { Group, PreStep } from '../src/domain-types.js';

// Mock uuid for predictable id generation
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-fixed'),
}));

import {
  normalizeGroup,
  normalizeCommand,
  materializeEnv,
  migratePreScriptPipeline,
  prunePipelineRefs,
  reorderByIds,
  assignScriptToStep,
  unassignScriptFromStep,
  validateGroupShape,
  enforceSingleModeAutoStart,
  clampMaxLogLinesOrNull,
  clampTimeoutOrNull,
  clampConfirmSecsOrNull,
} from '../src/groups-model.js';

// ─── normalizeGroup ───────────────────────────────────────────────────

describe('validateGroupShape', () => {
  it('returns valid true for a well-formed group', () => {
    const g = normalizeGroup({
      name: 'My Group',
      path: '/some/path',
      mode: 'multi',
    });
    expect(validateGroupShape(g).valid).toBe(true);
  });

  it('returns error for empty path', () => {
    const g = { name: 'G', path: '', mode: 'multi' };
    const r = validateGroupShape(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('path'))).toBe(true);
  });

  it('returns error for null group', () => {
    const r = validateGroupShape(null);
    expect(r.valid).toBe(false);
  });

  it('returns error for invalid mode', () => {
    const g = { name: 'G', path: '/p', mode: 'other' };
    const r = validateGroupShape(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('mode'))).toBe(true);
  });
});

// ─── validateGroupShape — preScripts field ──────────────────────────────

describe('validateGroupShape — preScripts field', () => {
  it('accepts a well-formed flat preScripts array', () => {
    const g = {
      name: 'G',
      path: '/p',
      mode: 'multi',
      preScripts: [{ id: 'sc1', name: 'Prep', command: 'true' }],
    };
    expect(validateGroupShape(g).valid).toBe(true);
  });

  it('reports an error when preScripts is not an array', () => {
    const g = { name: 'G', path: '/p', mode: 'multi', preScripts: 'nope' };
    const r = validateGroupShape(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('preScripts'))).toBe(true);
  });

  it('reports an error for a preScripts entry missing an id', () => {
    const g = {
      name: 'G',
      path: '/p',
      mode: 'multi',
      preScripts: [{ name: 'Prep', command: 'true' }],
    };
    const r = validateGroupShape(g);
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes('preScripts[0]') && e.includes('id')),
    ).toBe(true);
  });
});

// ─── regenerateLegacyServices ────────────────────────────────────────

describe('enforceSingleModeAutoStart', () => {
  function makeGroup(
    mode: Group['mode'],
    autoStarts: readonly boolean[],
  ): Group {
    return normalizeGroup({
      id: 'g1',
      name: 'G',
      path: '/p',
      mode,
      commands: autoStarts.map((autoStart, index) => ({
        id: `c${index}`,
        name: `Cmd ${index}`,
        command: 'echo ok',
        autoStart,
      })),
    });
  }

  it('multi mode with N autoStarts — unchanged, changed:false', () => {
    const group = makeGroup('multi', [true, true, true]);
    const { group: out, changed } = enforceSingleModeAutoStart(group);
    expect(changed).toBe(false);
    expect(out).toBe(group); // same reference
    expect(out.commands.filter((c) => c.autoStart)).toHaveLength(3);
  });

  it('single mode with 0 autoStarts — unchanged, changed:false', () => {
    const group = makeGroup('single', [false, false]);
    const { changed } = enforceSingleModeAutoStart(group);
    expect(changed).toBe(false);
  });

  it('single mode with 1 autoStart — unchanged, changed:false', () => {
    const group = makeGroup('single', [false, true]);
    const { changed } = enforceSingleModeAutoStart(group);
    expect(changed).toBe(false);
  });

  it('single mode with 2+ autoStarts — all cleared, changed:true', () => {
    const group = makeGroup('single', [true, true, false]);
    const { group: out, changed } = enforceSingleModeAutoStart(group);
    expect(changed).toBe(true);
    expect(out.commands.every((c) => c.autoStart === false)).toBe(true);
  });

  it('single mode with all autoStarts — all cleared, changed:true', () => {
    const group = makeGroup('single', [true, true, true]);
    const { group: out, changed } = enforceSingleModeAutoStart(group);
    expect(changed).toBe(true);
    expect(out.commands.every((c) => c.autoStart === false)).toBe(true);
  });

  it('null group — returns unchanged with changed:false', () => {
    const { changed } = enforceSingleModeAutoStart(null);
    expect(changed).toBe(false);
  });
});

// ─── clampMaxLogLinesOrNull ──────────────────────────────────────────────

describe('clampMaxLogLinesOrNull', () => {
  it('returns null for undefined', () => {
    expect(clampMaxLogLinesOrNull(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(clampMaxLogLinesOrNull(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(clampMaxLogLinesOrNull('')).toBeNull();
  });

  it('returns null for NaN string', () => {
    expect(clampMaxLogLinesOrNull('abc')).toBeNull();
  });

  it('preserves a valid value within range', () => {
    expect(clampMaxLogLinesOrNull(500)).toBe(500);
    expect(clampMaxLogLinesOrNull(2000)).toBe(2000);
  });

  it('clamps below floor (50 → 100)', () => {
    expect(clampMaxLogLinesOrNull(50)).toBe(100);
  });

  it('clamps at floor boundary (100 → 100)', () => {
    expect(clampMaxLogLinesOrNull(100)).toBe(100);
  });

  it('clamps above ceiling (99999 → 50000)', () => {
    expect(clampMaxLogLinesOrNull(99999)).toBe(50000);
  });

  it('clamps at ceiling boundary (50000 → 50000)', () => {
    expect(clampMaxLogLinesOrNull(50000)).toBe(50000);
  });

  it('floors float values', () => {
    expect(clampMaxLogLinesOrNull(500.9)).toBe(500);
  });
});

// ─── normalizeCommand — maxLogLines field ───────────────────────────────

describe('action effective env — inheritGroupEnv semantics', () => {
  const groupEnv = [
    { key: 'A', value: '1', enabled: true },
    { key: 'B', value: '2', enabled: true },
  ];

  it('with inheritGroupEnv:false — only action env applies', () => {
    const actionEnv = [{ key: 'FOO', value: 'bar', enabled: true }];
    // Simulate what process-manager does: no group env when inheritGroupEnv:false
    const env = { ...materializeEnv(actionEnv) };
    expect(env).toEqual({ FOO: 'bar' });
    expect(env).not.toHaveProperty('A');
    expect(env).not.toHaveProperty('B');
  });

  it('with inheritGroupEnv:true — group env + action env, action wins on conflict', () => {
    const actionEnv = [{ key: 'A', value: '2-override', enabled: true }];
    // Simulate: group env applied first, then action env overwrites
    const env = {
      ...materializeEnv(groupEnv),
      ...materializeEnv(actionEnv),
    };
    expect(env.A).toBe('2-override'); // action wins
    expect(env.B).toBe('2'); // group still present
  });

  it('disabled action env entries are excluded', () => {
    const actionEnv = [
      { key: 'FOO', value: 'bar', enabled: true },
      { key: 'SECRET', value: 'shh', enabled: false },
    ];
    const env = { ...materializeEnv(groupEnv), ...materializeEnv(actionEnv) };
    expect(env.FOO).toBe('bar');
    expect(env).not.toHaveProperty('SECRET');
  });
});

// ─── normalizePreScript ──────────────────────────────────────────────────

describe('clampTimeoutOrNull', () => {
  it('returns null for undefined', () => {
    expect(clampTimeoutOrNull(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(clampTimeoutOrNull(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(clampTimeoutOrNull('')).toBeNull();
  });

  it('returns null for NaN (string)', () => {
    expect(clampTimeoutOrNull('abc')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(clampTimeoutOrNull(0)).toBeNull();
  });

  it('returns null for negative value', () => {
    expect(clampTimeoutOrNull(-100)).toBeNull();
  });

  it('preserves valid in-range value', () => {
    expect(clampTimeoutOrNull(5000)).toBe(5000);
  });

  it('clamps below minimum (500 → 1000)', () => {
    expect(clampTimeoutOrNull(500)).toBe(1000);
  });

  it('clamps above maximum (9_999_999 → 3_600_000)', () => {
    expect(clampTimeoutOrNull(9_999_999)).toBe(3_600_000);
  });

  it('accepts numeric string "5000" → 5000', () => {
    expect(clampTimeoutOrNull('5000')).toBe(5000);
  });

  it('rounds float values', () => {
    expect(clampTimeoutOrNull(5000.7)).toBe(5001);
  });
});

// ─── normalizePreScript — timeoutMs field ────────────────────────────────

describe('clampConfirmSecsOrNull', () => {
  it('returns null for undefined', () => {
    expect(clampConfirmSecsOrNull(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(clampConfirmSecsOrNull(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(clampConfirmSecsOrNull('')).toBeNull();
  });

  it('returns null for NaN (string)', () => {
    expect(clampConfirmSecsOrNull('abc')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(clampConfirmSecsOrNull(0)).toBeNull();
  });

  it('returns null for negative value', () => {
    expect(clampConfirmSecsOrNull(-100)).toBeNull();
  });

  it('preserves valid in-range value', () => {
    expect(clampConfirmSecsOrNull(60)).toBe(60);
  });

  it('clamps below minimum (1 → 3)', () => {
    expect(clampConfirmSecsOrNull(1)).toBe(3);
  });

  it('preserves minimum boundary (3 → 3)', () => {
    expect(clampConfirmSecsOrNull(3)).toBe(3);
  });

  it('preserves maximum boundary (3600 → 3600)', () => {
    expect(clampConfirmSecsOrNull(3600)).toBe(3600);
  });

  it('clamps above maximum (999999 → 3600)', () => {
    expect(clampConfirmSecsOrNull(999999)).toBe(3600);
  });
});

// ─── normalizePreScript — confirm fields ─────────────────────────────────

describe('stringArray coercion — legacy numeric args', () => {
  it('preserves numeric args as strings instead of dropping them', () => {
    const c = normalizeCommand({
      id: 'c1',
      name: 'Serve',
      command: 'http-server',
      args: ['--port', 3000, '-c', 0],
    });
    expect(c.args).toEqual(['--port', '3000', '-c', '0']);
  });

  it('drops values that were never spawnable (objects, null, NaN)', () => {
    const c = normalizeCommand({
      id: 'c1',
      name: 'Serve',
      command: 'x',
      args: ['ok', null, { a: 1 }, Number.NaN, Infinity],
    });
    expect(c.args).toEqual(['ok']);
  });

  it('coerces numeric silencedPatterns entries', () => {
    const c = normalizeCommand({
      id: 'c1',
      name: 'Serve',
      command: 'x',
      silencedPatterns: { warn: [404, 'timeout'], error: [] },
    });
    expect(c.silencedPatterns.warn).toEqual(['404', 'timeout']);
  });
});

describe('migratePreScriptPipeline', () => {
  const baseGroup = (overrides: Record<string, unknown>) => ({
    name: 'G',
    path: '/g',
    mode: 'multi',
    order: 0,
    silenceWarnings: false,
    silenceErrors: false,
    env: [],
    commands: [],
    actions: [],
    ...overrides,
  });

  it('concatenates each group legacy steps into the global pipeline, ordered by group order', () => {
    const result = migratePreScriptPipeline({
      groups: [
        baseGroup({
          id: 'gB',
          order: 1,
          preSteps: [
            {
              id: 'stepY',
              mode: 'parallel',
              scripts: [{ id: 'y1', name: 'Y', command: 'true' }],
            },
          ],
        }),
        baseGroup({
          id: 'gA',
          order: 0,
          preSteps: [
            {
              id: 'stepX',
              mode: 'parallel',
              scripts: [{ id: 'x1', name: 'X', command: 'true' }],
            },
          ],
        }),
      ],
    });
    expect(result.preSteps.map((s) => s.id)).toEqual(['stepX', 'stepY']);
    expect(result.preSteps[0].scripts).toEqual([
      { groupId: 'gA', scriptId: 'x1' },
    ]);
    expect(result.preSteps[1].scripts).toEqual([
      { groupId: 'gB', scriptId: 'y1' },
    ]);
  });

  it('hoists inline script definitions into the flat preScripts, de-duplicating by id', () => {
    const result = migratePreScriptPipeline({
      groups: [
        baseGroup({
          id: 'g1',
          preScripts: [{ id: 'sc1', name: 'Existing', command: 'true' }],
          preSteps: [
            {
              id: 'step1',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'Existing', command: 'true' }],
            },
            {
              id: 'step2',
              mode: 'parallel',
              scripts: [{ id: 'sc2', name: 'New', command: 'echo hi' }],
            },
          ],
        }),
      ],
    });
    expect(result.groups[0]?.preScripts.map((s) => s.id)).toEqual([
      'sc1',
      'sc2',
    ]);
  });

  it('reuses a free legacy step id, and mints distinct ids for a repeated or missing one — even from a fixed uuid source', () => {
    const result = migratePreScriptPipeline({
      groups: [
        baseGroup({
          id: 'g1',
          order: 0,
          preSteps: [
            {
              id: 'stepA',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        }),
        baseGroup({
          id: 'g2',
          order: 1,
          preSteps: [
            // Same id as g1's step: legal when step ids were group-scoped,
            // now a collision since step ids are global.
            {
              id: 'stepA',
              mode: 'parallel',
              scripts: [{ id: 'sc2', name: 'B', command: 'true' }],
            },
            // No id at all.
            {
              mode: 'parallel',
              scripts: [{ id: 'sc3', name: 'C', command: 'true' }],
            },
          ],
        }),
      ],
    });
    const ids = result.preSteps.map((s) => s.id);
    expect(ids[0]).toBe('stepA');
    expect(new Set(ids).size).toBe(3);
  });

  it('mints a distinct id for a migrated legacy step whose id collides with an EXISTING top-level step', () => {
    const result = migratePreScriptPipeline({
      groups: [
        baseGroup({
          id: 'g1',
          order: 0,
          preSteps: [
            {
              // Legal collision: step ids were group-scoped pre-migration,
              // and this literal id already belongs to a top-level step
              // below (global-scoped, unrelated group).
              id: 'shared-id',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        }),
      ],
      preSteps: [{ id: 'shared-id', mode: 'serial', scripts: [] }],
    });
    const ids = result.preSteps.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('AND-folds preScriptsAutoRun to true when every contributing group had it true', () => {
    const result = migratePreScriptPipeline({
      groups: [
        baseGroup({
          id: 'a',
          order: 0,
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'stepA',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        }),
        baseGroup({
          id: 'b',
          order: 1,
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'stepB',
              mode: 'parallel',
              scripts: [{ id: 'sc2', name: 'B', command: 'true' }],
            },
          ],
        }),
      ],
    });
    expect(result.preScriptsAutoRun).toBe(true);
  });

  it('AND-folds preScriptsAutoRun to false when one contributing group had it false', () => {
    const result = migratePreScriptPipeline({
      groups: [
        baseGroup({
          id: 'a',
          order: 0,
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'stepA',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        }),
        baseGroup({
          id: 'b',
          order: 1,
          preScriptsAutoRun: false,
          preSteps: [
            {
              id: 'stepB',
              mode: 'parallel',
              scripts: [{ id: 'sc2', name: 'B', command: 'true' }],
            },
          ],
        }),
      ],
    });
    expect(result.preScriptsAutoRun).toBe(false);
  });

  it('folds preScriptsAutoRun to false when there are zero contributing groups', () => {
    const result = migratePreScriptPipeline({
      groups: [baseGroup({ id: 'a', order: 0, preScriptsAutoRun: true })],
    });
    expect(result.changed).toBe(true);
    expect(result.preScriptsAutoRun).toBe(false);
  });

  it('is idempotent: migrating an already-migrated shape again reports changed:false with no duplication', () => {
    const raw = {
      groups: [
        baseGroup({
          id: 'g1',
          preSteps: [
            {
              id: 'step1',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        }),
      ],
    };
    const first = migratePreScriptPipeline(raw);
    expect(first.changed).toBe(true);

    const second = migratePreScriptPipeline({
      groups: first.groups,
      preSteps: first.preSteps,
    });
    expect(second.changed).toBe(false);
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]?.preScripts).toHaveLength(1);
    expect(second.preSteps).toHaveLength(1);
    expect(second.preSteps[0]?.scripts).toEqual(first.preSteps[0]?.scripts);
  });
});

// ─── planStoreMigration (composes BOTH migrations for config-store.ts) ──
// config-store.ts is Electron-bound and not importable under Vitest, so this
// pure composition seam (the autostart-schedule.ts precedent) is where the
// version-labelling bug (sdd-verify C1's producer side) is proven directly,
// without electron-store.

describe('prunePipelineRefs', () => {
  const group = (id: string, scriptIds: string[]): Group =>
    normalizeGroup({
      id,
      path: `/${id}`,
      preScripts: scriptIds.map((scriptId) => ({
        id: scriptId,
        name: scriptId,
        command: 'true',
      })),
    });

  it('drops a ref pointing at a deleted group id', () => {
    const groups = [group('g1', ['sc1'])];
    const steps = [
      {
        id: 'step1',
        mode: 'parallel' as const,
        scripts: [
          { groupId: 'g1', scriptId: 'sc1' },
          { groupId: 'deleted-group', scriptId: 'sc9' },
        ],
      },
    ];
    const result = prunePipelineRefs(steps, groups);
    expect(result[0]?.scripts).toEqual([{ groupId: 'g1', scriptId: 'sc1' }]);
  });

  it('drops a ref pointing at a deleted script id within an existing group', () => {
    const groups = [group('g1', ['sc1'])];
    const steps = [
      {
        id: 'step1',
        mode: 'parallel' as const,
        scripts: [
          { groupId: 'g1', scriptId: 'sc1' },
          { groupId: 'g1', scriptId: 'deleted-script' },
        ],
      },
    ];
    const result = prunePipelineRefs(steps, groups);
    expect(result[0]?.scripts).toEqual([{ groupId: 'g1', scriptId: 'sc1' }]);
  });

  it('keeps a step that becomes empty after pruning, rather than dropping it', () => {
    const groups = [group('g1', [])];
    const steps = [
      {
        id: 'step1',
        mode: 'parallel' as const,
        scripts: [{ groupId: 'g1', scriptId: 'gone' }],
      },
    ];
    const result = prunePipelineRefs(steps, groups);
    expect(result).toHaveLength(1);
    expect(result[0]?.scripts).toEqual([]);
  });
});

// ─── assignScriptToStep / unassignScriptFromStep ────────────────────────

describe('assignScriptToStep', () => {
  const fixture = (): PreStep[] => [
    {
      id: 'step1',
      mode: 'parallel',
      scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
    },
    { id: 'step2', mode: 'parallel', scripts: [] },
  ];

  it('appends a fresh ref to the end of the target step by default', () => {
    const result = assignScriptToStep(fixture(), 'step2', {
      groupId: 'g2',
      scriptId: 'sc2',
    });
    expect(result.find((s) => s.id === 'step2')?.scripts).toEqual([
      { groupId: 'g2', scriptId: 'sc2' },
    ]);
  });

  it('inserts at the given position within the target step', () => {
    const twoScripts: PreStep[] = [
      {
        id: 'step1',
        mode: 'parallel',
        scripts: [
          { groupId: 'g1', scriptId: 'a' },
          { groupId: 'g1', scriptId: 'b' },
        ],
      },
    ];
    const result = assignScriptToStep(
      twoScripts,
      'step1',
      { groupId: 'g1', scriptId: 'c' },
      1,
    );
    expect(result[0]?.scripts.map((s) => s.scriptId)).toEqual(['a', 'c', 'b']);
  });

  it('moves a ref from its old step to the target step (cross-container drag)', () => {
    const result = assignScriptToStep(fixture(), 'step2', {
      groupId: 'g1',
      scriptId: 'sc1',
    });
    expect(result.find((s) => s.id === 'step1')?.scripts).toEqual([]);
    expect(result.find((s) => s.id === 'step2')?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc1' },
    ]);
  });

  it('leaves steps other than the source and target unaffected', () => {
    const result = assignScriptToStep(fixture(), 'step2', {
      groupId: 'g2',
      scriptId: 'sc2',
    });
    expect(result.find((s) => s.id === 'step1')?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc1' },
    ]);
  });

  it('returns the steps unchanged when the target stepId does not exist (stale/unknown step)', () => {
    const original = fixture();
    const result = assignScriptToStep(original, 'ghost-step', {
      groupId: 'g1',
      scriptId: 'sc1',
    });
    expect(result).toEqual(original);
  });
});

describe('unassignScriptFromStep', () => {
  it('removes the matching ref from the named step', () => {
    const steps: PreStep[] = [
      {
        id: 'step1',
        mode: 'parallel',
        scripts: [
          { groupId: 'g1', scriptId: 'sc1' },
          { groupId: 'g2', scriptId: 'sc2' },
        ],
      },
    ];
    const result = unassignScriptFromStep(steps, 'step1', {
      groupId: 'g1',
      scriptId: 'sc1',
    });
    expect(result[0]?.scripts).toEqual([{ groupId: 'g2', scriptId: 'sc2' }]);
  });

  it('is a no-op when the ref is not present in that step', () => {
    const steps: PreStep[] = [
      {
        id: 'step1',
        mode: 'parallel',
        scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
      },
    ];
    const result = unassignScriptFromStep(steps, 'step1', {
      groupId: 'gX',
      scriptId: 'scX',
    });
    expect(result[0]?.scripts).toEqual([{ groupId: 'g1', scriptId: 'sc1' }]);
  });
});

// sdd-verify W3: config-store.ts's own reorder helper for groups, commands,
// actions, pre-steps, and pre-scripts (reorderGroups/reorderCommands/
// reorderActions/reorderPreSteps/reorderPreScripts) — moved here so it is a
// real, directly-importable function instead of a hand-copy re-implemented
// inside a test file (config-store.ts itself is Electron-bound and cannot be
// imported under Vitest).

describe('reorderByIds', () => {
  it('reorders items to match orderedIds', () => {
    const items = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const result = reorderByIds(items, ['s3', 's1', 's2']);
    expect(result.map((item) => item.id)).toEqual(['s3', 's1', 's2']);
  });

  it('appends items missing from orderedIds at the end, in their original order', () => {
    const items = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const result = reorderByIds(items, ['s2']);
    expect(result.map((item) => item.id)).toEqual(['s2', 's1', 's3']);
  });

  it('ignores ids in orderedIds that do not match any item', () => {
    const items = [{ id: 's1' }, { id: 's2' }];
    const result = reorderByIds(items, ['ghost', 's1', 's2']);
    expect(result.map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('does not duplicate an item whose id repeats in orderedIds', () => {
    const items = [{ id: 's1' }, { id: 's2' }];
    const result = reorderByIds(items, ['s1', 's1', 's2']);
    expect(result.map((item) => item.id)).toEqual(['s1', 's2']);
  });
});

describe('migratePreScriptPipeline — cross-step ref uniqueness', () => {
  it('places a repeated legacy script ref only once across steps', () => {
    // knownScriptIds dedupes the hoisted DEFINITION, but a ref was pushed for
    // every legacy occurrence. Two refs to one {groupId, scriptId} share a
    // process id, so the later one never really runs and it drags that
    // group's autoStart release out to the later step. validatePipelineSteps
    // rejects this exact shape on import, so the migration must not mint it.
    const result = migratePreScriptPipeline({
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          commands: [],
          actions: [],
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'legacy-1',
              mode: 'serial',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
            {
              id: 'legacy-2',
              mode: 'serial',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        },
      ],
    });
    const placements = result.preSteps.flatMap((step) =>
      step.scripts.filter(
        (ref) => ref.groupId === 'g1' && ref.scriptId === 'sc1',
      ),
    );
    expect(placements).toHaveLength(1);
    expect(result.groups[0]?.preScripts).toHaveLength(1);
  });
});
