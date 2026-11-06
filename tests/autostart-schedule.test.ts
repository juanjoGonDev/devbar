import { describe, it, expect } from 'vitest';
import {
  planAutoStartRelease,
  releasableGroupIds,
  withheldGroupIds,
  shouldAutoRunPipeline,
  filterAutoStartEligibleGroups,
  describeWithheldGroups,
  shouldShowGenericFailureToast,
} from '../src/autostart-schedule.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { Group, Pipeline, PipelineBlock } from '../src/domain-types.js';

/**
 * autostart-schedule.test.ts
 *
 * Pure release-planner tests — no Electron, no runner, plain data in and
 * out. This is the test seam for the highest-novelty piece of the change:
 * staged auto-start release timing (D2), over the pipeline DAG.
 */

/** A block holding one script of each group named. */
function blk(id: string, groupIds: string[]): PipelineBlock {
  return {
    id,
    scripts: groupIds.map((groupId) => ({ groupId, scriptId: `${id}-sc` })),
    x: 0,
    y: 0,
    requireAll: true,
  };
}

function pipe(blocks: PipelineBlock[], edges: string[]): Pipeline {
  return {
    blocks,
    edges: edges.map((edge) => {
      const [from = '', to = ''] = edge.split('>');
      return { from, to };
    }),
  };
}

/** trigger → b1(gA) → b2(gB) → b3(gC) */
const CHAIN = pipe(
  [blk('b1', ['gA']), blk('b2', ['gB']), blk('b3', ['gC'])],
  ['trigger>b1', 'b1>b2', 'b2>b3'],
);

describe('planAutoStartRelease', () => {
  it('places a group with no ref anywhere in the pipeline into immediate', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA', 'gZ'],
    });
    expect(plan.immediate).toEqual(['gZ']);
  });

  it('makes a group wait for EVERY runnable block holding one of its scripts', () => {
    const pipeline = pipe(
      [blk('b1', ['gA']), blk('b2', ['gB']), blk('b3', ['gA'])],
      ['trigger>b1', 'trigger>b2', 'b2>b3'],
    );
    const plan = planAutoStartRelease({
      pipeline,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(plan.awaiting.get('gA')).toEqual(['b1', 'b3']);
    expect(plan.awaiting.get('gB')).toEqual(['b2']);
  });

  it('starts at once a group whose scripts sit only in disconnected blocks', () => {
    const pipeline = pipe(
      [blk('b1', ['gA']), blk('x', ['gB'])],
      ['trigger>b1'],
    );
    const plan = planAutoStartRelease({
      pipeline,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(plan.immediate).toEqual(['gB']);
    expect([...plan.awaiting.keys()]).toEqual(['gA']);
  });

  it('emits immediate and awaiting in eligibleGroupIds input order', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gC', 'gZ', 'gA'],
    });
    expect([...plan.awaiting.keys()]).toEqual(['gC', 'gA']);
    expect(plan.immediate).toEqual(['gZ']);
  });

  it('ignores a ref whose groupId is not in eligibleGroupIds', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gNotInPipeline'],
    });
    expect(plan.immediate).toEqual(['gNotInPipeline']);
    expect(plan.awaiting.size).toBe(0);
  });
});

