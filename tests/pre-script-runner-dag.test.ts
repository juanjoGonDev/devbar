import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createPreScriptRunner,
  type BlockCompleteEvent,
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
import { block, graph } from './helpers/pipeline.js';

/**
 * `src/pre-script-runner.ts` — the DAG scheduling: a block starts as soon as
 * EVERY one of its sources finished successfully, a failure skips only the
 * failed block's descendants, and progress is counted in scripts.
 *
 * Every script here "hangs" until the test finishes it by hand, so the test
 * decides the order things complete in and can look at what has started in
 * between.
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
  readonly logs: Record<string, LogEntry[]> = {};
  readonly stop = vi.fn((processId: string) => {
    this.finish(processId, 143);
    return Promise.resolve({ ok: true });
  });

  pushLog(id: string, entry: LogEntry): void {
    (this.logs[id] ??= []).push(entry);
  }

  start(processId: string): { ok: boolean } {
    this.started.push(processId);
    return { ok: true };
  }

  finish(processId: string, code: number): void {
    this.emit('action:done', {
      processId,
      code,
      group: normalizeGroup({ id: GROUP_ID }),
      target: normalizePreScript({ id: 'x', name: 'x', command: 'x' }),
    });
  }

  startedScripts(): string[] {
    return this.started.map((id) => id.split(':')[2] ?? id);
  }
}

/** Lets every pending microtask (the runner's `then` chains) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(pipeline: Pipeline, scriptIds: readonly string[]) {
  const group = normalizeGroup({
    id: GROUP_ID,
    name: 'G',
    path: '/tmp/g',
    preScripts: scriptIds.map((id) => ({ id, name: id, command: 'true' })),
  });
  const pm = new ManualProcessManager();
  const completed: BlockCompleteEvent[] = [];
  const onError = vi.fn();
  const onSuccess = vi.fn();
  const runner = createPreScriptRunner({
    processManager: pm,
    configStore: {
      getGroup: (id) => (id === GROUP_ID ? group : null),
      getPipeline: () => pipeline,
    },
    broadcastUpdate: vi.fn(),
    onBlockComplete: (event) => completed.push(event),
    onError,
    onSuccess,
  });
  const finish = async (scriptId: string, code = 0): Promise<void> => {
    pm.finish(pid(scriptId), code);
    await settle();
  };
  return { pm, runner, completed, onError, onSuccess, finish };
}

/** trigger→[A,B]→C; C→D→E; C→F→G. */
const BRANCHING = graph(
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  ['trigger>A', 'trigger>B', 'A>C', 'B>C', 'C>D', 'D>E', 'C>F', 'F>G'],
);
const BRANCHING_SCRIPTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

