import { describe, it, expect, vi, beforeAll } from 'vitest';
import os from 'os';

// Mock uuid for predictable id generation
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-fixed'),
}));

import {
  normalizeGroup,
  normalizeCommand,
  normalizeAction,
  normalizePreScript,
  normalizePreStep,
  normalizeEnvEntries,
  materializeEnv,
  bucketKeyFor,
  migrateServicesToGroups,
  regenerateLegacyServices,
  validateGroupShape,
  enforceSingleModeAutoStart,
  clampMaxLogLinesOrNull,
  clampTimeoutOrNull,
} from '../src/groups-model.js';

// ─── Real user config fixture (7 services, 2 repos) ───────────────────
// nx-platform: 5 services → 1 group
// platform-back: 2 services → 1 group
const REAL_SERVICES = [
  {
    id: 'svc-student',
    name: 'Front Student',
    cwd: '/Users/juan/workspace/nx-platform',
    command: 'pnpm',
    args: ['dev:student'],
    env: {},
    gitRepo: '/Users/juan/workspace/nx-platform',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
  {
    id: 'svc-teacher',
    name: 'Front Teacher',
    cwd: '/Users/juan/workspace/nx-platform',
    command: 'pnpm',
    args: ['dev:teacher'],
    env: {},
    gitRepo: '/Users/juan/workspace/nx-platform',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
  {
    id: 'svc-admin',
    name: 'Front Admin',
    cwd: '/Users/juan/workspace/nx-platform',
    command: 'pnpm',
    args: ['dev:admin'],
    env: {},
    gitRepo: '/Users/juan/workspace/nx-platform',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
  {
    id: 'svc-reviewer',
    name: 'Front Reviewer',
    cwd: '/Users/juan/workspace/nx-platform',
    command: 'pnpm',
    args: ['dev:reviewer'],
    env: {},
    gitRepo: '/Users/juan/workspace/nx-platform',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
  {
    id: 'svc-hr',
    name: 'Front HR',
    cwd: '/Users/juan/workspace/nx-platform',
    command: 'pnpm',
    args: ['dev:hr'],
    env: {},
    gitRepo: '/Users/juan/workspace/nx-platform',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
  {
    id: 'svc-platform-dev',
    name: 'Platform Dev',
    cwd: '/Users/juan/workspace/platform-back',
    command: 'pnpm',
    args: ['dev'],
    env: {},
    gitRepo: '/Users/juan/workspace/platform-back',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
  {
    id: 'svc-platform-bull',
    name: 'Platform Bull',
    cwd: '/Users/juan/workspace/platform-back',
    command: 'pnpm',
    args: ['dev:bull'],
    env: {},
    gitRepo: '/Users/juan/workspace/platform-back',
    warnRegex: '\\bwarn(ing)?s?\\b',
    errorRegex: '\\berror(s)?\\b',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
  },
];

// ─── normalizeGroup ───────────────────────────────────────────────────
describe('normalizeGroup', () => {
  it('applies defaults for minimal input', () => {
    const g = normalizeGroup({ path: '/some/path' });
    expect(g.name).toBe('Servicios');
    expect(g.icon).toBe('📦');
    expect(g.mode).toBe('multi');
    expect(g.silenceWarnings).toBe(false);
    expect(g.silenceErrors).toBe(false);
    expect(g.commands).toEqual([]);
    expect(g.actions).toEqual([]);
  });

  it('preserves provided values', () => {
    const g = normalizeGroup({
      id: 'g1',
      name: 'My Group',
      icon: '🚀',
      path: '/work',
      mode: 'single',
      order: 2,
    });
    expect(g.id).toBe('g1');
    expect(g.name).toBe('My Group');
    expect(g.icon).toBe('🚀');
    expect(g.mode).toBe('single');
    expect(g.order).toBe(2);
  });

  it('defaults mode to multi for unknown value', () => {
    const g = normalizeGroup({ path: '/p', mode: 'invalid' });
    expect(g.mode).toBe('multi');
  });
});

// ─── normalizeCommand ─────────────────────────────────────────────────
describe('normalizeCommand', () => {
  it('applies defaults for empty input', () => {
    const c = normalizeCommand({});
    expect(c.name).toBe('Unnamed');
    expect(c.args).toEqual([]);
    expect(c.env).toEqual([]);
    expect(c.cwd).toBeNull();
    expect(c.silenceWarnings).toBe(false);
    expect(c.silenceErrors).toBe(false);
    expect(c.silencedPatterns).toEqual({ warn: [], error: [] });
  });

  it('preserves id', () => {
    const c = normalizeCommand({ id: 'cmd-1', command: 'pnpm dev' });
    expect(c.id).toBe('cmd-1');
  });

  it('converts legacy object env to EnvEntry[]', () => {
    const c = normalizeCommand({
      command: 'node',
      env: { PORT: '3000', NODE_ENV: 'dev' },
    });
    expect(c.env).toEqual([
      { key: 'PORT', value: '3000', enabled: true },
      { key: 'NODE_ENV', value: 'dev', enabled: true },
    ]);
  });

  it('passes through already-array env unchanged', () => {
    const entries = [{ key: 'PORT', value: '3000', enabled: false }];
    const c = normalizeCommand({ command: 'node', env: entries });
    expect(c.env).toEqual(entries);
  });
});

// ─── normalizeAction ─────────────────────────────────────────────────
describe('normalizeAction', () => {
  it('applies defaults — inheritGroupEnv false', () => {
    const a = normalizeAction({});
    expect(a.name).toBe('Unnamed');
    expect(a.args).toEqual([]);
    expect(a.env).toEqual([]);
    expect(a.inheritGroupEnv).toBe(false);
    expect(a).not.toHaveProperty('useEnvs');
  });

  it('preserves fields', () => {
    const a = normalizeAction({
      id: 'a1',
      name: 'Install',
      command: 'pnpm install',
    });
    expect(a.id).toBe('a1');
    expect(a.name).toBe('Install');
    expect(a.command).toBe('pnpm install');
  });

  it('converts legacy object env to EnvEntry[] and defaults inheritGroupEnv:false', () => {
    const a = normalizeAction({
      command: 'pnpm build',
      env: { NODE_ENV: 'production' },
    });
    expect(a.env).toEqual([
      { key: 'NODE_ENV', value: 'production', enabled: true },
    ]);
    expect(a.inheritGroupEnv).toBe(false);
  });

  it('respects explicit inheritGroupEnv: true', () => {
    const a = normalizeAction({ command: 'pnpm build', inheritGroupEnv: true });
    expect(a.inheritGroupEnv).toBe(true);
  });

  it('migrates legacy useEnvs:true to inheritGroupEnv:true', () => {
    const a = normalizeAction({ command: 'pnpm build', useEnvs: true });
    expect(a.inheritGroupEnv).toBe(true);
    expect(a).not.toHaveProperty('useEnvs');
  });

  it('migrates legacy useEnvs:false to inheritGroupEnv:false', () => {
    const a = normalizeAction({ command: 'pnpm build', useEnvs: false });
    expect(a.inheritGroupEnv).toBe(false);
    expect(a).not.toHaveProperty('useEnvs');
  });
});

// ─── normalizeGroup ── env field ──────────────────────────────────────
describe('normalizeGroup — env field', () => {
  it('defaults env to [] when not provided', () => {
    const g = normalizeGroup({ path: '/some/path' });
    expect(g.env).toEqual([]);
  });

  it('passes through array env', () => {
    const entries = [{ key: 'X', value: '1', enabled: true }];
    const g = normalizeGroup({ path: '/p', env: entries });
    expect(g.env).toEqual(entries);
  });
});

// ─── normalizeEnvEntries ──────────────────────────────────────────────
describe('normalizeEnvEntries', () => {
  it('converts legacy object to array', () => {
    expect(normalizeEnvEntries({ PORT: '3000' })).toEqual([
      { key: 'PORT', value: '3000', enabled: true },
    ]);
  });

  it('passes through array form', () => {
    const entries = [{ key: 'PORT', value: '3000', enabled: false }];
    expect(normalizeEnvEntries(entries)).toEqual(entries);
  });

  it('returns [] for null/undefined', () => {
    expect(normalizeEnvEntries(null)).toEqual([]);
    expect(normalizeEnvEntries(undefined)).toEqual([]);
    expect(normalizeEnvEntries({})).toEqual([]);
  });

  it('filters out non-object array entries', () => {
    expect(
      normalizeEnvEntries([
        'bad',
        null,
        { key: 'A', value: '1', enabled: true },
      ]),
    ).toEqual([{ key: 'A', value: '1', enabled: true }]);
  });

  it('defaults enabled to true when absent', () => {
    const result = normalizeEnvEntries([{ key: 'X', value: '1' }]);
    expect(result[0].enabled).toBe(true);
  });
});

// ─── materializeEnv ───────────────────────────────────────────────────
describe('materializeEnv', () => {
  it('builds object from enabled entries with non-empty keys', () => {
    const entries = [
      { key: 'PORT', value: '3000', enabled: true },
      { key: 'NODE_ENV', value: 'dev', enabled: false },
      { key: '', value: 'ignored', enabled: true },
    ];
    expect(materializeEnv(entries)).toEqual({ PORT: '3000' });
  });

  it('returns {} for empty array', () => {
    expect(materializeEnv([])).toEqual({});
  });

  it('returns {} for non-array input', () => {
    expect(materializeEnv(null)).toEqual({});
    expect(materializeEnv(undefined)).toEqual({});
  });

  it('trims keys before using them', () => {
    const entries = [{ key: '  KEY  ', value: 'val', enabled: true }];
    expect(materializeEnv(entries)).toEqual({ KEY: 'val' });
  });
});

// ─── bucketKeyFor ─────────────────────────────────────────────────────
describe('bucketKeyFor', () => {
  it('uses gitRepo when present', () => {
    const svc = {
      gitRepo: '/Users/juan/workspace/nx-platform',
      cwd: '/something/else',
    };
    expect(bucketKeyFor(svc)).toBe('/Users/juan/workspace/nx-platform');
  });

  it('falls back to cwd when gitRepo is empty', () => {
    const svc = { gitRepo: '', cwd: '/Users/juan/workspace/platform-back' };
    expect(bucketKeyFor(svc)).toBe('/Users/juan/workspace/platform-back');
  });

  it('expands tilde in gitRepo', () => {
    const svc = { gitRepo: '~/workspace/repo', cwd: '' };
    const expected = os.homedir() + '/workspace/repo';
    expect(bucketKeyFor(svc)).toBe(expected);
  });

  it('returns empty string when both are empty', () => {
    const svc = { gitRepo: '', cwd: '' };
    expect(bucketKeyFor(svc)).toBe('');
  });
});

// ─── migrateServicesToGroups: real user config ────────────────────────
describe('migrateServicesToGroups — real user config (7 services, 2 repos)', () => {
  let result;
  let groups;

  beforeAll(() => {
    result = migrateServicesToGroups({ version: 1, services: REAL_SERVICES });
    groups = result.state.groups;
  });

  it('changed is true', () => {
    expect(result.changed).toBe(true);
  });

  it('version is 3', () => {
    expect(result.state.version).toBe(3);
  });

  it('creates exactly 2 groups', () => {
    expect(groups).toHaveLength(2);
  });

  it('first group is nx-platform with 5 commands', () => {
    const g = groups[0];
    expect(g.path).toBe('/Users/juan/workspace/nx-platform');
    expect(g.name).toBe('nx-platform');
    expect(g.commands).toHaveLength(5);
  });

  it('second group is platform-back with 2 commands', () => {
    const g = groups[1];
    expect(g.path).toBe('/Users/juan/workspace/platform-back');
    expect(g.name).toBe('platform-back');
    expect(g.commands).toHaveLength(2);
  });

  it('preserves original service ids as command ids', () => {
    const allCommandIds = groups.flatMap((g) => g.commands.map((c) => c.id));
    expect(allCommandIds).toContain('svc-student');
    expect(allCommandIds).toContain('svc-teacher');
    expect(allCommandIds).toContain('svc-admin');
    expect(allCommandIds).toContain('svc-reviewer');
    expect(allCommandIds).toContain('svc-hr');
    expect(allCommandIds).toContain('svc-platform-dev');
    expect(allCommandIds).toContain('svc-platform-bull');
  });

  it('stores _services_pre_v3_backup equal to original services', () => {
    expect(result.state._services_pre_v3_backup).toEqual(REAL_SERVICES);
  });

  it('generates legacy services array with 7 entries', () => {
    expect(result.state.services).toHaveLength(7);
  });
});

// ─── migrateServicesToGroups: cwd override ────────────────────────────
describe('migrateServicesToGroups — cwd override (S2)', () => {
  it('sets command.cwd when service.cwd differs from bucket key', () => {
    const services = [
      {
        id: 'svc-x',
        name: 'Sub Service',
        cwd: '/repo/sub',
        command: 'pnpm dev',
        args: [],
        env: {},
        gitRepo: '/repo',
        warnRegex: '',
        errorRegex: '',
        silenceWarnings: false,
        silenceErrors: false,
        silencedPatterns: { warn: [], error: [] },
      },
    ];
    const result = migrateServicesToGroups({ version: 1, services });
    const cmd = result.state.groups[0].commands[0];
    expect(result.state.groups[0].path).toBe('/repo');
    expect(cmd.cwd).toBe('/repo/sub');
  });

  it('does NOT set command.cwd when cwd equals bucket key', () => {
    const services = [
      {
        id: 'svc-y',
        name: 'Same Path',
        cwd: '/repo',
        command: 'pnpm dev',
        args: [],
        env: {},
        gitRepo: '/repo',
        warnRegex: '',
        errorRegex: '',
        silenceWarnings: false,
        silenceErrors: false,
        silencedPatterns: { warn: [], error: [] },
      },
    ];
    const result = migrateServicesToGroups({ version: 1, services });
    const cmd = result.state.groups[0].commands[0];
    expect(cmd.cwd).toBeNull();
  });
});

// ─── migrateServicesToGroups: empty path (S3) ─────────────────────────
describe('migrateServicesToGroups — empty path fallback (S3)', () => {
  it('places service with empty gitRepo and cwd in "(no path)" group', () => {
    const services = [
      {
        id: 'svc-z',
        name: 'Orphan',
        cwd: '',
        command: 'node index.js',
        args: [],
        env: {},
        gitRepo: '',
        warnRegex: '',
        errorRegex: '',
        silenceWarnings: false,
        silenceErrors: false,
        silencedPatterns: { warn: [], error: [] },
      },
    ];
    const result = migrateServicesToGroups({ version: 1, services });
    expect(result.state.groups[0].name).toBe('(no path)');
  });
});

// ─── migrateServicesToGroups: idempotency (S1 second run) ────────────
describe('migrateServicesToGroups — idempotency', () => {
  it('returns changed:false on second run', () => {
    const firstRun = migrateServicesToGroups({
      version: 1,
      services: REAL_SERVICES,
    });
    const secondRun = migrateServicesToGroups(firstRun.state);
    expect(secondRun.changed).toBe(false);
  });

  it('does not modify groups on second run', () => {
    const firstRun = migrateServicesToGroups({
      version: 1,
      services: REAL_SERVICES,
    });
    const secondRun = migrateServicesToGroups(firstRun.state);
    expect(secondRun.state.groups).toEqual(firstRun.state.groups);
  });

  it('does not overwrite existing _services_pre_v3_backup', () => {
    const preBackup = [{ id: 'original' }];
    const state = {
      version: 3,
      groups: [
        normalizeGroup({ id: 'g1', name: 'G', path: '/p', mode: 'multi' }),
      ],
      _services_pre_v3_backup: preBackup,
      services: [],
    };
    const result = migrateServicesToGroups(state);
    // No change — already migrated
    expect(result.changed).toBe(false);
    // Backup untouched
    expect(result.state._services_pre_v3_backup).toEqual(preBackup);
  });
});

// ─── migrateServicesToGroups: id preservation ────────────────────────
describe('migrateServicesToGroups — id preservation', () => {
  it('preserves all 7 original service ids as command ids', () => {
    const result = migrateServicesToGroups({
      version: 1,
      services: REAL_SERVICES,
    });
    const allIds = result.state.groups.flatMap((g) =>
      g.commands.map((c) => c.id),
    );
    const originalIds = REAL_SERVICES.map((s) => s.id);
    for (const id of originalIds) {
      expect(allIds).toContain(id);
    }
  });
});

// ─── validateGroupShape ───────────────────────────────────────────────
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

// ─── regenerateLegacyServices ────────────────────────────────────────
describe('regenerateLegacyServices', () => {
  it('flattens groups to services', () => {
    const groups = [
      normalizeGroup({
        name: 'G1',
        path: '/repo',
        mode: 'multi',
        commands: [
          normalizeCommand({ id: 'c1', name: 'Dev', command: 'pnpm dev' }),
        ],
        actions: [
          normalizeAction({
            id: 'a1',
            name: 'Install',
            command: 'pnpm install',
          }),
        ],
      }),
    ];
    const services = regenerateLegacyServices(groups);
    // actions are NOT included
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe('c1');
    expect(services[0].gitRepo).toBe('/repo');
    expect(services[0].cwd).toBe('/repo');
  });

  it('uses command.cwd override when set', () => {
    const groups = [
      normalizeGroup({
        name: 'G1',
        path: '/repo',
        mode: 'multi',
        commands: [
          normalizeCommand({ id: 'c1', command: 'pnpm dev', cwd: '/repo/sub' }),
        ],
      }),
    ];
    const services = regenerateLegacyServices(groups);
    expect(services[0].cwd).toBe('/repo/sub');
  });

  it('returns empty array for empty groups', () => {
    expect(regenerateLegacyServices([])).toEqual([]);
  });

  it('env in legacy service is a plain object (materializeEnv output)', () => {
    const groups = [
      normalizeGroup({
        name: 'G1',
        path: '/repo',
        mode: 'multi',
        commands: [
          normalizeCommand({
            id: 'c1',
            name: 'Dev',
            command: 'pnpm dev',
            env: [{ key: 'PORT', value: '3000', enabled: true }],
          }),
        ],
      }),
    ];
    const services = regenerateLegacyServices(groups);
    expect(services[0].env).toEqual({ PORT: '3000' });
  });

  it('disabled env entries are excluded from legacy service env', () => {
    const groups = [
      normalizeGroup({
        name: 'G1',
        path: '/repo',
        mode: 'multi',
        commands: [
          normalizeCommand({
            id: 'c1',
            name: 'Dev',
            command: 'pnpm dev',
            env: [
              { key: 'PORT', value: '3000', enabled: true },
              { key: 'SECRET', value: 'shh', enabled: false },
            ],
          }),
        ],
      }),
    ];
    const services = regenerateLegacyServices(groups);
    expect(services[0].env).toEqual({ PORT: '3000' });
    expect(services[0].env).not.toHaveProperty('SECRET');
  });
});

// ─── env shape migration (v3 shape-only) ─────────────────────────────
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
describe('normalizeCommand — autoStart field', () => {
  it('defaults autoStart to false when not provided', () => {
    const c = normalizeCommand({ command: 'pnpm dev' });
    expect(c.autoStart).toBe(false);
  });

  it('preserves autoStart:true', () => {
    const c = normalizeCommand({ command: 'pnpm dev', autoStart: true });
    expect(c.autoStart).toBe(true);
  });

  it('preserves autoStart:false explicitly', () => {
    const c = normalizeCommand({ command: 'pnpm dev', autoStart: false });
    expect(c.autoStart).toBe(false);
  });

  it('coerces truthy value to boolean true', () => {
    const c = normalizeCommand({ command: 'pnpm dev', autoStart: 1 });
    expect(c.autoStart).toBe(true);
  });
});

// ─── migration shape-fix: autoStart on v3 state ──────────────────────
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
describe('enforceSingleModeAutoStart', () => {
  function makeGroup(mode, autoStarts) {
    return {
      id: 'g1',
      name: 'G',
      path: '/p',
      mode,
      commands: autoStarts.map((as, i) => ({
        id: `c${i}`,
        name: `Cmd ${i}`,
        autoStart: as,
      })),
    };
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
describe('normalizeCommand — maxLogLines field', () => {
  it('defaults to null when not provided', () => {
    const c = normalizeCommand({});
    expect(c.maxLogLines).toBeNull();
  });

  it('defaults to null for null input', () => {
    const c = normalizeCommand({ maxLogLines: null });
    expect(c.maxLogLines).toBeNull();
  });

  it('preserves a valid value in range', () => {
    const c = normalizeCommand({ maxLogLines: 1000 });
    expect(c.maxLogLines).toBe(1000);
  });

  it('clamps below floor to 100', () => {
    const c = normalizeCommand({ maxLogLines: 50 });
    expect(c.maxLogLines).toBe(100);
  });

  it('clamps above ceiling to 50000', () => {
    const c = normalizeCommand({ maxLogLines: 99999 });
    expect(c.maxLogLines).toBe(50000);
  });
});

// ─── Action effective env (materializeEnv behavior) ──────────────────────
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
describe('normalizePreScript', () => {
  it('applies defaults for minimal input', () => {
    const sc = normalizePreScript({});
    expect(sc.name).toBe('Unnamed');
    expect(sc.command).toBe('');
    expect(sc.args).toEqual([]);
    expect(sc.env).toEqual([]);
    expect(sc.inheritGroupEnv).toBe(false);
    expect(typeof sc.id).toBe('string');
    expect(sc.id.length).toBeGreaterThan(0);
  });

  it('preserves provided values', () => {
    const sc = normalizePreScript({
      id: 'sc-1',
      name: 'Install',
      command: 'pnpm install',
      args: ['--frozen-lockfile'],
      inheritGroupEnv: true,
    });
    expect(sc.id).toBe('sc-1');
    expect(sc.name).toBe('Install');
    expect(sc.command).toBe('pnpm install');
    expect(sc.args).toEqual(['--frozen-lockfile']);
    expect(sc.inheritGroupEnv).toBe(true);
  });

  it('preserves empty command as-is (model layer does not reject it)', () => {
    const sc = normalizePreScript({ command: '' });
    expect(sc.command).toBe('');
  });

  it('defaults inheritGroupEnv to false', () => {
    const sc = normalizePreScript({ command: 'echo hi' });
    expect(sc.inheritGroupEnv).toBe(false);
  });

  it('preserves raw id (UUID round-trip)', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';
    const sc = normalizePreScript({ id });
    expect(sc.id).toBe(id);
  });
});

// ─── normalizePreStep ────────────────────────────────────────────────────
describe('normalizePreStep', () => {
  it('defaults mode to parallel for missing value', () => {
    const step = normalizePreStep({});
    expect(step.mode).toBe('parallel');
  });

  it('defaults mode to parallel for unknown value', () => {
    const step = normalizePreStep({ mode: 'foo' });
    expect(step.mode).toBe('parallel');
  });

  it('accepts serial mode', () => {
    const step = normalizePreStep({ mode: 'serial' });
    expect(step.mode).toBe('serial');
  });

  it('defaults scripts to []', () => {
    const step = normalizePreStep({});
    expect(step.scripts).toEqual([]);
  });

  it('normalizes nested scripts', () => {
    const step = normalizePreStep({
      id: 'step-1',
      mode: 'serial',
      scripts: [{ id: 'sc-1', name: 'Install', command: 'pnpm install' }],
    });
    expect(step.scripts).toHaveLength(1);
    expect(step.scripts[0].id).toBe('sc-1');
    expect(step.scripts[0].name).toBe('Install');
  });

  it('preserves raw id', () => {
    const id = 'step-uuid-1234';
    const step = normalizePreStep({ id });
    expect(step.id).toBe(id);
  });

  it('generates id when missing', () => {
    const step = normalizePreStep({});
    expect(typeof step.id).toBe('string');
    expect(step.id.length).toBeGreaterThan(0);
  });
});

// ─── clampTimeoutOrNull ──────────────────────────────────────────────────
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
describe('normalizePreScript — timeoutMs field', () => {
  it('defaults timeoutMs to null when not provided', () => {
    const sc = normalizePreScript({ command: 'echo hi' });
    expect(sc.timeoutMs).toBeNull();
  });

  it('defaults timeoutMs to null for explicit null', () => {
    const sc = normalizePreScript({ command: 'echo hi', timeoutMs: null });
    expect(sc.timeoutMs).toBeNull();
  });

  it('preserves valid timeoutMs within range', () => {
    const sc = normalizePreScript({ command: 'echo hi', timeoutMs: 5000 });
    expect(sc.timeoutMs).toBe(5000);
  });

  it('clamps timeoutMs below minimum (500 → 1000)', () => {
    const sc = normalizePreScript({ command: 'echo hi', timeoutMs: 500 });
    expect(sc.timeoutMs).toBe(1000);
  });

  it('clamps timeoutMs above maximum', () => {
    const sc = normalizePreScript({ command: 'echo hi', timeoutMs: 9_999_999 });
    expect(sc.timeoutMs).toBe(3_600_000);
  });

  it('sets timeoutMs to null for empty string', () => {
    const sc = normalizePreScript({ command: 'echo hi', timeoutMs: '' });
    expect(sc.timeoutMs).toBeNull();
  });
});

// ─── normalizeGroup — preSteps field ────────────────────────────────────
describe('normalizeGroup — preSteps field', () => {
  it('defaults preSteps to [] when absent', () => {
    const g = normalizeGroup({ path: '/some/path' });
    expect(g.preSteps).toEqual([]);
  });

  it('normalizes provided preSteps', () => {
    const g = normalizeGroup({
      path: '/p',
      preSteps: [
        {
          id: 'step-1',
          mode: 'serial',
          scripts: [{ id: 'sc-1', name: 'Install', command: 'pnpm install' }],
        },
      ],
    });
    expect(g.preSteps).toHaveLength(1);
    expect(g.preSteps[0].id).toBe('step-1');
    expect(g.preSteps[0].mode).toBe('serial');
  });

  it('UUID round-trip: re-normalizing an already-normalized group preserves all ids', () => {
    const original = normalizeGroup({
      path: '/p',
      preSteps: [
        {
          id: 'step-aaa',
          mode: 'parallel',
          scripts: [{ id: 'sc-bbb', name: 'Build', command: 'pnpm build' }],
        },
      ],
    });
    const json = JSON.stringify(original);
    const restored = normalizeGroup(JSON.parse(json));
    expect(restored.preSteps[0].id).toBe('step-aaa');
    expect(restored.preSteps[0].scripts[0].id).toBe('sc-bbb');
  });

  it('old group fixture without preSteps gets preSteps:[]', () => {
    const g = normalizeGroup({
      path: '/p',
      name: 'Legacy',
      commands: [],
      actions: [],
    });
    expect(g.preSteps).toEqual([]);
  });
});
