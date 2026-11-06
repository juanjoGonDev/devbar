import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createPreScriptRunner,
  type PreScriptProcessManager,
} from '../src/pre-script-runner.js';
import { normalizeGroup, normalizePreScript } from '../src/groups-model.js';
import type {
  Action,
  Group,
  LogEntry,
  Pipeline,
  PreScript,
} from '../src/domain-types.js';
import type { WorkflowRunState } from '../src/ipc-contract.js';
import { block, graph, ref } from './helpers/pipeline.js';

/**
 * `src/pre-script-runner.ts` — what one workflow run reports and does beyond
 * the DAG order (see pre-script-runner-dag.test.ts): per-block and per-script
 * statuses, «Todos OK» (`requireAll`), output warnings, per-run script logs
 * and retrying from a block.
 *
 * Every script "hangs" until the test finishes it by hand.
 */

interface DoneEvent {
  processId: string;
  code: number | null;
  group: Group;
  target: Action | PreScript;
}

const GROUP_ID = 'g';
const pid = (scriptId: string): string => `pre:${GROUP_ID}:${scriptId}`;

class ManualProcessManager
  extends EventEmitter<{
    log: [payload: { id: string; entry: LogEntry }];
    'action:done': [payload: DoneEvent];
  }>
  implements PreScriptProcessManager
{
  readonly started: string[] = [];
  readonly running = new Set<string>();
  readonly stop = vi.fn((processId: string) => {
    this.finish(processId, 143);
    return Promise.resolve({ ok: true });
  });

  pushLog(id: string, entry: LogEntry): void {
    this.emit('log', { id, entry });
  }

  start(processId: string): { ok: boolean } {
    this.started.push(processId);
    this.running.add(processId);
    return { ok: true };
  }

  print(scriptId: string, line: string): void {
    this.pushLog(pid(scriptId), {
      ts: Date.now(),
      stream: 'stdout',
      level: null,
      line,
    });
  }

  finish(processId: string, code: number): void {
    if (!this.running.delete(processId)) return;
    this.emit('action:done', {
      processId,
      code,
      group: normalizeGroup({ id: GROUP_ID }),
      target: normalizePreScript({ id: 'x', name: 'x', command: 'x' }),
    });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(pipeline: Pipeline, scriptIds: readonly string[]) {
  const group = normalizeGroup({
    id: GROUP_ID,
    name: 'G',
    path: '/tmp/g',
    commands: [{ name: 'dev', command: 'pnpm dev', warnRegex: 'deprecated' }],
    preScripts: scriptIds.map((id) => ({ id, name: id, command: 'true' })),
  });
  const pm = new ManualProcessManager();
  let current = pipeline;
  const onFinish = vi.fn<(state: WorkflowRunState) => void>();
  let nextId = 100;
  const runner = createPreScriptRunner({
    processManager: pm,
    configStore: {
      getGroup: (id) => (id === GROUP_ID ? group : null),
      getPipeline: () => current,
    },
    workflowId: 'w1',
    nextRunId: () => ++nextId,
    broadcastUpdate: vi.fn(),
    onFinish,
  });
  const finish = async (scriptId: string, code = 0): Promise<void> => {
    pm.finish(pid(scriptId), code);
    await settle();
  };
  const blockStatus = (id: string) =>
    runner.getSnapshot()?.blocks.find((b) => b.blockId === id)?.status;
  const scriptStatus = (id: string) =>
    runner.getSnapshot()?.scripts.find((s) => s.scriptId === id)?.status;
  return {
    pm,
    runner,
    finish,
    onFinish,
    blockStatus,
    scriptStatus,
    setGraph: (next: Pipeline) => {
      current = next;
    },
  };
}

const CHAIN = graph(['A', 'B'], ['trigger>A', 'A>B']);
const FRAME = graph([block('F', ['x', 'y']), 'C'], ['trigger>F', 'F>C']);
const SOFT_FRAME = graph(
  [block('F', ['x', 'y'], 0, 0, false), 'C'],
  ['trigger>F', 'F>C'],
);

describe('src/pre-script-runner.ts — workflow runs', () => {
  describe('statuses', () => {
    it('reports waiting, running and success per block and per script', async () => {
      const { runner, finish, blockStatus, scriptStatus } = setup(CHAIN, [
        'A',
        'B',
      ]);
      const run = runner.run();
      await settle();
      expect(runner.getSnapshot()).toMatchObject({
        workflowId: 'w1',
        runId: 101,
        status: 'running',
        doneScripts: 0,
        totalScripts: 2,
      });
      expect([blockStatus('A'), blockStatus('B')]).toEqual([
        'running',
        'waiting',
      ]);
      expect([scriptStatus('A'), scriptStatus('B')]).toEqual([
        'running',
        'waiting',
      ]);
      await finish('A');
      await finish('B');
      await run;
      expect(runner.getSnapshot()).toMatchObject({
        status: 'success',
        doneScripts: 2,
      });
      expect(runner.getSnapshot()?.finishedAt).not.toBeNull();
      expect([blockStatus('A'), blockStatus('B')]).toEqual([
        'success',
        'success',
      ]);
    });

    it('marks a failed block error and its descendants skipped', async () => {
      const { runner, finish, blockStatus, scriptStatus, onFinish } = setup(
        CHAIN,
        ['A', 'B'],
      );
      const run = runner.run();
      await settle();
      await finish('A', 1);
      await run;
      expect([blockStatus('A'), blockStatus('B')]).toEqual([
        'error',
        'skipped',
      ]);
      expect(scriptStatus('B')).toBe('skipped');
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      );
    });

    it('marks what was running or waiting cancelled on stop', async () => {
      const { runner, blockStatus } = setup(CHAIN, ['A', 'B']);
      const run = runner.run();
      await settle();
      runner.cancel();
      await run;
      expect(runner.getSnapshot()?.status).toBe('cancelled');
      expect([blockStatus('A'), blockStatus('B')]).toEqual([
        'cancelled',
        'cancelled',
      ]);
    });

    it('leaves a disconnected block idle', async () => {
      const { runner, finish, blockStatus } = setup(
        graph(['A', 'Z'], ['trigger>A']),
        ['A', 'Z'],
      );
      const run = runner.run();
      await settle();
      await finish('A');
      await run;
      expect(blockStatus('Z')).toBe('idle');
    });
  });

  describe('«Todos OK»', () => {
    it('on: one failing script cancels its running sibling and fails the block', async () => {
      const { pm, runner, finish, blockStatus, scriptStatus } = setup(FRAME, [
        'x',
        'y',
        'C',
      ]);
      const run = runner.run();
      await settle();
      await finish('x', 2);
      await run;
      expect(pm.stop).toHaveBeenCalledWith(pid('y'));
      expect([scriptStatus('x'), scriptStatus('y')]).toEqual([
        'error',
        'cancelled',
      ]);
      expect([blockStatus('F'), blockStatus('C')]).toEqual([
        'error',
        'skipped',
      ]);
      expect(runner.getSnapshot()?.status).toBe('error');
    });

    it('off: the sibling keeps running and the block lets the next one start', async () => {
      const { pm, runner, finish, blockStatus, scriptStatus } = setup(
        SOFT_FRAME,
        ['x', 'y', 'C'],
      );
      const run = runner.run();
      await settle();
      await finish('x', 2);
      expect(pm.stop).not.toHaveBeenCalled();
      expect(scriptStatus('y')).toBe('running');
      await finish('y');
      expect(blockStatus('F')).toBe('warning');
      expect(pm.started).toContain(pid('C'));
      await finish('C');
      const result = await run;
      expect(result.ok).toBe(true);
      expect(scriptStatus('x')).toBe('error');
      expect(runner.getSnapshot()?.status).toBe('warning');
    });
  });

  describe('warnings', () => {
    it('a clean exit whose output matched the group warn pattern is a warning', async () => {
      const { pm, runner, finish, scriptStatus, blockStatus } = setup(
        graph(['A'], ['trigger>A']),
        ['A'],
      );
      const run = runner.run();
      await settle();
      pm.print('A', 'this API is DEPRECATED');
      await finish('A');
      await run;
      expect(scriptStatus('A')).toBe('warning');
      expect(blockStatus('A')).toBe('warning');
      expect(runner.getSnapshot()?.status).toBe('warning');
    });
  });

  describe('script logs', () => {
    it('keeps each script’s own output for the run', async () => {
      const { pm, runner, finish } = setup(graph(['A'], ['trigger>A']), ['A']);
      const run = runner.run();
      await settle();
      pm.print('A', 'hello');
      await finish('A');
      await run;
      const lines = runner
        .scriptLog('latest', ref('A'))
        ?.map((entry) => entry.line);
      expect(lines).toContain('hello');
      expect(runner.scriptLog(101, ref('A'))).not.toBeNull();
      expect(runner.scriptLog(999, ref('A'))).toBeNull();
      expect(runner.scriptLog('latest', ref('nope'))).toBeNull();
    });
  });

  describe('retryFrom', () => {
    const DIAMOND = graph(
      ['A', 'B', 'C', 'D'],
      ['trigger>A', 'A>B', 'A>C', 'B>D', 'C>D'],
    );

    it('re-runs the block and its unfinished descendants, keeping the successful ones', async () => {
      const { pm, runner, finish, blockStatus } = setup(DIAMOND, [
        'A',
        'B',
        'C',
        'D',
      ]);
      const first = runner.run();
      await settle();
      await finish('A');
      await finish('C');
      await finish('B', 1);
      await first;
      expect(blockStatus('D')).toBe('skipped');

      pm.started.length = 0;
      const retry = runner.retryFrom('B');
      await settle();
      expect(pm.started).toEqual([pid('B')]);
      expect(runner.getSnapshot()).toMatchObject({
        runId: 102,
        status: 'running',
        doneScripts: 2,
      });
      expect([blockStatus('A'), blockStatus('C')]).toEqual([
        'success',
        'success',
      ]);
      await finish('B');
      await finish('D');
      expect(await retry).toEqual({ ok: true, runId: 102 });
      expect(pm.started).toEqual([pid('B'), pid('D')]);
      expect(runner.getSnapshot()?.status).toBe('success');
    });

    it('refuses while running, before any run, and for a block that cannot start', async () => {
      const { runner, finish } = setup(DIAMOND, ['A', 'B', 'C', 'D']);
      expect(await runner.retryFrom('A')).toEqual({
        ok: false,
        error: 'no_run',
      });
      const first = runner.run();
      await settle();
      expect(await runner.retryFrom('A')).toEqual({
        ok: false,
        error: 'already_running',
      });
      await finish('A', 1);
      await first;
      expect(await runner.retryFrom('D')).toEqual({
        ok: false,
        error: 'not_ready',
      });
      expect(await runner.retryFrom('ghost')).toEqual({
        ok: false,
        error: 'unknown_block',
      });
    });
  });
});
