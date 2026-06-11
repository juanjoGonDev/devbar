import { describe, it, expect } from 'vitest';
import { validateImportedConfig, summarizeImport } from '../src/config-io.js';

/**
 * config-io-prescripts.test.js
 *
 * Tests for preSteps round-trip export/import (R10) and validation of
 * malformed preSteps shapes.
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_PRESTEPS_PAYLOAD = {
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
      preSteps: [
        {
          id: 'step-aaa',
          mode: 'serial',
          scripts: [
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
          id: 'step-ddd',
          mode: 'parallel',
          scripts: [
            { id: 'sc-eee', name: 'Lint', command: 'pnpm lint', args: [], env: [] },
          ],
        },
      ],
    },
  ],
  globalSettings: { autostart: false, silenceWarnings: false, silenceErrors: false },
};

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('validateImportedConfig — preSteps round-trip (R10)', () => {
  it('accepts a valid payload with preSteps', () => {
    const result = validateImportedConfig(VALID_PRESTEPS_PAYLOAD);
    expect(result.ok).toBe(true);
  });

  it('preserves preSteps in the returned payload (round-trip)', () => {
    const result = validateImportedConfig(VALID_PRESTEPS_PAYLOAD);
    expect(result.ok).toBe(true);
    const group = result.payload.groups[0];
    expect(group.preSteps).toHaveLength(2);
    expect(group.preSteps[0].id).toBe('step-aaa');
    expect(group.preSteps[0].mode).toBe('serial');
    expect(group.preSteps[0].scripts).toHaveLength(2);
    expect(group.preSteps[0].scripts[0].id).toBe('sc-bbb');
    expect(group.preSteps[0].scripts[0].command).toBe('pnpm install');
  });

  it('preserves all step and script ids verbatim', () => {
    const result = validateImportedConfig(VALID_PRESTEPS_PAYLOAD);
    const group = result.payload.groups[0];
    const stepIds = group.preSteps.map((s) => s.id);
    const scriptIds = group.preSteps.flatMap((s) => s.scripts.map((sc) => sc.id));
    expect(stepIds).toContain('step-aaa');
    expect(stepIds).toContain('step-ddd');
    expect(scriptIds).toContain('sc-bbb');
    expect(scriptIds).toContain('sc-ccc');
    expect(scriptIds).toContain('sc-eee');
  });

  it('accepts a payload with no preSteps key (defaults to [])', () => {
    const payload = {
      version: 3,
      groups: [{ name: 'G', path: '/p', mode: 'multi', commands: [], actions: [] }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(true);
    // normalizeGroup fills in preSteps: []
    expect(result.payload.groups[0].preSteps).toEqual([]);
  });
});

// ─── Malformed preSteps rejection ────────────────────────────────────────────

describe('validateImportedConfig — rejects malformed preSteps (R10)', () => {
  it('rejects a script with missing command', () => {
    const payload = {
      version: 3,
      groups: [{
        name: 'G', path: '/p', mode: 'multi', commands: [], actions: [],
        preSteps: [{ id: 's1', mode: 'parallel', scripts: [{ id: 'sc1', name: 'Install' /* no command */ }] }],
      }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('pre-script sin command');
  });

  it('rejects a script with empty command', () => {
    const payload = {
      version: 3,
      groups: [{
        name: 'G', path: '/p', mode: 'multi', commands: [], actions: [],
        preSteps: [{ id: 's1', mode: 'parallel', scripts: [{ id: 'sc1', name: 'Install', command: '' }] }],
      }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('pre-script sin command');
  });

  it('rejects a script with missing name', () => {
    const payload = {
      version: 3,
      groups: [{
        name: 'G', path: '/p', mode: 'multi', commands: [], actions: [],
        preSteps: [{ id: 's1', mode: 'parallel', scripts: [{ id: 'sc1', command: 'pnpm install' /* no name */ }] }],
      }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('pre-script sin name');
  });

  it('rejects a step with invalid mode', () => {
    const payload = {
      version: 3,
      groups: [{
        name: 'G', path: '/p', mode: 'multi', commands: [], actions: [],
        preSteps: [{ id: 's1', mode: 'batch', scripts: [] }],
      }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('mode inválido');
  });

  it('rejects a step where scripts is not an array', () => {
    const payload = {
      version: 3,
      groups: [{
        name: 'G', path: '/p', mode: 'multi', commands: [], actions: [],
        preSteps: [{ id: 's1', mode: 'parallel', scripts: 'not-an-array' }],
      }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('scripts debe ser array');
  });

  it('rejects a script with invalid env shape (string)', () => {
    const payload = {
      version: 3,
      groups: [{
        name: 'G', path: '/p', mode: 'multi', commands: [], actions: [],
        preSteps: [{
          id: 's1', mode: 'parallel',
          scripts: [{ id: 'sc1', name: 'Build', command: 'pnpm build', env: 'bad' }],
        }],
      }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('env inválido');
  });
});

// ─── summarizeImport with preSteps ───────────────────────────────────────────

describe('summarizeImport — preStepsCount / preScriptsCount', () => {
  it('counts preSteps and preScripts from valid payload', () => {
    const result = validateImportedConfig(VALID_PRESTEPS_PAYLOAD);
    expect(result.ok).toBe(true);
    const summary = summarizeImport(result.payload);
    expect(summary.preStepsCount).toBe(2);
    expect(summary.preScriptsCount).toBe(3);
  });

  it('returns 0 for preStepsCount and preScriptsCount when no preSteps', () => {
    const payload = {
      version: 3,
      groups: [{ id: 'g1', name: 'G', path: '/p', mode: 'multi', commands: [], actions: [] }],
      globalSettings: {},
    };
    const result = validateImportedConfig(payload);
    const summary = summarizeImport(result.payload);
    expect(summary.preStepsCount).toBe(0);
    expect(summary.preScriptsCount).toBe(0);
  });
});
