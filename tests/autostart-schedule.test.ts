import { describe, it, expect } from 'vitest';
import {
  planAutoStartRelease,
  withheldGroupIds,
} from '../src/autostart-schedule.js';
import type { PreStep } from '../src/domain-types.js';

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

describe('withheldGroupIds — decided override: one release rule for failure and decline', () => {
  // main.ts's autoStartAllMarkedCommands stops the run at the same frozen
  // `firedStepIndexes` set whether it was a genuine failure at step N or a
  // declined confirmation at step N — withheldGroupIds has no parameter for
  // "why", so both causes MUST withhold identically. This is the pure-module
  // proof for the Decided Override in the tasks artifact: one release rule,
  // not two.
  it('withholds the identical set whether the run stopped by failure or by a declined confirmation', () => {
    const steps = [
      step('s1', [{ groupId: 'gA', scriptId: 'sc1' }]),
      step('s2', [{ groupId: 'gB', scriptId: 'sc2' }]),
      step('s3', [{ groupId: 'gC', scriptId: 'sc3' }]),
    ];
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB', 'gC'],
    });
    // Both a failure and a decline at step 1 freeze the same fired set: only
    // step 0 ever completed.
    const firedByFailure = new Set([0]);
    const firedByDecline = new Set([0]);
    const withheldOnFailure = withheldGroupIds(plan, firedByFailure);
    const withheldOnDecline = withheldGroupIds(plan, firedByDecline);
    expect(withheldOnFailure).toEqual(['gB', 'gC']);
    expect(withheldOnFailure).toEqual(withheldOnDecline);
  });
});
