import { describe, expect, it, vi } from 'vitest';
import { workflowFeedback } from '../src/main/workflow-wiring.js';
import type { Workflow } from '../src/domain-types.js';
import { graph } from './helpers/pipeline.js';

/**
 * `src/main/workflow-wiring.ts` — what the user hears about a workflow run:
 * the error toast, the completion notification and the manual confirmation,
 * each naming the workflow.
 */

const workflow = (kind: 'startup' | 'manual'): Workflow => ({
  id: 'w1',
  name: 'Backup',
  enabled: true,
  hidden: false,
  trigger:
    kind === 'startup'
      ? { kind: 'startup' }
      : {
          kind: 'manual',
          confirm: true,
        },
  graph: graph(['A', 'B'], ['trigger>A', 'A>B']),
});

function harness(bootReportsIt = false) {
  const toast = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(() => Promise.resolve(true));
  const feedback = workflowFeedback({
    toast,
    notify,
    confirm,
    bootReportsStartupFailure: () => bootReportsIt,
    totalScripts: () => 8,
  });
  return { feedback, toast, notify, confirm };
}

describe('src/main/workflow-wiring.ts', () => {
  it('names the workflow and the failed scripts in the error toast', () => {
    const h = harness();
    h.feedback.onError(workflow('manual'), 'scripts_failed:2', {
      failedScripts: 2,
    });
    expect(h.toast).toHaveBeenCalledWith(
      'error',
      'Workflow «Backup»: Fallaron 2 scripts de 8',
    );
  });

  it('leaves the startup failure to the boot report when there is one', () => {
    const h = harness(true);
    h.feedback.onError(workflow('startup'), 'scripts_failed:1', {
      failedScripts: 1,
    });
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('says when a run completed, and when it did with warnings', () => {
    const h = harness();
    h.feedback.onSuccess(workflow('manual'), {
      runId: 1,
      scriptCount: 2,
      warned: false,
    });
    h.feedback.onSuccess(workflow('manual'), {
      runId: 2,
      scriptCount: 2,
      warned: true,
    });
    expect(h.notify.mock.calls).toEqual([
      ['DevBar — workflows', '«Backup» completado (2 scripts)'],
      ['DevBar — workflows', '«Backup» completado con avisos (2 scripts)'],
    ]);
  });

  it('asks with the workflow name and its script count, with no countdown', async () => {
    const h = harness();
    await h.feedback.confirmWorkflow(workflow('manual'));
    expect(h.confirm).toHaveBeenCalledWith({
      name: 'Backup',
      command: 'Workflow · 2 scripts',
      args: [],
      confirmSecs: null,
      confirmOnTimeout: 'cancel',
    });
  });
});
