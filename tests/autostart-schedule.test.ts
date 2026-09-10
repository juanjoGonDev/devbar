import { describe, it, expect } from 'vitest';
import {
  planAutoStartRelease,
  withheldGroupIds,
  shouldAutoRunPipeline,
  filterAutoStartEligibleGroups,
  describeWithheldGroups,
  shouldShowGenericFailureToast,
} from '../src/autostart-schedule.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { Group, PreStep } from '../src/domain-types.js';

/**
 * autostart-schedule.test.ts
 *
 * Pure release-planner tests — no Electron, no runner, plain data in and
 * out. This is the test seam for the highest-novelty piece of the change:
 * staged auto-start release timing (D2).
 */

function step(
  id: string,
  refs: Array<{ groupId: string; scriptId: string }>,
): PreStep {
  return { id, mode: 'parallel', scripts: refs };
}

describe('planAutoStartRelease', () => {
  it('places a group with no ref anywhere in the pipeline into immediate', () => {
    const steps = [step('s1', [{ groupId: 'gA', scriptId: 'sc1' }])];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gC'],
    });
    expect(plan.immediate).toEqual(['gC']);
  });

  it('a later ref overwrites an earlier lastStepIndex for the same group (last wins)', () => {
    const steps = [
      step('s1', [{ groupId: 'gA', scriptId: 'sc1' }]),
      step('s2', [{ groupId: 'gB', scriptId: 'sc2' }]),
      step('s3', [{ groupId: 'gA', scriptId: 'sc3' }]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(plan.releases.get(2)).toEqual(['gA']);
    expect(plan.releases.get(0)).toBeUndefined();
  });

  it('emits immediate and releases in eligibleGroupIds input order, not steps-walk order', () => {
    const steps = [
      step('s1', [{ groupId: 'gB', scriptId: 'sc1' }]),
      step('s2', [{ groupId: 'gA', scriptId: 'sc2' }]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB', 'gC'],
    });
    expect(plan.releases.get(1)).toEqual(['gA']);
    expect(plan.releases.get(0)).toEqual(['gB']);
    expect(plan.immediate).toEqual(['gC']);
  });

  it('groups two eligible groups releasing at the same step, in eligibleGroupIds order', () => {
    const steps = [
      step('s1', [
        { groupId: 'gB', scriptId: 'sc1' },
        { groupId: 'gA', scriptId: 'sc2' },
      ]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(plan.releases.get(0)).toEqual(['gA', 'gB']);
  });

  it('ignores a ref whose groupId is not in eligibleGroupIds', () => {
    const steps = [step('s1', [{ groupId: 'gNotEligible', scriptId: 'sc1' }])];
    const plan = planAutoStartRelease({ steps, eligibleGroupIds: ['gA'] });
    expect(plan.immediate).toEqual(['gA']);
    expect(plan.releases.size).toBe(0);
  });
});

describe('withheldGroupIds', () => {
  it('is empty when every release key fired', () => {
    const steps = [
      step('s1', [{ groupId: 'gA', scriptId: 'sc1' }]),
      step('s2', [{ groupId: 'gB', scriptId: 'sc2' }]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB'],
    });
    expect(withheldGroupIds(plan, new Set([0, 1]))).toEqual([]);
  });

  it('names groups whose release step never fired', () => {
    const steps = [
      step('s1', [{ groupId: 'gA', scriptId: 'sc1' }]),
      step('s2', [{ groupId: 'gB', scriptId: 'sc2' }]),
      step('s3', [{ groupId: 'gC', scriptId: 'sc3' }]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB', 'gC'],
    });
    // Only step 0 fired (e.g. a failure at step 1).
    expect(withheldGroupIds(plan, new Set([0]))).toEqual(['gB', 'gC']);
  });

  it('never withholds a group that has no ref anywhere (already started immediately)', () => {
    const steps = [step('s1', [{ groupId: 'gA', scriptId: 'sc1' }])];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gScriptless'],
    });
    const withheld = withheldGroupIds(plan, new Set());
    expect(withheld).toEqual(['gA']);
    expect(withheld).not.toContain('gScriptless');
  });

  it('is empty for a pipeline where nothing is withheld and nothing fired (no releases at all)', () => {
    const plan = planAutoStartRelease({ steps: [], eligibleGroupIds: ['gA'] });
    expect(withheldGroupIds(plan, new Set())).toEqual([]);
  });
});

describe('withheldGroupIds — release rule applies identically regardless of why the run stopped', () => {
  // withheldGroupIds has no "cause" parameter by design: a genuine failure
  // and a declined confirmation freeze the SAME fired set at the SAME
  // stopping point, so main.ts calls this with identical inputs for both.
  // The cause-DEPENDENT part (wording, toast severity) lives entirely in
  // `describeWithheldGroups` below — proven there, and end to end (with a
  // real declined confirmation) in `pre-script-runner.test.ts`.
  it('releases a group whose last step already fired before the stopping point, and withholds every group whose release step comes at or after it', () => {
    const steps = [
      step('s1', [{ groupId: 'gA', scriptId: 'sc1' }]),
      step('s2', [{ groupId: 'gB', scriptId: 'sc2' }]),
      step('s3', [{ groupId: 'gC', scriptId: 'sc3' }]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB', 'gC'],
    });

    // Stopped (by failure OR decline) right after step 0: gA already
    // released, gB/gC withheld.
    const stoppedAfterStep0 = withheldGroupIds(plan, new Set([0]));
    expect(stoppedAfterStep0).toEqual(['gB', 'gC']);
    expect(stoppedAfterStep0).not.toContain('gA');

    // Stopped later, after step 1 ALSO fired: gB is now released too. A
    // DIFFERENT fired set genuinely produces a DIFFERENT result — proving
    // this tracks the real fired set rather than a hardcoded answer.
    const stoppedAfterStep1 = withheldGroupIds(plan, new Set([0, 1]));
    expect(stoppedAfterStep1).toEqual(['gC']);
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
  it('runs only when the login gate passes, the global setting is on, AND there is at least one step', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        preScriptsAutoRun: true,
        stepCount: 1,
      }),
    ).toBe(true);
  });

  it('does not run without the login signal', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: false,
        preScriptsAutoRun: true,
        stepCount: 1,
      }),
    ).toBe(false);
  });

  it('does not run when the global setting is off', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        preScriptsAutoRun: false,
        stepCount: 1,
      }),
    ).toBe(false);
  });

  it('does not run when the pipeline has zero steps', () => {
    expect(
      shouldAutoRunPipeline({
        wasOpenedAtLogin: true,
        preScriptsAutoRun: true,
        stepCount: 0,
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
        preScriptsAutoRun: true,
        stepCount: 3,
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
    expect(report?.aggregatorLine).toContain('pipeline failed');
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
    expect(report?.aggregatorLine).toContain('pipeline cancelled');
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