describe('planAutoStartRelease — waitingGroupIds (per-group wait-for-pipeline)', () => {
  // The flaw this covers: a group's own blocks can succeed while a LATER or
  // independent block belonging to a DIFFERENT group still disrupts shared
  // infra (e.g. a second `make setup` restarting Docker). A waiting group
  // releases only once the WHOLE pipeline succeeded.
  it('makes a waiting group wait for every runnable block', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA'],
      waitingGroupIds: ['gA'],
    });
    expect(plan.awaiting.get('gA')).toEqual(['b1', 'b2', 'b3']);
  });

  it('a non-waiting group still waits only for its own blocks', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA', 'gB'],
      waitingGroupIds: ['gB'],
    });
    expect(plan.awaiting.get('gA')).toEqual(['b1']);
  });

  it('does not affect a waiting group with no ref anywhere — it still starts immediately', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA', 'gScriptless'],
      waitingGroupIds: ['gScriptless'],
    });
    expect(plan.immediate).toEqual(['gScriptless']);
  });

  // The exact reported scenario: Back's (gA) own block succeeds early, but
  // Automator's (gC) LATER block restarts Docker again and fails. Back must
  // stay withheld, not already running with a broken DB connection.
  it('withholds a waiting group whose own block succeeded when another block fails', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA', 'gC'],
      waitingGroupIds: ['gA'],
    });
    const completed = new Set(['b1', 'b2']);
    expect(releasableGroupIds(plan, completed)).toEqual([]);
    expect(withheldGroupIds(plan, completed)).toEqual(['gA', 'gC']);
  });

  it('releases a waiting group once every block succeeded', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA', 'gC'],
      waitingGroupIds: ['gA'],
    });
    const completed = new Set(['b1', 'b2', 'b3']);
    expect(releasableGroupIds(plan, completed)).toEqual(['gA', 'gC']);
    expect(withheldGroupIds(plan, completed)).toEqual([]);
  });
});

describe('releasableGroupIds / withheldGroupIds', () => {
  it('releases a group as soon as its own blocks are done, whatever else runs', () => {
    const pipeline = pipe(
      [blk('b1', ['gA']), blk('b2', ['gB'])],
      ['trigger>b1', 'trigger>b2'],
    );
    const plan = planAutoStartRelease({
      pipeline,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(releasableGroupIds(plan, new Set(['b2']))).toEqual(['gB']);
    expect(withheldGroupIds(plan, new Set(['b2']))).toEqual(['gA']);
  });

  it('never withholds a group that has no ref anywhere (already started immediately)', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gZ'],
    });
    expect(withheldGroupIds(plan, new Set())).toEqual([]);
  });

  it('withholds every awaiting group when nothing completed', () => {
    const plan = planAutoStartRelease({
      pipeline: CHAIN,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(withheldGroupIds(plan, new Set())).toEqual(['gA', 'gB']);
  });
});

describe('filterAutoStartEligibleGroups', () => {
  // normalizeGroup accepts `unknown` and fills every default — the object
  // literals below are deliberately loose (only the fields each case cares
  // about), matching how a hand-edited or partial raw store shape arrives.
  function group(overrides: { id: string } & Record<string, unknown>): Group {
    return normalizeGroup(overrides);
  }

  it('keeps only groups with at least one autoStart:true command', () => {
    const eligible = group({
      id: 'gA',
      commands: [{ id: 'c1', command: 'true', autoStart: true }],
    });
    const notEligible = group({
      id: 'gB',
      commands: [{ id: 'c2', command: 'true', autoStart: false }],
    });
    const result = filterAutoStartEligibleGroups([eligible, notEligible]);
    expect(result.map((g) => g.id)).toEqual(['gA']);
  });

  it('excludes a group whose only autoStart-like item is an action, not a command', () => {
    // Actions are never eligible (running e.g. `pnpm install` at every boot
    // would be wrong) — only `commands` are checked.
    const withActionOnly = group({
      id: 'gA',
      commands: [{ id: 'c1', command: 'true', autoStart: false }],
      actions: [{ id: 'a1', command: 'true' }],
    });
    const result = filterAutoStartEligibleGroups([withActionOnly]);
    expect(result).toEqual([]);
  });

  it('returns an empty array when no group has any autoStart command', () => {
    const result = filterAutoStartEligibleGroups([
      group({ id: 'gA', commands: [] }),
    ]);
    expect(result).toEqual([]);
  });
});

describe('shouldAutoRunPipeline', () => {
  it('runs only when the login gate passes, the global setting is on, AND there is at least one runnable script', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        startupEnabled: true,
        scriptCount: 1,
      }),
    ).toBe(true);
  });

  it('does not run without the login signal', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: false,
        startupEnabled: true,
        scriptCount: 1,
      }),
    ).toBe(false);
  });

  it('does not run when the global setting is off', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        startupEnabled: false,
        scriptCount: 1,
      }),
    ).toBe(false);
  });

  it('does not run when the pipeline has no runnable script', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        startupEnabled: true,
        scriptCount: 0,
      }),
    ).toBe(false);
  });

  // The W2 fix: this decision has NO `eligibleGroups`/`hasEligibleGroups`
  // parameter at all — a pipeline with real steps runs at login regardless
  // of whether any group has an autoStart command (a VPN tunnel, a `make
  // setup` step has value on its own). This is exactly the scenario
  // sdd-verify found broken: the OLD code checked `eligibleGroups.length`
  // before ever reaching this decision.
  it('runs even when there would be zero autoStart-eligible groups (the W2 fix)', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        startupEnabled: true,
        scriptCount: 3,
      }),
    ).toBe(true);
  });
});

