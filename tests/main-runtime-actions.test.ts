import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeActions,
  type RuntimeActionsDeps,
} from '../src/main/runtime-actions.js';
import type { Group, ProcessState } from '../src/domain-types.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeState,
} from './helpers/main-fakes.js';

/**
 * The runtime actions shared by the IPC handlers and «Control remoto». The
 * IPC suite (tests/main-ipc-runtime.test.ts) pins each action's behaviour
 * through its channel; this one covers what only a non-IPC caller needs.
 */

function harness(groups: Group[]) {
  const calls: string[] = [];
  const states = new Map<string, ProcessState>();
  const deps: RuntimeActionsDeps = {
    configStore: {
      getGroup: (id) => groups.find((g) => g.id === id) ?? null,
      listGroups: () => groups,
    },
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
    },
    gitManager: {
      listBranches: () => Promise.resolve({ ok: true, branches: [] }),
      currentBranch: () => Promise.resolve({ ok: true, branch: 'main' }),
      switchBranch: () => Promise.resolve({ ok: true }),
      refreshRemotes: () => Promise.resolve({ changed: false }),
    },
    confirms: {
      confirmIfNeeded: vi.fn<() => Promise<boolean>>(() =>
        Promise.resolve(true),
      ),
    },
    groupErrors: new Map(),
    broadcast: () => calls.push('broadcast'),
    branchesChanged: vi.fn(),
  };
  return { runtime: createRuntimeActions(deps), calls, states };
}

const guarded = makeGroup({
  id: 'g1',
  commands: [
    makeCommand({ id: 'web', confirm: true }),
    makeCommand({ id: 'api' }),
  ],
  actions: [
    makeAction({ id: 'seed', confirm: true }),
    makeAction({ id: 'lint' }),
  ],
});

describe('src/main/runtime-actions.ts', () => {
  describe('needsConfirm', () => {
    it('is true for a command or an action that asks before starting', () => {
      const { runtime } = harness([guarded]);

      expect(runtime.needsConfirm('cmd:g1:web')).toBe(true);
      expect(runtime.needsConfirm('act:g1:seed')).toBe(true);
    });

    it('is false for one that starts straight away', () => {
      const { runtime } = harness([guarded]);

      expect(runtime.needsConfirm('cmd:g1:api')).toBe(false);
      expect(runtime.needsConfirm('act:g1:lint')).toBe(false);
    });

    it('is false for anything it cannot find', () => {
      const { runtime } = harness([guarded]);

      expect(runtime.needsConfirm('cmd:g1:nope')).toBe(false);
      expect(runtime.needsConfirm('cmd:nope:web')).toBe(false);
      expect(runtime.needsConfirm('pre:g1:s1')).toBe(false);
      expect(runtime.needsConfirm('garbage')).toBe(false);
    });
  });

  describe('stopAll', () => {
    it('stops every running command and leaves the rest alone', async () => {
      const { runtime, calls, states } = harness([guarded]);
      states.set('cmd:g1:web', makeState({ status: 'running' }));

      const result = await runtime.stopAll();

      expect(result).toEqual({ ok: true, stopped: 1 });
      expect(calls).toEqual(['stop:cmd:g1:web', 'broadcast']);
    });
  });

  describe('runPipeline', () => {
    it('starts the one global pipeline', async () => {
      const { runtime, calls } = harness([guarded]);

      await runtime.runPipeline();

      expect(calls).toEqual(['run']);
    });
  });
});
