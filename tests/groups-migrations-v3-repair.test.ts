import { describe, it, expect, vi } from 'vitest';

// Mock uuid for predictable id generation
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-fixed'),
}));

import {
  migrateServicesToGroups,
  planStoreMigration,
} from '../src/groups-model.js';

// ─── normalizeGroup ───────────────────────────────────────────────────

describe('migrateServicesToGroups — env shape migration on v3 state', () => {
  it('migrates command.env object to array on v3 state', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [
            {
              id: 'c1',
              name: 'Dev',
              icon: null,
              command: 'pnpm dev',
              args: [],
              env: { PORT: '3000' }, // legacy object shape
              cwd: null,
              warnRegex: '\\bwarn(ing)?s?\\b',
              errorRegex: '\\berror(s)?\\b',
              silenceWarnings: false,
              silenceErrors: false,
              silencedPatterns: { warn: [], error: [] },
            },
          ],
          actions: [],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(true);
    expect(result.state.groups[0].commands[0].env).toEqual([
      { key: 'PORT', value: '3000', enabled: true },
    ]);
  });

  it('migrates action.env object and sets inheritGroupEnv:false when action had no prior useEnvs', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [],
          actions: [
            {
              id: 'a1',
              name: 'Build',
              icon: null,
              command: 'pnpm build',
              args: [],
              env: { NODE_ENV: 'production' }, // legacy object shape
              // no useEnvs or inheritGroupEnv field
            },
          ],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(true);
    const act = result.state.groups[0].actions[0];
    expect(act.env).toEqual([
      { key: 'NODE_ENV', value: 'production', enabled: true },
    ]);
    // No prior useEnvs → inheritGroupEnv defaults to false
    expect(act.inheritGroupEnv).toBe(false);
    expect(act).not.toHaveProperty('useEnvs');
  });

  it('migrates action with useEnvs:true to inheritGroupEnv:true and drops useEnvs', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [],
          actions: [
            {
              id: 'a1',
              name: 'Build',
              icon: null,
              command: 'pnpm build',
              args: [],
              env: [{ key: 'NODE_ENV', value: 'production', enabled: true }],
              useEnvs: true,
            },
          ],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(true);
    const act = result.state.groups[0].actions[0];
    expect(act.inheritGroupEnv).toBe(true);
    expect(act).not.toHaveProperty('useEnvs');
  });

  it('migrates action with useEnvs:false to inheritGroupEnv:false and drops useEnvs', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [],
          actions: [
            {
              id: 'a1',
              name: 'Clean',
              icon: null,
              command: 'pnpm clean',
              args: [],
              env: [],
              useEnvs: false,
            },
          ],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(true);
    const act = result.state.groups[0].actions[0];
    expect(act.inheritGroupEnv).toBe(false);
    expect(act).not.toHaveProperty('useEnvs');
  });

  it('action without either flag defaults inheritGroupEnv:false', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [],
          actions: [
            {
              id: 'a1',
              name: 'Clean',
              icon: null,
              command: 'pnpm clean',
              args: [],
              env: {}, // empty legacy object triggers migration
              // no useEnvs or inheritGroupEnv
            },
          ],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    const act = result.state.groups[0].actions[0];
    expect(act.env).toEqual([]);
    expect(act.inheritGroupEnv).toBe(false);
  });

  it('already-migrated v3 state with array envs and inheritGroupEnv returns changed:false (idempotent)', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [{ key: 'X', value: '1', enabled: true }],
          commands: [
            {
              id: 'c1',
              name: 'Dev',
              icon: null,
              command: 'pnpm dev',
              args: [],
              env: [{ key: 'PORT', value: '3000', enabled: true }],
              cwd: null,
              warnRegex: '\\bwarn(ing)?s?\\b',
              errorRegex: '\\berror(s)?\\b',
              silenceWarnings: false,
              silenceErrors: false,
              silencedPatterns: { warn: [], error: [] },
              autoStart: false, // fully-migrated state must include this field
            },
          ],
          actions: [
            {
              id: 'a1',
              name: 'Build',
              icon: null,
              command: 'pnpm build',
              args: [],
              env: [],
              inheritGroupEnv: false,
            },
          ],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(false);
  });

  it('sets group.env to [] when missing in v3 state', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          // no env field
          commands: [],
          actions: [],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(true);
    expect(result.state.groups[0].env).toEqual([]);
  });
});

