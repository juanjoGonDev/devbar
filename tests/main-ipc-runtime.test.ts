import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeIpc,
  type RuntimeIpcDeps,
} from '../src/main/ipc/runtime-ipc.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeState,
  recordingIpc,
} from './helpers/main-fakes.js';
import type { Group, ProcessState } from '../src/domain-types.js';

function harness(
  groups: Group[] = [],
  overrides: Partial<RuntimeIpcDeps> = {},
) {
  const calls: string[] = [];
  const states = new Map<string, ProcessState>();
  const groupErrors = new Map<string, string | null>();
  const confirms = {
    confirmIfNeeded: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
    getContext: vi.fn(() => null),
    resolveConfirm: vi.fn(),
  };
  let switchResult: { ok: boolean; error?: string } = { ok: true };
  const ipc = recordingIpc();
  registerRuntimeIpc(ipc, {
    configStore: { getGroup: (id) => groups.find((g) => g.id === id) ?? null },
    processManager: {
      start: (pid) => {
        calls.push(`start:${pid}`);
        return { ok: true };
      },
      stop: (pid) => {
        calls.push(`stop:${pid}`);
        return Promise.resolve({ ok: true });
      },
      getState: (id) => states.get(id) ?? makeState({ id }),
    },
    preScriptRunner: {
      run: () => {
        calls.push('run');
        return Promise.resolve({ ok: true });
      },
      cancel: () => {
        calls.push('cancel');
        return { ok: true };
      },
    },
    gitManager: {
      listBranches: (p) => Promise.resolve({ ok: true, branches: [p] }),
      currentBranch: (p) => Promise.resolve({ ok: true, branch: p }),
      switchBranch: (_p, branch) => {
        calls.push(`switch:${branch}`);
        return Promise.resolve(switchResult);
      },
    },
    confirms,
    snapshots: { snapshotPipelineState: () => ({}) as never },
    groupErrors,
    broadcast: () => calls.push('broadcast'),
    ...overrides,
  });
  return {
    ipc,
    calls,
    states,
    groupErrors,
    confirms,
    failSwitch: (error: string) => {
      switchResult = { ok: false, error };
    },
    clearSwitchError: () => {
      switchResult = { ok: false };
    },
  };
}

