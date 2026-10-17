import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRunner } from '../src/workflow-runner.js';
import type { PreScriptProcessManager } from '../src/pre-script-runner.js';
import { normalizeGroup, normalizePreScript } from '../src/groups-model.js';
import type {
  Action,
  Group,
  LogEntry,
  PreScript,
  Workflow,
  WorkflowRunRecord,
  WorkflowTrigger,
} from '../src/domain-types.js';
import type { WorkflowRunState } from '../src/ipc-contract.js';
import { graph } from './helpers/pipeline.js';

/**
 * `src/workflow-runner.ts` — several workflows, each with its own runner: one
 * active run per workflow, different workflows concurrently, the manual
 * confirmation, the last-run record and the run-state pushes.
 */

interface DoneEvent {
  processId: string;
  code: number | null;
  group: Group;
  target: Action | PreScript;
}

class ManualProcessManager
  extends EventEmitter<{
    log: [payload: { id: string; entry: LogEntry }];
    'action:done': [payload: DoneEvent];
  }>
  implements PreScriptProcessManager
{
  readonly started: string[] = [];
  readonly stop = vi.fn((processId: string) => {
    this.finish(processId, 143);
    return Promise.resolve({ ok: true });
  });
  pushLog(id: string, entry: LogEntry): void {
    this.emit('log', { id, entry });
  }
  start(processId: string): { ok: boolean } {
    this.started.push(processId);
    return { ok: true };
  }
  finish(processId: string, code: number): void {
    this.emit('action:done', {
      processId,
      code,
      group: normalizeGroup({ id: 'g' }),
      target: normalizePreScript({ id: 'x', name: 'x', command: 'x' }),
    });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const MANUAL: WorkflowTrigger = {
  kind: 'manual',
  confirm: false,
};

function workflow(
  id: string,
  scriptId: string,
  trigger: WorkflowTrigger = MANUAL,
): Workflow {
  return {
    id,
    name: `Flujo ${id}`,
    enabled: true,
    showInTray: true,
    showInRemote: false,
    trigger,
    graph: graph([scriptId], [`trigger>${scriptId}`]),
  };
}

function setup(workflows: Workflow[]) {
  const group = normalizeGroup({
    id: 'g',
    name: 'G',
    path: '/tmp/g',
    preScripts: ['A', 'B'].map((id) => ({ id, name: id, command: 'true' })),
  });
  const pm = new ManualProcessManager();
  const runs: Record<string, WorkflowRunRecord> = {};
  const pushed: WorkflowRunState[] = [];
  const confirmWorkflow = vi.fn(() => Promise.resolve(true));
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const runner = createWorkflowRunner({
    processManager: pm,
    configStore: {
      getGroup: (id) => (id === 'g' ? group : null),
      listWorkflows: () => workflows,
      recordWorkflowRun: (id, run) => {
        runs[id] = run;
      },
    },
    broadcastUpdate: vi.fn(),
    onRunState: (state) => pushed.push(state),
    confirmWorkflow,
    onSuccess,
    onError,
  });
  const finish = async (scriptId: string, code = 0): Promise<void> => {
    pm.finish(`pre:g:${scriptId}`, code);
    await settle();
  };
  return {
    pm,
    runner,
    runs,
    pushed,
    finish,
    confirmWorkflow,
    onSuccess,
    onError,
  };
}

describe('src/workflow-runner.ts', () => {
  it('runs two workflows at the same time', async () => {
    const { pm, runner, finish } = setup([
      workflow('w1', 'A'),
      workflow('w2', 'B'),
    ]);
    const first = runner.run('w1');
    const second = runner.run('w2');
    await settle();
    expect(pm.started).toEqual(['pre:g:A', 'pre:g:B']);
    expect(runner.isRunning('w1') && runner.isRunning('w2')).toBe(true);
    await finish('A');
    await finish('B');
    expect((await first).ok && (await second).ok).toBe(true);
  });

  it('allows one run per workflow', async () => {
    const { runner, finish } = setup([workflow('w1', 'A')]);
    const first = runner.run('w1');
    expect(await runner.run('w1')).toEqual({
      ok: false,
      error: 'already_running',
    });
    await settle();
    await finish('A');
    await first;
  });

  it('refuses a workflow that does not exist', async () => {
    const { runner } = setup([]);
    expect(await runner.run('nope')).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(runner.stop('nope')).toEqual({ ok: false, error: 'not_running' });
  });

  it('stops only the workflow asked for', async () => {
    const { runner, finish } = setup([
      workflow('w1', 'A'),
      workflow('w2', 'B'),
    ]);
    const first = runner.run('w1');
    const second = runner.run('w2');
    await settle();
    expect(runner.stop('w1')).toEqual({ ok: true });
    expect(await first).toMatchObject({ ok: false, cancelled: true });
    expect(runner.isRunning('w2')).toBe(true);
    await finish('B');
    await second;
  });

  it('pushes every change of a run, stamped with its workflow', async () => {
    const { runner, finish, pushed } = setup([workflow('w1', 'A')]);
    const run = runner.run('w1');
    await settle();
    await finish('A');
    await run;
    expect(pushed.length).toBeGreaterThan(1);
    expect(pushed.every((state) => state.workflowId === 'w1')).toBe(true);
    expect(pushed.at(-1)?.status).toBe('success');
    expect(runner.runStates().map((state) => state.workflowId)).toEqual(['w1']);
  });

  it('records the last run of each workflow', async () => {
    const { runner, finish, runs } = setup([workflow('w1', 'A')]);
    const run = runner.run('w1');
    await settle();
    await finish('A', 1);
    await run;
    expect(runs.w1).toMatchObject({ result: 'error' });
    expect(runs.w1?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('asks before a manual run of a workflow with confirm, and only then', async () => {
    const confirmed = workflow('w1', 'A', { ...MANUAL, confirm: true });
    const { runner, confirmWorkflow, pm, finish } = setup([confirmed]);
    confirmWorkflow.mockResolvedValueOnce(false);
    expect(await runner.run('w1', 'manual')).toEqual({
      ok: false,
      error: 'cancelled',
      cancelled: true,
    });
    expect(pm.started).toEqual([]);

    const scheduled = runner.run('w1', 'schedule');
    await settle();
    expect(confirmWorkflow).toHaveBeenCalledTimes(1);
    await finish('A');
    await scheduled;
  });

  it('names the workflow in the success and error callbacks', async () => {
    const { runner, finish, onSuccess, onError } = setup([
      workflow('w1', 'A'),
      workflow('w2', 'B'),
    ]);
    const ok = runner.run('w1');
    const ko = runner.run('w2');
    await settle();
    await finish('A');
    await finish('B', 1);
    await Promise.all([ok, ko]);
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Flujo w1' }),
      expect.objectContaining({ warned: false }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Flujo w2' }),
      'scripts_failed:1',
      expect.anything(),
    );
  });

  it('retries from a block and serves the script log of the run', async () => {
    const { runner, finish } = setup([workflow('w1', 'A')]);
    const first = runner.run('w1');
    await settle();
    await finish('A', 1);
    await first;
    const retry = runner.retryFrom('w1', 'A');
    await settle();
    await finish('A');
    expect((await retry).ok).toBe(true);
    expect(
      runner.scriptLog('w1', 'latest', { groupId: 'g', scriptId: 'A' }),
    ).not.toBeNull();
    expect(await runner.retryFrom('nope', 'A')).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('cancels every run at once', async () => {
    const { runner } = setup([workflow('w1', 'A'), workflow('w2', 'B')]);
    const runs = [runner.run('w1'), runner.run('w2')];
    await settle();
    expect(runner.anyRunning()).toBe(true);
    runner.cancelAll();
    await Promise.all(runs);
    expect(runner.anyRunning()).toBe(false);
  });
});
