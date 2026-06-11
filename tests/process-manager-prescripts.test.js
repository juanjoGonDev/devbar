import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseProcessId, makePreScriptId, makeAggregatorId, makeCommandId, makeActionId } from '../src/compound-id.js';

/**
 * process-manager-prescripts.test.js
 *
 * ProcessManager requires child_process / readline which are Node-compatible
 * but its constructor calls configStore.getGroup(). We test the pieces that
 * are unit-testable without spawning processes:
 *
 * 1. resolveTarget() for all 4 pid kinds (including prescript + preAggregator).
 * 2. Env semantics: confirm prescript goes through the 'else' branch (inheritGroupEnv).
 * 3. allStates() comment-level verification — pre: pids are not iterated.
 * 4. parseProcessId correctness for all 4 pid kinds.
 *
 * Integration (action:done emission, actual spawn) is covered by
 * pre-script-runner.test.js with a mock processManager.
 */

// ─── Minimal configStore stub ─────────────────────────────────────────────────

const GROUP = {
  id: 'g1',
  name: 'Test Group',
  path: '/project',
  env: [],
  commands: [{ id: 'c1', name: 'Dev', command: 'pnpm dev', env: [] }],
  actions: [{ id: 'a1', name: 'Install', command: 'pnpm install', env: [] }],
  preSteps: [
    {
      id: 's1',
      mode: 'parallel',
      scripts: [
        { id: 'sc1', name: 'Build', command: 'pnpm build', env: [], inheritGroupEnv: false },
        { id: 'sc2', name: 'Lint', command: 'pnpm lint', env: [], inheritGroupEnv: true },
      ],
    },
  ],
};

function makeConfigStoreStub(group = GROUP) {
  return {
    getGroup: (id) => (id === group.id ? group : null),
    listGroups: () => [group],
    getGlobalSettings: () => ({ maxLogLines: 2000 }),
  };
}

// ─── Import ProcessManager ────────────────────────────────────────────────────

import { ProcessManager } from '../src/process-manager.js';

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe('ProcessManager.resolveTarget — all 4 pid kinds', () => {
  let pm;

  beforeEach(() => {
    pm = new ProcessManager(makeConfigStoreStub());
  });

  it('resolves command pid', () => {
    const pid = makeCommandId('g1', 'c1');
    const r = pm.resolveTarget(pid);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('command');
    expect(r.target.id).toBe('c1');
  });

  it('resolves action pid', () => {
    const pid = makeActionId('g1', 'a1');
    const r = pm.resolveTarget(pid);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('action');
    expect(r.target.id).toBe('a1');
  });

  it('resolves prescript pid', () => {
    const pid = makePreScriptId('g1', 's1', 'sc1');
    const r = pm.resolveTarget(pid);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('prescript');
    expect(r.target.id).toBe('sc1');
  });

  it('resolves prescript pid for second script in step', () => {
    const pid = makePreScriptId('g1', 's1', 'sc2');
    const r = pm.resolveTarget(pid);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('prescript');
    expect(r.target.id).toBe('sc2');
    expect(r.target.inheritGroupEnv).toBe(true);
  });

  it('returns null for preAggregator pid (virtual — no spawn)', () => {
    const pid = makeAggregatorId('g1', '1234567890');
    const r = pm.resolveTarget(pid);
    expect(r).toBeNull();
  });

  it('returns null for unknown pid', () => {
    expect(pm.resolveTarget('xyz:bad')).toBeNull();
    expect(pm.resolveTarget('')).toBeNull();
    expect(pm.resolveTarget(null)).toBeNull();
  });

  it('returns null when group not found', () => {
    const pid = makePreScriptId('nonexistent', 's1', 'sc1');
    expect(pm.resolveTarget(pid)).toBeNull();
  });

  it('returns null when step not found in group', () => {
    const pid = makePreScriptId('g1', 'missing-step', 'sc1');
    expect(pm.resolveTarget(pid)).toBeNull();
  });

  it('returns null when script not found in step', () => {
    const pid = makePreScriptId('g1', 's1', 'missing-script');
    expect(pm.resolveTarget(pid)).toBeNull();
  });
});

// ─── parseProcessId — all 4 kinds ────────────────────────────────────────────

describe('parseProcessId — all 4 pid kinds resolve correctly', () => {
  it('cmd: → kind command', () => {
    const p = parseProcessId(makeCommandId('g1', 'c1'));
    expect(p.kind).toBe('command');
    expect(p.groupId).toBe('g1');
    expect(p.commandId).toBe('c1');
  });

  it('act: → kind action', () => {
    const p = parseProcessId(makeActionId('g1', 'a1'));
    expect(p.kind).toBe('action');
    expect(p.groupId).toBe('g1');
    expect(p.actionId).toBe('a1');
  });

  it('pre: → kind prescript', () => {
    const p = parseProcessId(makePreScriptId('g1', 's1', 'sc1'));
    expect(p.kind).toBe('prescript');
    expect(p.groupId).toBe('g1');
    expect(p.stepId).toBe('s1');
    expect(p.scriptId).toBe('sc1');
  });

  it('pre-pipeline: → kind preAggregator', () => {
    const p = parseProcessId(makeAggregatorId('g1', '1234567890'));
    expect(p.kind).toBe('preAggregator');
    expect(p.groupId).toBe('g1');
    expect(p.runId).toBe('1234567890');
  });

  it('malformed → kind unknown', () => {
    expect(parseProcessId('bad')).toEqual({ kind: 'unknown' });
    expect(parseProcessId(null)).toEqual({ kind: 'unknown' });
    expect(parseProcessId('pre:g1:s1')).toEqual({ kind: 'unknown' }); // only 3 segments
  });
});

// ─── allStates() excludes pre: pids ─────────────────────────────────────────

describe('ProcessManager.allStates() excludes pre-script pids', () => {
  it('only iterates commands and actions — no prescript entries', () => {
    const pm = new ProcessManager(makeConfigStoreStub());
    const entries = pm.allStates();
    const kinds = entries.map((e) => e.kind);
    expect(kinds).not.toContain('prescript');
    expect(kinds).not.toContain('preAggregator');
    // Commands and actions from our GROUP fixture are present
    expect(kinds).toContain('command');
    expect(kinds).toContain('action');
  });
});