// ─── normalizeCommand — autoStart ────────────────────────────────────

describe('migrateServicesToGroups — autoStart shape-fix on v3 state', () => {
  it('sets autoStart:false on commands that lack the field', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [
            {
              id: 'c1',
              name: 'Dev',
              icon: null,
              command: 'pnpm dev',
              args: [],
              env: [],
              cwd: null,
              warnRegex: '\\bwarn(ing)?s?\\b',
              errorRegex: '\\berror(s)?\\b',
              silenceWarnings: false,
              silenceErrors: false,
              silencedPatterns: { warn: [], error: [] },
              // autoStart intentionally missing
            },
          ],
          actions: [],
        },
      ],
      services: [],
    };
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(true);
    expect(result.state.groups[0].commands[0].autoStart).toBe(false);
  });

  it('preserves autoStart:true on commands that already have it', () => {
    const state = {
      version: 3,
      groups: [
        {
          id: 'g1',
          name: 'G',
          path: '/p',
          mode: 'multi',
          silenceWarnings: false,
          silenceErrors: false,
          order: 0,
          env: [],
          commands: [
            {
              id: 'c1',
              name: 'Dev',
              icon: null,
              command: 'pnpm dev',
              args: [],
              env: [],
              cwd: null,
              warnRegex: '\\bwarn(ing)?s?\\b',
              errorRegex: '\\berror(s)?\\b',
              silenceWarnings: false,
              silenceErrors: false,
              silencedPatterns: { warn: [], error: [] },
              autoStart: true,
            },
          ],
          actions: [],
        },
      ],
      services: [],
    };
    // A fully-migrated state with autoStart already present should be idempotent
    const result = migrateServicesToGroups(state);
    expect(result.changed).toBe(false);
    expect(result.state.groups[0].commands[0].autoStart).toBe(true);
  });
});

// ─── enforceSingleModeAutoStart ───────────────────────────────────────

describe('migrateServicesToGroups — id repair is persisted (v3 state)', () => {
  const v3Group = (overrides: Record<string, unknown>) => ({
    version: 3,
    groups: [
      {
        id: 'g1',
        name: 'G',
        path: '/p',
        mode: 'multi',
        order: 0,
        silenceWarnings: false,
        silenceErrors: false,
        env: [],
        commands: [],
        actions: [],
        ...overrides,
      },
    ],
    services: [],
  });

  const command = (overrides: Record<string, unknown>) => ({
    id: 'c1',
    name: 'Dev',
    command: 'pnpm dev',
    args: [],
    env: [],
    autoStart: false,
    silencedPatterns: { warn: [], error: [] },
    ...overrides,
  });

  it('reports changed when a command has no id, so the repaired id is written back', () => {
    const result = migrateServicesToGroups(
      v3Group({ commands: [command({ id: undefined })] }),
    );
    expect(result.changed).toBe(true);
    expect(result.state.groups[0].commands[0].id).toBe('test-uuid-fixed');
  });

  it('reports changed for a non-string group id', () => {
    const result = migrateServicesToGroups(v3Group({ id: 42 }));
    expect(result.changed).toBe(true);
    expect(result.state.groups[0].id).toBe('test-uuid-fixed');
  });

  it('reports changed for an action without id', () => {
    const result = migrateServicesToGroups(
      v3Group({
        actions: [
          {
            name: 'Lint',
            command: 'pnpm lint',
            env: [],
            inheritGroupEnv: false,
          },
        ],
      }),
    );
    expect(result.changed).toBe(true);
  });

  it('reports changed for a preScript without id', () => {
    const result = migrateServicesToGroups(
      v3Group({
        preScripts: [{ name: 'Prep', command: 'true' }],
      }),
    );
    expect(result.changed).toBe(true);
  });

  it('stays canonical (changed:false) when every id is a non-empty string', () => {
    const result = migrateServicesToGroups(
      v3Group({
        commands: [command({})],
        preScripts: [{ id: 'sc1', name: 'Prep', command: 'true', env: [] }],
      }),
    );
    expect(result.changed).toBe(false);
  });
});

