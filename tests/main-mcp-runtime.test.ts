import { describe, expect, it } from 'vitest';
import { createWindowRegistry } from '../src/main/renderer-bus.js';
import { mcpRuntime, type McpRuntimeWiring } from '../src/main/mcp/runtime.js';
import { makeCommand, makeGroup, makeState } from './helpers/main-fakes.js';

type GitAnswer = { ok: boolean; branch?: string; error?: string };

function harness(git: GitAnswer = { ok: false, error: 'not a repo' }) {
  const calls: string[] = [];
  const group = makeGroup({ commands: [makeCommand()] });
  const registry = createWindowRegistry(() => null);
  const wiring: McpRuntimeWiring = {
    configStore: {
      getGroup: (id) => (id === group.id ? group : null),
      listGroups: () => [group],
    },
    processManager: {
      start: (id) => {
        calls.push(`start:${id}`);
        return { ok: true };
      },
      stop: (id) => {
        calls.push(`stop:${id}`);
        return Promise.resolve({ ok: true });
      },
      getState: (id) => makeState({ id, lastExitCode: 3 }),
      getLogs: () => [{ ts: 1, stream: 'stdout', level: null, line: 'hi' }],
    },
    workflowRunner: {
      run: (id) => {
        calls.push(`run:${id}`);
        return Promise.resolve({ ok: true });
      },
      stop: (id) => {
        calls.push(`stopWorkflow:${id}`);
        return { ok: true };
      },
      runState: () => null,
    },
    gitManager: {
      listBranches: () => Promise.resolve([]),
      currentBranch: () => Promise.resolve(git),
      switchBranch: () => Promise.resolve({ ok: true }),
      refreshRemotes: () => Promise.resolve({ changed: false }),
    },
    confirms: { confirmIfNeeded: () => Promise.resolve(true) },
    groupErrors: new Map(),
    broadcast: () => calls.push('broadcast'),
    branchesChanged: () => undefined,
    snapshots: {
      snapshotGroupStates: () => [],
      workflowEntries: () => [],
    },
    registry,
  };
  return { runtime: mcpRuntime(wiring), registry, calls };
}

describe('src/main/mcp/runtime.ts', () => {
  it('hears the state pushes of the renderer bus, and only those', () => {
    const h = harness();
    const heard: string[] = [];
    const stop = h.runtime.onChange((what) => heard.push(what));
    const [listener] = [...h.registry.listeners];

    listener?.send('groups:update', []);
    listener?.send('logs:line', {});
    listener?.send('workflows:update', []);
    stop();
    listener?.send('groups:update', []);

    expect(heard).toEqual(['groups', 'workflows']);
  });

  it('starts and stops through the same runtime actions as the windows', async () => {
    const h = harness();

    await h.runtime.startProcess('cmd:g1:c1');
    await h.runtime.stopProcess('cmd:g1:c1');
    await h.runtime.runWorkflow('w1');
    h.runtime.stopWorkflow('w1');

    expect(h.calls).toEqual([
      'start:cmd:g1:c1',
      'broadcast',
      'stop:cmd:g1:c1',
      'broadcast',
      'run:w1',
      'stopWorkflow:w1',
    ]);
  });

  it('reads groups, logs and process state from the app', () => {
    const h = harness();

    expect(h.runtime.listGroups()).toHaveLength(1);
    expect(h.runtime.logs('cmd:g1:c1')).toHaveLength(1);
    expect(h.runtime.processState('act:g1:a1').lastExitCode).toBe(3);
    expect(h.runtime.workflowRunState('w1')).toBeNull();
  });

  it("answers a group's git branch, or null when git has none", async () => {
    const onBranch = harness({ ok: true, branch: 'fix/date-index' });
    const noRepo = harness();

    await expect(onBranch.runtime.currentBranch('g1')).resolves.toBe(
      'fix/date-index',
    );
    await expect(noRepo.runtime.currentBranch('g1')).resolves.toBeNull();
    await expect(onBranch.runtime.currentBranch('missing')).resolves.toBeNull();
  });
});
