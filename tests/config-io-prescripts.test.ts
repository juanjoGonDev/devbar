import { describe, it, expect } from 'vitest';
import {
  validateImportedConfig,
  serializeConfig,
  summarizeImport,
  type ImportValidation,
} from '../src/config-io.js';

/**
 * config-io-prescripts.test.js
 *
 * Tests for the GLOBAL pipeline shape: top-level `preSteps` (refs) plus
 * per-group flat `preScripts` (definitions). Covers round-trip export/import
 * (R10), cross-reference validation of refs, and backward-compatible import
 * of a v3 export file (nested per-group `preSteps`) via the same
 * concatenate-and-hoist migration the live store uses.
 */

function expectValid(
  result: ImportValidation,
): asserts result is Extract<ImportValidation, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
}

function expectInvalid(
  result: ImportValidation,
): asserts result is Extract<ImportValidation, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected invalid import');
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_PIPELINE_PAYLOAD = {
  version: 4,
  groups: [
    {
      id: 'g1',
      name: 'My Group',
      path: '/some/path',
      mode: 'multi',
      env: [],
      commands: [],
      actions: [],
      preScripts: [
        {
          id: 'sc-bbb',
          name: 'Install',
          command: 'pnpm install',
          args: ['--frozen-lockfile'],
          env: [{ key: 'NODE_ENV', value: 'ci', enabled: true }],
          inheritGroupEnv: false,
        },
        {
          id: 'sc-ccc',
          name: 'Build',
          command: 'pnpm build',
          args: [],
          env: [],
          inheritGroupEnv: true,
        },
      ],
    },
    {
      id: 'g2',
      name: 'Other Group',
      path: '/other/path',
      mode: 'multi',
      env: [],
      commands: [],
      actions: [],
      preScripts: [
        {
          id: 'sc-eee',
          name: 'Lint',
          command: 'pnpm lint',
          args: [],
          env: [],
        },
      ],
    },
  ],
  preSteps: [
    {
      id: 'step-aaa',
      mode: 'serial',
      scripts: [
        { groupId: 'g1', scriptId: 'sc-bbb' },
        { groupId: 'g1', scriptId: 'sc-ccc' },
      ],
    },
    {
      id: 'step-ddd',
      mode: 'parallel',
      scripts: [{ groupId: 'g2', scriptId: 'sc-eee' }],
    },
  ],
  globalSettings: {
    autostart: false,
    silenceWarnings: false,
    silenceErrors: false,
    preScriptsAutoRun: false,
  },
};

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('validateImportedConfig — global preSteps round-trip (R10)', () => {
  it('accepts a valid v4 payload with a global pipeline', () => {
    const result = validateImportedConfig(VALID_PIPELINE_PAYLOAD);
    expectValid(result);
  });

  it('preserves preSteps in the returned payload (round-trip)', () => {
    const result = validateImportedConfig(VALID_PIPELINE_PAYLOAD);
    expectValid(result);
    expect(result.payload.preSteps).toHaveLength(2);
    expect(result.payload.preSteps[0]?.id).toBe('step-aaa');
    expect(result.payload.preSteps[0]?.mode).toBe('serial');
    expect(result.payload.preSteps[0]?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc-bbb' },
      { groupId: 'g1', scriptId: 'sc-ccc' },
    ]);
  });

  it('preserves all step and script ids verbatim', () => {
    const result = validateImportedConfig(VALID_PIPELINE_PAYLOAD);
    expectValid(result);
    const stepIds = result.payload.preSteps.map((s) => s.id);
    const scriptIds = result.payload.groups.flatMap((g) =>
      g.preScripts.map((sc) => sc.id),
    );
    expect(stepIds).toEqual(['step-aaa', 'step-ddd']);
    expect(scriptIds).toEqual(['sc-bbb', 'sc-ccc', 'sc-eee']);
  });

  it('accepts a payload with no preSteps key (defaults to [])', () => {
    const payload = {
      version: 4,
      groups: [
        { name: 'G', path: '/p', mode: 'multi', commands: [], actions: [] },
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectValid(result);
    expect(result.payload.preSteps).toEqual([]);
    expect(result.payload.groups[0]?.preScripts).toEqual([]);
  });
});

// ─── Cross-reference validation ────────────────────────────────────────────────

describe('validateImportedConfig — pipeline cross-reference validation', () => {
  const oneScriptGroup = {
    id: 'g1',
    name: 'G',
    path: '/p',
    mode: 'multi',
    commands: [],
    actions: [],
    preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
  };

  it('rejects a ref pointing at a group id absent from the payload', () => {
    const payload = {
      version: 4,
      groups: [oneScriptGroup],
      preSteps: [
        {
          id: 's1',
          mode: 'parallel',
          scripts: [{ groupId: 'ghost-group', scriptId: 'sc1' }],
        },
      ],
      globalSettings: {},
    };
    expectInvalid(validateImportedConfig(payload));
  });

  it('rejects a ref pointing at a script id not defined in that group', () => {
    const payload = {
      version: 4,
      groups: [oneScriptGroup],
      preSteps: [
        {
          id: 's1',
          mode: 'parallel',
          scripts: [{ groupId: 'g1', scriptId: 'ghost-script' }],
        },
      ],
      globalSettings: {},
    };
    expectInvalid(validateImportedConfig(payload));
  });

  it('accepts a ref that resolves correctly', () => {
    const payload = {
      version: 4,
      groups: [oneScriptGroup],
      preSteps: [
        {
          id: 's1',
          mode: 'parallel',
          scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
        },
      ],
      globalSettings: {},
    };
    expectValid(validateImportedConfig(payload));
  });

  it('rejects when preSteps is not an array', () => {
    const payload = {
      version: 4,
      groups: [],
      preSteps: 'not-an-array',
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toMatch(/preSteps/);
  });
});

// ─── Malformed pipeline shapes (v4, native — not migration-relaxed) ────────────

describe('validateImportedConfig — rejects malformed pipeline shapes (v4)', () => {
  const baseGroup = (preScripts: unknown[]) => ({
    id: 'g1',
    name: 'G',
    path: '/p',
    mode: 'multi',
    commands: [],
    actions: [],
    preScripts,
  });

  it('rejects a preScripts entry with missing command', () => {
    const payload = {
      version: 4,
      groups: [baseGroup([{ id: 'sc1', name: 'Install' }])],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toContain('pre-script sin command');
  });

  it('rejects a preScripts entry with empty command', () => {
    const payload = {
      version: 4,
      groups: [baseGroup([{ id: 'sc1', name: 'Install', command: '' }])],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toContain('pre-script sin command');
  });

  it('rejects a preScripts entry with missing name', () => {
    const payload = {
      version: 4,
      groups: [baseGroup([{ id: 'sc1', command: 'pnpm install' }])],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toContain('pre-script sin name');
  });

  it('rejects a preScripts entry with invalid env shape (string)', () => {
    const payload = {
      version: 4,
      groups: [
        baseGroup([
          { id: 'sc1', name: 'Build', command: 'pnpm build', env: 'bad' },
        ]),
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toContain('env inválido');
  });

  it('rejects a preSteps entry with an invalid mode', () => {
    const payload = {
      version: 4,
      groups: [baseGroup([{ id: 'sc1', name: 'A', command: 'true' }])],
      preSteps: [{ id: 's1', mode: 'batch', scripts: [] }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toContain('mode inválido');
  });

  it('rejects a preSteps entry where scripts is not an array', () => {
    const payload = {
      version: 4,
      groups: [baseGroup([])],
      preSteps: [{ id: 's1', mode: 'parallel', scripts: 'not-an-array' }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectInvalid(result);
    expect(result.error).toMatch(/scripts/);
  });
});

// ─── v3 payload imports as v4 (backward compatible) ────────────────────────────

describe('validateImportedConfig — v3 payload imports as v4 (backward compatible)', () => {
  it('keeps preScriptsAutoRun when a v3 group has an empty legacy preSteps', () => {
    // `changed` goes true for the empty legacy key, but nothing contributes,
    // so the AND-fold must not overwrite the payload's own setting. Same
    // guard planStoreMigration already uses on the live-store path.
    const payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preSteps: [],
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
        preScriptsAutoRun: true,
      },
    };
    const result = validateImportedConfig(payload);
    expectValid(result);
    expect(result.payload.globalSettings.preScriptsAutoRun).toBe(true);
  });

  it('rejects two steps sharing an id', () => {
    // savePreStep updates only the first match, deletePreStep removes every
    // match, and reorderByIds keys a Map by id — a duplicate makes all three
    // act on the wrong step.
    const result = validateImportedConfig({
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
        },
      ],
      preSteps: [
        {
          id: 'dup',
          mode: 'serial',
          scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
        },
        { id: 'dup', mode: 'serial', scripts: [] },
      ],
      globalSettings: {},
    });
    expect(result.ok).toBe(false);
  });

  it('rejects the same script placed in two different steps', () => {
    // Both placements share one pid, so the second never really runs, and the
    // group's autoStart release is pushed out to the later step.
    const result = validateImportedConfig({
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
        },
      ],
      preSteps: [
        {
          id: 'st1',
          mode: 'serial',
          scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
        },
        {
          id: 'st2',
          mode: 'serial',
          scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
        },
      ],
      globalSettings: {},
    });
    expect(result.ok).toBe(false);
  });

  it('keeps the payload preScriptsAutoRun when a v3 label carries v4 data', () => {
    // A store mislabelled v3 that already holds v4 data has zero legacy
    // contributors, so the AND-fold would resolve to false and silently turn
    // off an auto-run the user had enabled.
    const payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'Ya migrado',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'Install', command: 'pnpm install' }],
        },
      ],
      preSteps: [
        {
          id: 'st1',
          mode: 'serial',
          scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
        preScriptsAutoRun: true,
      },
    };
    const result = validateImportedConfig(payload);
    expectValid(result);
    expect(result.payload.globalSettings.preScriptsAutoRun).toBe(true);
    expect(result.payload.preSteps).toHaveLength(1);
  });

  it('keeps refs resolvable when a v3 group carries no id of its own', () => {
    // The migration mints an id for an id-less group and points its refs at
    // it. If the importer then re-normalizes the RAW group, a second,
    // different uuid is minted and cross-reference validation rejects the
    // whole import.
    const v3Payload = {
      version: 3,
      groups: [
        {
          name: 'Sin id',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'step-aaa',
              mode: 'serial',
              scripts: [
                {
                  id: 'sc-bbb',
                  name: 'Install',
                  command: 'pnpm install',
                  args: [],
                  env: [],
                },
              ],
            },
          ],
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
      },
    };
    const result = validateImportedConfig(v3Payload);
    expectValid(result);
    const groupId = result.payload.groups[0]?.id;
    expect(groupId).toBeTruthy();
    expect(result.payload.preSteps[0]?.scripts).toEqual([
      { groupId, scriptId: 'sc-bbb' },
    ]);
  });

  it('migrates a v3 export (nested per-group preSteps) into the global pipeline', () => {
    const v3Payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'step-aaa',
              mode: 'serial',
              scripts: [
                {
                  id: 'sc-bbb',
                  name: 'Install',
                  command: 'pnpm install',
                  args: [],
                  env: [],
                },
              ],
            },
          ],
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
      },
    };
    const result = validateImportedConfig(v3Payload);
    expectValid(result);
    expect(result.payload.version).toBe(4);
    expect(result.payload.preSteps).toHaveLength(1);
    expect(result.payload.preSteps[0]?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc-bbb' },
    ]);
    expect(result.payload.groups[0]?.preScripts.map((s) => s.id)).toEqual([
      'sc-bbb',
    ]);
    expect(result.payload.globalSettings.preScriptsAutoRun).toBe(true);
  });

  it("preserves a v3 payload's own top-level preSteps alongside newly-hoisted ones (no silent data loss)", () => {
    // Models a v3-mislabelled store that already picked up real v4 data (see
    // the config-store version-labelling fix): a top-level `preSteps` the
    // pre-0.8.0 app never wrote, referencing a script defined natively via
    // flat `preScripts`, PLUS a still-unmigrated legacy per-group step.
    const v3Payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScripts: [
            { id: 'sc-existing', name: 'Existing', command: 'pnpm existing' },
          ],
          preSteps: [
            {
              id: 'step-legacy',
              mode: 'serial',
              scripts: [
                {
                  id: 'sc-legacy',
                  name: 'Legacy',
                  command: 'pnpm legacy',
                  args: [],
                  env: [],
                },
              ],
            },
          ],
        },
      ],
      preSteps: [
        {
          id: 'step-existing',
          mode: 'parallel',
          scripts: [{ groupId: 'g1', scriptId: 'sc-existing' }],
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
      },
    };
    const result = validateImportedConfig(v3Payload);
    expectValid(result);
    expect(result.payload.preSteps).toHaveLength(2);
    expect(result.payload.preSteps.map((s) => s.id)).toEqual([
      'step-existing',
      'step-legacy',
    ]);
    expect(result.payload.preSteps[0]?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc-existing' },
    ]);
    expect(result.payload.preSteps[1]?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc-legacy' },
    ]);
    expect(
      result.payload.groups[0]?.preScripts.map((s) => s.id).sort(),
    ).toEqual(['sc-existing', 'sc-legacy']);
  });

  it("rejects a v3 payload's own top-level preSteps entry with an invalid mode instead of silently defaulting it", () => {
    // Only migratePreScriptPipeline's HOISTED steps are trustworthy
    // pass-through; the payload's own top-level preSteps must still face the
    // exact same strict validation a v4 payload's would.
    const v3Payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
        },
      ],
      preSteps: [{ id: 'step-bad', mode: 'batch', scripts: [] }],
      globalSettings: {},
    };
    const result = validateImportedConfig(v3Payload);
    expectInvalid(result);
    expect(result.error).toContain('mode inválido');
  });

  it("rejects a v3 payload's own top-level preSteps entry whose scripts is not an array instead of silently dropping it", () => {
    const v3Payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
        },
      ],
      preSteps: [{ id: 'step-bad', mode: 'parallel', scripts: 'not-an-array' }],
      globalSettings: {},
    };
    const result = validateImportedConfig(v3Payload);
    expectInvalid(result);
    expect(result.error).toMatch(/scripts/);
  });

  it("rejects a v3 payload's own top-level preSteps ref missing an id instead of silently dropping it", () => {
    const v3Payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
        },
      ],
      preSteps: [
        {
          id: 'step-bad',
          mode: 'parallel',
          scripts: [{ groupId: '', scriptId: 'sc1' }],
        },
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(v3Payload);
    expectInvalid(result);
    expect(result.error).toContain('referencia un grupo o script inexistente');
  });

  it('rejects a v3 payload whose own top-level preSteps is not an array instead of silently discarding it', () => {
    const v3Payload = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          path: '/some/path',
          mode: 'multi',
          env: [],
          commands: [],
          actions: [],
          preScripts: [{ id: 'sc1', name: 'A', command: 'true' }],
        },
      ],
      preSteps: 'not-an-array',
      globalSettings: {},
    };
    const result = validateImportedConfig(v3Payload);
    expectInvalid(result);
    expect(result.error).toMatch(/preSteps/);
  });

  it('rejects an unsupported version (neither 3 nor 4)', () => {
    const result = validateImportedConfig({
      version: 2,
      groups: [],
      globalSettings: {},
    });
    expectInvalid(result);
    expect(result.error).toMatch(/versión/i);
  });
});

