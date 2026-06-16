import { describe, it, expect, vi } from 'vitest';

// Mock uuid so normalizeGroup produces deterministic ids when a group has none
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-fixed'),
}));

import {
  serializeConfig,
  validateImportedConfig,
  summarizeImport,
  EXPORT_SCHEMA_VERSION,
} from '../src/config-io.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const MINIMAL_VALID_PAYLOAD = {
  version: 3,
  groups: [],
  globalSettings: {
    autostart: false,
    silenceWarnings: false,
    silenceErrors: false,
  },
};

const VALID_GROUP = {
  id: 'grp-1',
  name: 'Mi grupo',
  path: '/Users/test/proyecto',
  mode: 'multi',
  commands: [
    { id: 'cmd-1', name: 'Dev', command: 'pnpm dev', args: [], env: {} },
  ],
  actions: [
    { id: 'act-1', name: 'Build', command: 'pnpm build', args: [], env: {} },
  ],
};

const VALID_V3_FILE = {
  exportedAt: '2026-05-21T00:00:00.000Z',
  appVersion: '0.1.0',
  version: 3,
  groups: [VALID_GROUP],
  globalSettings: {
    autostart: true,
    silenceWarnings: false,
    silenceErrors: false,
  },
};

// ─── serializeConfig ───────────────────────────────────────────────────────────

