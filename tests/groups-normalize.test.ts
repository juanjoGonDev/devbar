import { describe, it, expect, vi } from 'vitest';
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
  normalizePreStepScriptRef,
  normalizeEnvEntries,
  materializeEnv,
  bucketKeyFor,
} from '../src/groups-model.js';

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

// ─── normalizeGroup — waitForPipeline ──────────────────────────────────

describe('normalizeGroup — waitForPipeline', () => {
  it('defaults to true when not provided (existing v4 stores have no such key)', () => {
    const g = normalizeGroup({ path: '/some/path' });
    expect(g.waitForPipeline).toBe(true);
  });

  it('respects an explicit false (opt out for a genuinely independent group)', () => {
    const g = normalizeGroup({ path: '/p', waitForPipeline: false });
    expect(g.waitForPipeline).toBe(false);
  });

  it('respects an explicit true', () => {
    const g = normalizeGroup({ path: '/p', waitForPipeline: true });
    expect(g.waitForPipeline).toBe(true);
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

  it('normalizes scripts as {groupId,scriptId} refs, dropping refs with an empty id', () => {
    const step = normalizePreStep({
      id: 'step-1',
      mode: 'serial',
      scripts: [
        { groupId: 'g1', scriptId: 'sc-1' },
        { groupId: '', scriptId: 'sc-2' },
      ],
    });
    expect(step.scripts).toEqual([{ groupId: 'g1', scriptId: 'sc-1' }]);
  });

  it('deduplicates repeated {groupId,scriptId} refs within the same step, keeping the first occurrence', () => {
    const step = normalizePreStep({
      id: 'step-1',
      mode: 'parallel',
      scripts: [
        { groupId: 'g1', scriptId: 'sc-1' },
        { groupId: 'g2', scriptId: 'sc-2' },
        { groupId: 'g1', scriptId: 'sc-1' },
      ],
    });
    expect(step.scripts).toEqual([
      { groupId: 'g1', scriptId: 'sc-1' },
      { groupId: 'g2', scriptId: 'sc-2' },
    ]);
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

// ─── normalizePreStepScriptRef ───────────────────────────────────────────

describe('normalizePreStepScriptRef', () => {
  it('returns a trimmed ref when both ids are present', () => {
    const ref = normalizePreStepScriptRef({
      groupId: ' g1 ',
      scriptId: ' sc-1 ',
    });
    expect(ref).toEqual({ groupId: 'g1', scriptId: 'sc-1' });
  });

  it('returns null when groupId is empty', () => {
    expect(
      normalizePreStepScriptRef({ groupId: '', scriptId: 'sc-1' }),
    ).toBeNull();
  });

  it('returns null when scriptId is empty', () => {
    expect(
      normalizePreStepScriptRef({ groupId: 'g1', scriptId: '' }),
    ).toBeNull();
  });
});

// ─── clampTimeoutOrNull ──────────────────────────────────────────────────

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

// ─── clampConfirmSecsOrNull ──────────────────────────────────────────────

describe('normalizePreScript — confirm fields', () => {
  it('defaults confirm/confirmSecs/confirmOnTimeout for missing input', () => {
    const sc = normalizePreScript({});
    expect(sc.confirm).toBe(false);
    expect(sc.confirmSecs).toBeNull();
    expect(sc.confirmOnTimeout).toBe('cancel');
  });

  it('defaults confirmSecs to 60 when confirm:true and confirmSecs unset', () => {
    const sc = normalizePreScript({ confirm: true });
    expect(sc.confirm).toBe(true);
    expect(sc.confirmSecs).toBe(60);
    expect(sc.confirmOnTimeout).toBe('cancel');
  });

  it('clamps confirmSecs below minimum (confirm:true, confirmSecs:2 → 3)', () => {
    const sc = normalizePreScript({ confirm: true, confirmSecs: 2 });
    expect(sc.confirmSecs).toBe(3);
  });

  it('clamps confirmSecs above maximum (confirm:true, confirmSecs:99999 → 3600)', () => {
    const sc = normalizePreScript({ confirm: true, confirmSecs: 99999 });
    expect(sc.confirmSecs).toBe(3600);
  });

  it('sets confirmSecs to null for explicit empty string even when confirm:true', () => {
    const sc = normalizePreScript({ confirm: true, confirmSecs: '' });
    expect(sc.confirmSecs).toBeNull();
  });

  it('sets confirmSecs to null when confirm is false, regardless of confirmSecs input', () => {
    const sc = normalizePreScript({ confirm: false, confirmSecs: 60 });
    expect(sc.confirmSecs).toBeNull();
  });

  it('preserves explicit confirmOnTimeout "confirm"', () => {
    const sc = normalizePreScript({
      confirm: true,
      confirmOnTimeout: 'confirm',
    });
    expect(sc.confirmOnTimeout).toBe('confirm');
  });

  it('defaults unknown confirmOnTimeout to "cancel"', () => {
    const sc = normalizePreScript({ confirmOnTimeout: 'xyz' });
    expect(sc.confirmOnTimeout).toBe('cancel');
  });
});

// ─── normalizeGroup — preScripts field ───────────────────────────────────

describe('normalizeGroup — preScripts field', () => {
  it('defaults preScripts to [] when absent', () => {
    const g = normalizeGroup({ path: '/some/path' });
    expect(g.preScripts).toEqual([]);
  });

  it('normalizes provided preScripts', () => {
    const g = normalizeGroup({
      path: '/p',
      preScripts: [{ id: 'sc-1', name: 'Install', command: 'pnpm install' }],
    });
    expect(g.preScripts).toHaveLength(1);
    expect(g.preScripts[0].id).toBe('sc-1');
    expect(g.preScripts[0].name).toBe('Install');
  });

  it('UUID round-trip: re-normalizing an already-normalized group preserves script ids', () => {
    const original = normalizeGroup({
      path: '/p',
      preScripts: [{ id: 'sc-bbb', name: 'Build', command: 'pnpm build' }],
    });
    const json = JSON.stringify(original);
    const restored = normalizeGroup(JSON.parse(json));
    expect(restored.preScripts[0].id).toBe('sc-bbb');
  });

  it('old group fixture without preScripts gets preScripts:[]', () => {
    const g = normalizeGroup({
      path: '/p',
      name: 'Legacy',
      commands: [],
      actions: [],
    });
    expect(g.preScripts).toEqual([]);
  });

  it('drops legacy preSteps/preScriptsAutoRun instead of carrying them onto the group', () => {
    const g = normalizeGroup({
      path: '/p',
      preSteps: [{ id: 'step-1', mode: 'serial', scripts: [] }],
      preScriptsAutoRun: true,
    });
    expect(g).not.toHaveProperty('preSteps');
    expect(g).not.toHaveProperty('preScriptsAutoRun');
  });
});

// ─── Legacy configs the pre-TypeScript versions accepted ───────────────