describe('src/main/ipc/runtime-ipc.ts', () => {
  describe('registration', () => {
    it('claims every runtime channel', () => {
      expect(harness().ipc.channels()).toEqual([
        'actions:run',
        'prescripts:run',
        'prescripts:cancel',
        'pipeline:state',
        'prescriptConfirm:getContext',
        'prescriptConfirm:resolve',
        'process:start',
        'process:stop',
        'git:listBranches',
        'git:currentBranch',
        'git:switchBranch',
      ]);
    });
  });

  describe('actions:run', () => {
    it('starts the action and reports its process id', async () => {
      const h = harness([makeGroup({ actions: [makeAction({ id: 'a1' })] })]);
      await expect(
        h.ipc.invoke('actions:run', { groupId: 'g1', actionId: 'a1' }),
      ).resolves.toEqual({
        ok: true,
        processId: 'act:g1:a1',
        error: undefined,
      });
    });

    it('never starts an action whose confirmation was declined', async () => {
      const h = harness([makeGroup({ actions: [makeAction({ id: 'a1' })] })]);
      h.confirms.confirmIfNeeded.mockResolvedValue(false);
      await expect(
        h.ipc.invoke('actions:run', { groupId: 'g1', actionId: 'a1' }),
      ).resolves.toEqual({
        ok: false,
        cancelled: true,
        processId: 'act:g1:a1',
      });
      expect(h.calls).toEqual([]);
    });
  });

  describe('pipeline', () => {
    it('runs and cancels the one global pipeline, and reads its state', async () => {
      const h = harness();
      await h.ipc.invoke('prescripts:run');
      h.ipc.invoke('prescripts:cancel');
      expect(h.ipc.invoke('pipeline:state')).toEqual({});
      expect(h.calls).toEqual(['run', 'cancel']);
    });

    it('answers the modal with its own context and resolves it', () => {
      const h = harness();
      h.ipc.invoke('prescriptConfirm:getContext', 't1');
      expect(h.confirms.getContext).toHaveBeenCalledWith('t1');
      expect(
        h.ipc.invoke('prescriptConfirm:resolve', {
          token: 't1',
          decision: 'confirm',
        }),
      ).toEqual({ ok: true });
      expect(h.confirms.resolveConfirm).toHaveBeenCalledWith('t1', 'confirm');
    });
  });

  describe('process:start', () => {
    it('refuses an unparseable process id', async () => {
      const h = harness();
      await expect(h.ipc.invoke('process:start', 'nonsense')).resolves.toEqual({
        ok: false,
        error: 'Invalid process id',
      });
    });

    it('starts a command after its confirmation', async () => {
      const h = harness([makeGroup({ commands: [makeCommand({ id: 'c1' })] })]);
      await expect(h.ipc.invoke('process:start', 'cmd:g1:c1')).resolves.toEqual(
        {
          ok: true,
        },
      );
      expect(h.calls).toContain('start:cmd:g1:c1');
    });

    it('stops nothing when the confirmation is declined', async () => {
      const h = harness([makeGroup({ commands: [makeCommand({ id: 'c1' })] })]);
      h.confirms.confirmIfNeeded.mockResolvedValue(false);
      await expect(h.ipc.invoke('process:start', 'cmd:g1:c1')).resolves.toEqual(
        {
          ok: false,
          cancelled: true,
        },
      );
      expect(h.calls).toEqual([]);
    });

    it('stops the other running commands of a single-mode group first', async () => {
      const h = harness([
        makeGroup({
          mode: 'single',
          commands: [makeCommand({ id: 'c1' }), makeCommand({ id: 'c2' })],
        }),
      ]);
      h.states.set('cmd:g1:c2', makeState({ status: 'running' }));
      await h.ipc.invoke('process:start', 'cmd:g1:c1');
      expect(h.calls).toEqual([
        'stop:cmd:g1:c2',
        'start:cmd:g1:c1',
        'broadcast',
      ]);
    });

    it('starts an action id without a single-mode sweep', async () => {
      const h = harness([makeGroup({ actions: [makeAction({ id: 'a1' })] })]);
      await h.ipc.invoke('process:start', 'act:g1:a1');
      expect(h.calls).toEqual(['start:act:g1:a1', 'broadcast']);
    });

    it('starts a command whose group is gone from the store', async () => {
      const h = harness();
      await h.ipc.invoke('process:start', 'cmd:ghost:c1');
      expect(h.calls).toContain('start:cmd:ghost:c1');
    });
  });

  describe('process:stop', () => {
    it('stops and broadcasts', async () => {
      const h = harness();
      await expect(h.ipc.invoke('process:stop', 'cmd:g1:c1')).resolves.toEqual({
        ok: true,
      });
      expect(h.calls).toEqual(['stop:cmd:g1:c1', 'broadcast']);
    });
  });

  describe('git', () => {
    it('reads branches through the group path', async () => {
      const h = harness([makeGroup({ path: '/repo' })]);
      await expect(h.ipc.invoke('git:listBranches', 'g1')).resolves.toEqual({
        ok: true,
        branches: ['/repo'],
      });
      await expect(h.ipc.invoke('git:currentBranch', 'g1')).resolves.toEqual({
        ok: true,
        branch: '/repo',
      });
    });

    it('reports a group that is not there', async () => {
      const h = harness();
      for (const channel of ['git:listBranches', 'git:currentBranch'])
        await expect(h.ipc.invoke(channel, 'ghost')).resolves.toEqual({
          ok: false,
          error: 'Group not found',
        });
      await expect(
        h.ipc.invoke('git:switchBranch', { groupId: 'ghost', branch: 'main' }),
      ).resolves.toEqual({ ok: false, error: 'Group not found' });
    });

    it('stops the running services, switches, then restarts them', async () => {
      const h = harness([
        makeGroup({
          commands: [makeCommand({ id: 'c1' }), makeCommand({ id: 'c2' })],
        }),
      ]);
      h.states.set('cmd:g1:c1', makeState({ status: 'running' }));
      await expect(
        h.ipc.invoke('git:switchBranch', { groupId: 'g1', branch: 'main' }),
      ).resolves.toEqual({ ok: true });
      expect(h.calls).toEqual([
        'stop:cmd:g1:c1',
        'switch:main',
        'start:cmd:g1:c1',
        'broadcast',
      ]);
      expect(h.groupErrors.get('g1')).toBeNull();
    });

    it('records the git error and leaves the services stopped', async () => {
      const h = harness([makeGroup({ commands: [makeCommand({ id: 'c1' })] })]);
      h.states.set('cmd:g1:c1', makeState({ status: 'running' }));
      h.failSwitch('local changes');
      await expect(
        h.ipc.invoke('git:switchBranch', { groupId: 'g1', branch: 'main' }),
      ).resolves.toMatchObject({ ok: false });
      expect(h.groupErrors.get('g1')).toBe('local changes');
      expect(h.calls).not.toContain('start:cmd:g1:c1');
    });

    it('falls back to a generic message when git gave none', async () => {
      const h = harness([makeGroup()]);
      h.clearSwitchError();
      await h.ipc.invoke('git:switchBranch', { groupId: 'g1', branch: 'main' });
      expect(h.groupErrors.get('g1')).toBe('Unknown git error');
    });
  });
});