// ─── migratePreScriptPipeline (v3 → v4) ─────────────────────────────────

describe('planStoreMigration', () => {
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

  it('labels a v3 store with an empty groups array as v4, even though nothing legacy needed hoisting', () => {
    const result = planStoreMigration({
      version: 3,
      groups: [],
      preSteps: [],
      globalSettings: {},
    });
    expect(result.changed).toBe(true);
    expect(result.version).toBe(4);
  });

  it('leaves an already-v4, already-canonical store unchanged (changed:false)', () => {
    const result = planStoreMigration({
      version: 4,
      groups: [],
      preSteps: [],
      globalSettings: {},
    });
    expect(result.changed).toBe(false);
  });

  it('still hoists legacy per-group preSteps into the global pipeline (batch-1 ordering fix intact)', () => {
    const result = planStoreMigration({
      version: 3,
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
    });
    expect(result.changed).toBe(true);
    expect(result.version).toBe(4);
    expect(result.preSteps).toHaveLength(1);
    expect(result.preSteps[0]?.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc1' },
    ]);
    expect(result.groups[0]?.preScripts.map((s) => s.id)).toEqual(['sc1']);
  });

  it('also converts a genuine legacy (v1/v2) services store, landing directly on v4 (the two migrations are NOT mutually exclusive)', () => {
    const result = planStoreMigration({
      version: 1,
      services: [
        {
          id: 'svc1',
          name: 'Dev',
          cwd: '/repo',
          command: 'pnpm dev',
          args: [],
          env: {},
          gitRepo: '/repo',
        },
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.version).toBe(4);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.commands).toHaveLength(1);
  });

  it('surfaces the AND-folded preScriptsAutoRun only when a hoist actually happened', () => {
    const hoisted = planStoreMigration({
      version: 3,
      groups: [
        baseGroup({
          id: 'g1',
          preScriptsAutoRun: true,
          preSteps: [
            {
              id: 'step1',
              mode: 'parallel',
              scripts: [{ id: 'sc1', name: 'A', command: 'true' }],
            },
          ],
        }),
      ],
    });
    expect(hoisted.preScriptsAutoRun).toBe(true);

    const untouched = planStoreMigration({
      version: 4,
      groups: [],
      preSteps: [],
      globalSettings: {},
    });
    expect(untouched.preScriptsAutoRun).toBeNull();
  });

  it('preserves globalSettings.preScriptsAutoRun (returns null) when a group carries an empty legacy preSteps: [] and zero groups actually contribute', () => {
    // `changed` becomes true (an empty legacy `preSteps` key is still a
    // legacy key), but NO group contributes a real script to the fold —
    // config-store.runMigration must leave the user's live setting alone.
    const result = planStoreMigration({
      version: 4,
      groups: [baseGroup({ id: 'a', preSteps: [] })],
      preSteps: [],
      globalSettings: {},
    });
    expect(result.changed).toBe(true);
    expect(result.preScriptsAutoRun).toBeNull();
  });

  it('preserves globalSettings.preScriptsAutoRun (returns null) when a group carries only a stale preScriptsAutoRun key and zero groups actually contribute', () => {
    const result = planStoreMigration({
      version: 4,
      groups: [baseGroup({ id: 'b', preScriptsAutoRun: true })],
      preSteps: [],
      globalSettings: {},
    });
    expect(result.changed).toBe(true);
    expect(result.preScriptsAutoRun).toBeNull();
  });

  it('is idempotent: running it again on its own output reports changed:false', () => {
    const first = planStoreMigration({
      version: 3,
      groups: [],
      preSteps: [],
      globalSettings: {},
    });
    const second = planStoreMigration({
      version: first.version,
      groups: first.groups,
      preSteps: first.preSteps,
      globalSettings: {},
    });
    expect(second.changed).toBe(false);
  });
});

// ─── prunePipelineRefs ───────────────────────────────────────────────────