describe('serializeConfig', () => {
  it('includes exportedAt as an ISO8601 string', () => {
    const result = serializeConfig(
      { version: 3, groups: [], globalSettings: {} },
      '0.1.0',
    );
    expect(result.exportedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('includes appVersion from the argument', () => {
    const result = serializeConfig(
      { version: 3, groups: [], globalSettings: {} },
      '0.1.0',
    );
    expect(result.appVersion).toBe('0.1.0');
  });

  it('sets appVersion to null when not provided', () => {
    const result = serializeConfig({
      version: 3,
      groups: [],
      globalSettings: {},
    });
    expect(result.appVersion).toBeNull();
  });

  it('does NOT include services key', () => {
    const raw = {
      version: 3,
      groups: [],
      globalSettings: {},
      services: [{ id: 'svc-1', name: 'Leaked service' }],
    };
    const result = serializeConfig(raw, '0.1.0');
    expect(result).not.toHaveProperty('services');
  });

  it('does NOT include _services_pre_v3_backup key', () => {
    const raw = {
      version: 3,
      groups: [],
      globalSettings: {},
      _services_pre_v3_backup: [{ id: 'old-svc' }],
    };
    const result = serializeConfig(raw, '0.1.0');
    expect(result).not.toHaveProperty('_services_pre_v3_backup');
  });

  it('includes version from rawStore', () => {
    const result = serializeConfig(
      { version: 3, groups: [], globalSettings: {} },
      '0.1.0',
    );
    expect(result.version).toBe(3);
  });

  it('defaults version to EXPORT_SCHEMA_VERSION when missing', () => {
    const result = serializeConfig({ groups: [], globalSettings: {} }, '0.1.0');
    expect(result.version).toBe(EXPORT_SCHEMA_VERSION);
  });

  it('includes groups array', () => {
    const groups = [{ id: 'g1', name: 'G1' }];
    const result = serializeConfig(
      { version: 3, groups, globalSettings: {} },
      '0.1.0',
    );
    expect(result.groups).toEqual(groups);
  });

  it('includes globalSettings', () => {
    const gs = {
      autostart: true,
      silenceWarnings: false,
      silenceErrors: false,
    };
    const result = serializeConfig(
      { version: 3, groups: [], globalSettings: gs },
      '0.1.0',
    );
    expect(result.globalSettings).toEqual(gs);
  });

  it('handles empty / null rawStore gracefully', () => {
    const result = serializeConfig(null, '0.1.0');
    expect(result.groups).toEqual([]);
    expect(result.globalSettings).toEqual({});
    expect(result.version).toBe(EXPORT_SCHEMA_VERSION);
  });
});

// ─── validateImportedConfig ────────────────────────────────────────────────────

describe('validateImportedConfig', () => {
  it('accepts a minimal valid v3 payload', () => {
    const result = validateImportedConfig(MINIMAL_VALID_PAYLOAD);
    expect(result.ok).toBe(true);
    expect(result.payload.version).toBe(3);
    expect(result.payload.groups).toEqual([]);
  });

  it('accepts a v3 file with a valid group', () => {
    const result = validateImportedConfig(VALID_V3_FILE);
    expect(result.ok).toBe(true);
    expect(result.payload.groups).toHaveLength(1);
  });

  it('rejects null', () => {
    const result = validateImportedConfig(null);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/object/i);
  });

  it('rejects a string', () => {
    const result = validateImportedConfig('not an object');
    expect(result.ok).toBe(false);
  });

  it('rejects an array', () => {
    const result = validateImportedConfig([]);
    expect(result.ok).toBe(false);
  });

  it('rejects version !== 3', () => {
    const result = validateImportedConfig({
      version: 2,
      groups: [],
      globalSettings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/versión/i);
    expect(result.error).toMatch(/2/);
  });

  it('rejects when groups is not an array', () => {
    const result = validateImportedConfig({
      version: 3,
      groups: 'bad',
      globalSettings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/groups/);
  });

  it('rejects a command missing the command field', () => {
    const obj = {
      version: 3,
      groups: [
        {
          id: 'grp-1',
          name: 'Test',
          path: '/tmp/test',
          mode: 'multi',
          commands: [{ id: 'cmd-1', name: 'broken' /* no command field */ }],
          actions: [],
        },
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command/i);
  });

  it('rejects an action missing the name field', () => {
    const obj = {
      version: 3,
      groups: [
        {
          id: 'grp-1',
          name: 'Test',
          path: '/tmp/test',
          mode: 'multi',
          commands: [],
          actions: [{ id: 'act-1' /* no name */ }],
        },
      ],
      globalSettings: {},
    };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name|acción/i);
  });

  it('strips unknown top-level keys from the returned payload', () => {
    const obj = {
      ...VALID_V3_FILE,
      unknownKey: 'should be stripped',
      anotherKey: 42,
    };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(true);
    expect(result.payload).not.toHaveProperty('unknownKey');
    expect(result.payload).not.toHaveProperty('anotherKey');
    expect(result.payload).not.toHaveProperty('exportedAt');
    expect(result.payload).not.toHaveProperty('appVersion');
  });

  it('strips services and _services_pre_v3_backup from returned payload', () => {
    const obj = {
      ...VALID_V3_FILE,
      services: [{ id: 'svc-1' }],
      _services_pre_v3_backup: [{ id: 'old' }],
    };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(true);
    expect(result.payload).not.toHaveProperty('services');
    expect(result.payload).not.toHaveProperty('_services_pre_v3_backup');
  });

  it('coerces globalSettings booleans', () => {
    const obj = {
      version: 3,
      groups: [],
      globalSettings: {
        autostart: 1,
        silenceWarnings: 0,
        silenceErrors: 'yes',
      },
    };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(true);
    expect(result.payload.globalSettings.autostart).toBe(true);
    expect(result.payload.globalSettings.silenceWarnings).toBe(false);
    expect(result.payload.globalSettings.silenceErrors).toBe(true);
  });

  it('defaults globalSettings when absent', () => {
    const obj = { version: 3, groups: [] };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(true);
    expect(result.payload.globalSettings).toEqual({
      autostart: false,
      silenceWarnings: false,
      silenceErrors: false,
    });
  });

  it('strips unknown keys from globalSettings', () => {
    const obj = {
      version: 3,
      groups: [],
      globalSettings: { autostart: false, unknownGsSetting: 'hi' },
    };
    const result = validateImportedConfig(obj);
    expect(result.ok).toBe(true);
    expect(result.payload.globalSettings).not.toHaveProperty(
      'unknownGsSetting',
    );
  });
});

// ─── summarizeImport ───────────────────────────────────────────────────────────

describe('summarizeImport', () => {
  it('returns zero counts for empty groups', () => {
    const summary = summarizeImport(MINIMAL_VALID_PAYLOAD);
    expect(summary).toEqual({
      groupsCount: 0,
      commandsCount: 0,
      actionsCount: 0,
      preStepsCount: 0,
      preScriptsCount: 0,
      hasGlobalSettings: true,
    });
  });

  it('counts groups, commands, and actions correctly', () => {
    const payload = {
      version: 3,
      groups: [
        { commands: [{ id: 'c1' }, { id: 'c2' }], actions: [{ id: 'a1' }] },
        { commands: [{ id: 'c3' }], actions: [] },
      ],
      globalSettings: { autostart: false },
    };
    const summary = summarizeImport(payload);
    expect(summary.groupsCount).toBe(2);
    expect(summary.commandsCount).toBe(3);
    expect(summary.actionsCount).toBe(1);
    expect(summary.hasGlobalSettings).toBe(true);
  });

  it('counts preSteps and preScripts correctly', () => {
    const payload = {
      version: 3,
      groups: [
        {
          commands: [],
          actions: [],
          preSteps: [
            { scripts: [{ id: 'sc1' }, { id: 'sc2' }] },
            { scripts: [{ id: 'sc3' }] },
          ],
        },
        {
          commands: [],
          actions: [],
          preSteps: [],
        },
      ],
      globalSettings: {},
    };
    const summary = summarizeImport(payload);
    expect(summary.preStepsCount).toBe(2);
    expect(summary.preScriptsCount).toBe(3);
  });

  it('sets hasGlobalSettings false when globalSettings absent', () => {
    const summary = summarizeImport({ groups: [] });
    expect(summary.hasGlobalSettings).toBe(false);
  });
});

// ─── EXPORT_SCHEMA_VERSION ────────────────────────────────────────────────────

describe('EXPORT_SCHEMA_VERSION', () => {
  it('is 3', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(3);
  });
});
