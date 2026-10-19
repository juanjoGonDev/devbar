import { describe, expect, it, vi } from 'vitest';
import {
  registerWorkflowsIpc,
  type WorkflowsIpcDeps,
} from '../src/main/ipc/workflows-ipc.js';
import { recordingIpc } from './helpers/main-fakes.js';
import type { Workflow } from '../src/domain-types.js';

/**
 * `src/main/ipc/workflows-ipc.ts` — the workflows:* channels: each narrows
 * its payload, calls the store or the runner, and broadcasts after a write.
 */

const WORKFLOW: Workflow = {
  id: 'w1',
  name: 'Arranque',
  enabled: true,
  hidden: false,
  trigger: { kind: 'startup' },
  graph: { blocks: [], edges: [] },
};

function harness() {
  const calls: string[] = [];
  const ipc = recordingIpc();
  const deps: WorkflowsIpcDeps = {
    configStore: {
      saveWorkflow: (data) => {
        if ((data as Workflow).name === 'bad') throw new Error('Nombre malo');
        calls.push(`save:${(data as Workflow).id}`);
        return data as Workflow;
      },
      createWorkflow: (name, trigger) => {
        calls.push(`create:${name}:${trigger.kind}`);
        return { ...WORKFLOW, name, trigger };
      },
      deleteWorkflow: (id) => calls.push(`delete:${id}`),
      setWorkflowEnabled: (id, enabled) => {
        calls.push(`enabled:${id}:${enabled}`);
        return { ...WORKFLOW, enabled };
      },
      makeStartupWorkflow: (id) => {
        calls.push(`startup:${id}`);
        return [WORKFLOW];
      },
      setGroupHiddenInTray: (id, hidden) => {
        calls.push(`hidden:${id}:${hidden}`);
        return null;
      },
    },
    workflowRunner: {
      run: (id, cause) => {
        calls.push(`run:${id}:${cause}`);
        return Promise.resolve({ ok: true, runId: 1 });
      },
      stop: (id) => {
        calls.push(`stop:${id}`);
        return { ok: true };
      },
      retryFrom: (id, blockId) => {
        calls.push(`retry:${id}:${blockId}`);
        return Promise.resolve({ ok: true, runId: 2 });
      },
      runStates: () => [],
      runState: () => null,
      scriptLog: (id, runId, ref) => {
        calls.push(`log:${id}:${runId}:${ref.scriptId}`);
        return [];
      },
      isRunning: (id) => id === 'busy',
    },
    workflowEntries: () => [],
    broadcast: () => calls.push('broadcast'),
    openLogs: vi.fn(),
    openWorkflowsConfig: vi.fn(),
  };
  registerWorkflowsIpc(ipc, deps);
  return { ipc, calls, deps };
}

describe('src/main/ipc/workflows-ipc.ts', () => {
  it('claims every workflow channel', () => {
    expect(harness().ipc.channels()).toEqual([
      'workflows:list',
      'workflows:save',
      'workflows:create',
      'workflows:delete',
      'workflows:setEnabled',
      'workflows:makeStartup',
      'workflows:run',
      'workflows:stop',
      'workflows:retryFrom',
      'workflows:runState',
      'workflows:scriptLog',
      'workflows:openLog',
      'workflows:openConfig',
      'groups:setHiddenInTray',
    ]);
  });

  it('saves a workflow and broadcasts', () => {
    const h = harness();
    expect(h.ipc.invoke('workflows:save', { workflow: WORKFLOW })).toEqual(
      WORKFLOW,
    );
    expect(h.calls).toEqual(['save:w1', 'broadcast']);
  });

  it('throws a refused workflow back without broadcasting', () => {
    const h = harness();
    expect(() =>
      h.ipc.invoke('workflows:save', {
        workflow: { ...WORKFLOW, name: 'bad' },
      }),
    ).toThrow('Nombre malo');
    expect(h.calls).toEqual([]);
  });

  it('creates, toggles and moves the startup trigger', () => {
    const h = harness();
    h.ipc.invoke('workflows:create', {
      name: 'Backup',
      trigger: { kind: 'manual' },
    });
    h.ipc.invoke('workflows:setEnabled', { workflowId: 'w1', enabled: false });
    h.ipc.invoke('workflows:makeStartup', { workflowId: 'w1' });
    expect(h.calls).toEqual([
      'create:Backup:manual',
      'broadcast',
      'enabled:w1:false',
      'broadcast',
      'startup:w1',
      'broadcast',
    ]);
  });

  it('refuses a trigger that is not an object', () => {
    const h = harness();
    expect(() =>
      h.ipc.invoke('workflows:create', { name: 'x', trigger: 'cron' }),
    ).toThrow();
  });

  it('stops a running workflow before deleting it', async () => {
    const h = harness();
    await h.ipc.invoke('workflows:delete', { workflowId: 'busy' });
    expect(h.calls).toEqual(['stop:busy', 'delete:busy', 'broadcast']);
  });

  it('runs manually, stops and retries', async () => {
    const h = harness();
    await h.ipc.invoke('workflows:run', { workflowId: 'w1' });
    h.ipc.invoke('workflows:stop', { workflowId: 'w1' });
    await h.ipc.invoke('workflows:retryFrom', {
      workflowId: 'w1',
      blockId: 'b1',
    });
    expect(h.calls).toEqual(['run:w1:manual', 'stop:w1', 'retry:w1:b1']);
  });

  it('reads a script log of the latest or a given run', () => {
    const h = harness();
    const ref = { groupId: 'g', scriptId: 's' };
    h.ipc.invoke('workflows:scriptLog', {
      workflowId: 'w1',
      runId: 'latest',
      ref,
    });
    h.ipc.invoke('workflows:scriptLog', { workflowId: 'w1', runId: 7, ref });
    expect(h.calls).toEqual(['log:w1:latest:s', 'log:w1:7:s']);
  });

  it('opens a script log, or the run narration without a ref', () => {
    const h = harness();
    h.deps.workflowRunner.runState = () => ({
      workflowId: 'w1',
      runId: 5,
      aggregatorId: 'pre-pipeline:5',
      status: 'success',
      blocks: [],
      scripts: [],
      doneScripts: 0,
      totalScripts: 0,
      startedAt: 0,
      finishedAt: 1,
    });
    h.ipc.invoke('workflows:openLog', {
      workflowId: 'w1',
      ref: { groupId: 'g', scriptId: 's' },
    });
    h.ipc.invoke('workflows:openLog', { workflowId: 'w1', ref: null });
    expect(h.deps.openLogs).toHaveBeenNthCalledWith(1, 'pre:g:s');
    expect(h.deps.openLogs).toHaveBeenNthCalledWith(2, 'pre-pipeline:5');
  });

  it('cannot open the narration of a workflow that never ran', () => {
    const h = harness();
    expect(
      h.ipc.invoke('workflows:openLog', { workflowId: 'w1', ref: null }),
    ).toEqual({ ok: false, error: 'not_run' });
  });

  it('hides a group in the tray and broadcasts', () => {
    const h = harness();
    h.ipc.invoke('groups:setHiddenInTray', { groupId: 'g', hidden: true });
    expect(h.calls).toEqual(['hidden:g:true', 'broadcast']);
  });

  it('opens settings on the Workflows section', () => {
    const h = harness();
    h.ipc.invoke('workflows:openConfig');
    expect(h.deps.openWorkflowsConfig).toHaveBeenCalled();
  });
});