// ─── export → import round-trip (S3) ───────────────────────────────────────────

describe('serializeConfig -> validateImportedConfig round-trip', () => {
  it('a live store with a real global pipeline exports and re-imports losslessly', () => {
    const rawStore = {
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          icon: '📦',
          path: '/some/path',
          mode: 'multi' as const,
          order: 0,
          silenceWarnings: false,
          silenceErrors: false,
          env: [],
          commands: [],
          actions: [],
          waitForPipeline: true,
          preScripts: [
            {
              id: 'sc-bbb',
              name: 'Install',
              command: 'pnpm install',
              args: [],
              env: [],
              inheritGroupEnv: false,
              confirm: false,
              confirmSecs: null,
              confirmOnTimeout: 'cancel' as const,
              timeoutMs: null,
            },
          ],
        },
      ],
      // Store-shaped input is already normalized (as `getGroupsInternal()`
      // would read it) — exercising the actual export/import ROUND TRIP,
      // not `normalizeGroup`'s own default-filling (already covered
      // elsewhere).
      preSteps: [
        {
          id: 'step-aaa',
          mode: 'serial' as const,
          scripts: [{ groupId: 'g1', scriptId: 'sc-bbb' }],
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
        preScriptsAutoRun: true,
      },
    };
    const exported = serializeConfig(rawStore, '0.8.0');
    const result = validateImportedConfig(exported);
    expectValid(result);
    // Asserted against literals, NOT against `exported`: comparing the
    // import result to its own export output passes vacuously the moment
    // both sides degenerate to [] (exactly the data-loss shape of C1).
    expect(result.payload.preSteps).toEqual([
      {
        id: 'step-aaa',
        mode: 'serial',
        scripts: [{ groupId: 'g1', scriptId: 'sc-bbb' }],
      },
    ]);
    expect(result.payload.groups[0]?.preScripts).toHaveLength(1);
    expect(result.payload.groups[0]?.preScripts[0]).toMatchObject({
      id: 'sc-bbb',
      name: 'Install',
      command: 'pnpm install',
    });
    expect(result.payload.globalSettings.preScriptsAutoRun).toBe(true);
  });
});