describe('src/pre-script-runner.ts — DAG scheduling', () => {
  it('runs each branch as soon as its own sources are done', async () => {
    const { pm, runner, finish } = setup(BRANCHING, BRANCHING_SCRIPTS);
    const run = runner.run();
    await settle();
    expect(pm.startedScripts()).toEqual(['A', 'B']);

    // C waits for BOTH A and B.
    await finish('A');
    expect(pm.startedScripts()).toEqual(['A', 'B']);
    await finish('B');
    expect(pm.startedScripts()).toEqual(['A', 'B', 'C']);

    await finish('C');
    expect(pm.startedScripts()).toEqual(['A', 'B', 'C', 'D', 'F']);

    // E starts the moment D is done, without waiting for F...
    await finish('D');
    expect(pm.startedScripts()).toContain('E');
    expect(pm.startedScripts()).not.toContain('G');
    // ...and G the moment F is done, without waiting for E.
    await finish('F');
    expect(pm.startedScripts()).toContain('G');

    await finish('E');
    await finish('G');
    expect((await run).ok).toBe(true);
  });

  it('runs a parallel frame’s scripts together and waits for all of them', async () => {
    const pipeline = graph([block('F', ['x', 'y']), 'N'], ['trigger>F', 'F>N']);
    const { pm, runner, finish } = setup(pipeline, ['x', 'y', 'N']);
    const run = runner.run();
    await settle();
    expect(pm.startedScripts()).toEqual(['x', 'y']);
    await finish('x');
    expect(pm.startedScripts()).not.toContain('N');
    await finish('y');
    expect(pm.startedScripts()).toContain('N');
    await finish('N');
    expect((await run).ok).toBe(true);
  });

  it('never runs a disconnected block', async () => {
    const pipeline = graph(['A', 'X'], ['trigger>A']);
    const { pm, runner, finish } = setup(pipeline, ['A', 'X']);
    const run = runner.run();
    await settle();
    await finish('A');
    expect((await run).ok).toBe(true);
    expect(pm.startedScripts()).toEqual(['A']);
  });

  it('succeeds at once when no block is connected', async () => {
    const { pm, runner } = setup(graph(['X'], []), ['X']);
    expect((await runner.run()).ok).toBe(true);
    expect(pm.started).toEqual([]);
  });

  it('skips the descendants of a failed block and keeps independent branches running', async () => {
    const { pm, runner, onError, finish } = setup(BRANCHING, BRANCHING_SCRIPTS);
    const run = runner.run();
    await settle();
    await finish('A');
    await finish('B');
    await finish('C');
    await finish('D', 1);
    // E is skipped; the F branch is untouched.
    await finish('F');
    expect(pm.startedScripts()).toContain('G');
    await finish('G');

    const result = await run;
    expect(result).toMatchObject({ ok: false, error: 'scripts_failed:1' });
    expect(pm.startedScripts()).not.toContain('E');
    expect(onError).toHaveBeenCalledWith(
      'scripts_failed:1',
      expect.objectContaining({ failedScripts: 1 }),
    );
  });

  it('fires onBlockComplete for every block that succeeded, never for a failed one', async () => {
    const pipeline = graph(['A', 'B', 'C'], ['trigger>A', 'trigger>B', 'B>C']);
    const { runner, completed, finish } = setup(pipeline, ['A', 'B', 'C']);
    const run = runner.run();
    await settle();
    await finish('B');
    await finish('A', 1);
    await finish('C');
    await run;
    expect(completed.map((event) => event.blockId)).toEqual(['B', 'C']);
  });

  it('reports progress in scripts, counting skipped ones as settled', async () => {
    const pipeline = graph(
      [block('A', ['a1', 'a2']), 'B', 'X'],
      ['trigger>A', 'A>B'],
    );
    const { runner, finish } = setup(pipeline, ['a1', 'a2', 'B', 'X']);
    const run = runner.run();
    await settle();
    expect(runner.getSnapshot()).toMatchObject({
      doneScripts: 0,
      totalScripts: 3,
    });
    await finish('a1');
    expect(runner.getSnapshot()?.doneScripts).toBe(1);
    await finish('a2', 1);
    await run;
    expect(runner.isRunning()).toBe(false);
    expect(runner.getSnapshot()).toMatchObject({
      status: 'error',
      doneScripts: 3,
    });
  });

  it('treats a declined confirmation as a cancellation that skips only its descendants', async () => {
    const pipeline = graph(['A', 'B', 'C'], ['trigger>A', 'trigger>B', 'A>C']);
    const group = normalizeGroup({
      id: GROUP_ID,
      path: '/tmp/g',
      preScripts: [
        { id: 'A', name: 'A', command: 'true', confirm: true },
        { id: 'B', name: 'B', command: 'true' },
        { id: 'C', name: 'C', command: 'true' },
      ],
    });
    const pm = new ManualProcessManager();
    const onError = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: {
        getGroup: () => group,
        getPipeline: () => pipeline,
      },
      broadcastUpdate: vi.fn(),
      onError,
      confirmScript: () => Promise.resolve(false),
    });
    const run = runner.run();
    await settle();
    expect(pm.startedScripts()).toEqual(['B']);
    pm.finish(pid('B'), 0);
    const result = await run;
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(pm.startedScripts()).toEqual(['B']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops scheduling once cancelled', async () => {
    const { pm, runner, finish } = setup(BRANCHING, BRANCHING_SCRIPTS);
    const run = runner.run();
    await settle();
    runner.cancel();
    await settle();
    await finish('A');
    const result = await run;
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(pm.startedScripts()).toEqual(['A', 'B']);
  });

  it('narrates each block by its place in the run, never by script names', async () => {
    const pipeline = graph([block('F', ['x', 'y'])], ['trigger>F']);
    const { pm, runner, finish } = setup(pipeline, ['x', 'y']);
    const run = runner.run();
    await settle();
    await finish('x');
    await finish('y');
    await run;
    const aggregator = Object.keys(pm.logs).find((id) =>
      id.startsWith('pre-pipeline:'),
    );
    const lines = (pm.logs[aggregator ?? ''] ?? []).map((e) => e.line);
    expect(lines[0]).toBe('── Workflow iniciado (2 scripts) ──');
    expect(lines).toContain('── Bloque 1/1 iniciando (2 scripts) ──');
    expect(lines.some((l) => l.startsWith('── Bloque 1/1 completado ('))).toBe(
      true,
    );
  });
});