describe('describeWithheldGroups', () => {
  const groupsById = new Map([
    ['gB', { name: 'Group B' }],
    ['gC', { name: 'Group C' }],
  ]);

  it('returns null when nothing is withheld', () => {
    expect(
      describeWithheldGroups({ withheldIds: [], groupsById, cause: 'failure' }),
    ).toBeNull();
  });

  it('a genuine failure reports an error toast and an error-level aggregator line', () => {
    const report = describeWithheldGroups({
      withheldIds: ['gB', 'gC'],
      groupsById,
      cause: 'failure',
    });
    expect(report).not.toBeNull();
    expect(report?.toastKind).toBe('error');
    expect(report?.aggregatorLevel).toBe('error');
    expect(report?.aggregatorLine).toContain('workflow de arranque fallido');
    expect(report?.message).toContain('Group B');
    expect(report?.message).toContain('Group C');
  });

  // The exact seam C2 named: a decline is a cancellation, never an error.
  it('a declined confirmation reports a non-error ("ok") toast and a warn-level aggregator line, never an error', () => {
    const report = describeWithheldGroups({
      withheldIds: ['gB', 'gC'],
      groupsById,
      cause: 'cancelled',
    });
    expect(report).not.toBeNull();
    expect(report?.toastKind).toBe('ok');
    expect(report?.toastKind).not.toBe('error');
    expect(report?.aggregatorLevel).toBe('warn');
    expect(report?.aggregatorLine).toContain('workflow de arranque cancelado');
  });

  it('falls back to the raw id when a group is not present in groupsById', () => {
    const report = describeWithheldGroups({
      withheldIds: ['ghost'],
      groupsById: new Map(),
      cause: 'failure',
    });
    expect(report?.message).toContain('ghost');
  });
});

// sdd-verify W5: a genuine pipeline failure fired two error toasts — the
// runner's own generic `onError` toast, then a second, more informative one
// naming the withheld groups (`describeWithheldGroups`, above). This is the
// pure decision behind main.ts's collapse to a single toast.
describe('shouldShowGenericFailureToast', () => {
  it('shows the generic toast for a manual (non-boot) run with nothing withheld', () => {
    expect(
      shouldShowGenericFailureToast({ isBootRun: false, withheldCount: 0 }),
    ).toBe(true);
  });

  it('shows the generic toast for a manual run even if withheldCount is (nonsensically) non-zero', () => {
    // A manual, tray-triggered run never populates activeAutoStartRelease
    // (main.ts), so withheldCount is always 0 in practice for isBootRun:
    // false — this case only proves isBootRun is the deciding branch, not
    // withheldCount alone.
    expect(
      shouldShowGenericFailureToast({ isBootRun: false, withheldCount: 2 }),
    ).toBe(true);
  });

  it('shows the generic toast for a boot run that withholds nothing — it is the only feedback for that failure', () => {
    expect(
      shouldShowGenericFailureToast({ isBootRun: true, withheldCount: 0 }),
    ).toBe(true);
  });

  it('suppresses the generic toast for a boot run that withholds at least one group — the named-groups report is more informative', () => {
    expect(
      shouldShowGenericFailureToast({ isBootRun: true, withheldCount: 1 }),
    ).toBe(false);
  });
});