// ─── summarizeImport with the global pipeline ──────────────────────────────────

describe('summarizeImport — preStepsCount / preScriptsCount', () => {
  it('preStepsCount counts global steps; preScriptsCount counts definitions', () => {
    const result = validateImportedConfig(VALID_PIPELINE_PAYLOAD);
    expectValid(result);
    const summary = summarizeImport(result.payload);
    expect(summary.preStepsCount).toBe(2);
    expect(summary.preScriptsCount).toBe(3);
  });

  it('preScriptsCount counts a defined-but-unplaced script (definitions, not placements)', () => {
    const payload = {
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          commands: [],
          actions: [],
          preScripts: [
            { id: 'sc1', name: 'Placed', command: 'true' },
            { id: 'sc2', name: 'Unplaced', command: 'true' },
          ],
        },
      ],
      preSteps: [
        {
          id: 's1',
          mode: 'parallel',
          scripts: [{ groupId: 'g1', scriptId: 'sc1' }],
        },
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectValid(result);
    const summary = summarizeImport(result.payload);
    expect(summary.preScriptsCount).toBe(2);
  });

  it('returns 0 for preStepsCount and preScriptsCount when the pipeline is empty', () => {
    const payload = {
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          commands: [],
          actions: [],
        },
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expectValid(result);
    const summary = summarizeImport(result.payload);
    expect(summary.preStepsCount).toBe(0);
    expect(summary.preScriptsCount).toBe(0);
  });
});
