import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Group } from '../src/domain-types.js';

// Mock uuid for predictable id generation
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-fixed'),
}));

import {
  normalizeGroup,
  normalizeCommand,
  normalizeAction,
  migrateServicesToGroups,
  regenerateLegacyServices,
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

describe('migrateServicesToGroups — real user config (7 services, 2 repos)', () => {
  let result: ReturnType<typeof migrateServicesToGroups>;
  let groups: Group[];

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
