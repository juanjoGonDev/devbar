import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPreScriptRunner,
  type PreScriptProcessManager,
  type RunResult,
  type StepCompleteEvent,
} from '../src/pre-script-runner.js';
import {
  normalizeGroup,
  normalizePreStep,
  normalizePreScript,
} from '../src/groups-model.js';
import type {
  Action,
  Group,
  LogEntry,
  PreScript,
  PreStep,
  PreStepScriptRef,
} from '../src/domain-types.js';

// ─── Mock factory ───────────────────────────────────────────────────────────

type PidBehaviour = number | { code: number } | 'hang';
type MockState = { status: 'stopped' | 'running' | 'done' };
interface MockProcessEvents {
  log: [payload: { id: string; entry: LogEntry }];
  'action:done': [
    payload: {
      processId: string;
      code: number | null;
      group: Group;
      target: Action | PreScript;
    },
  ];
}

// The runner never reads `group`/`target` off the action:done event itself
// (it resolves both from the ref via configStore) — this is a placeholder
// satisfying the event payload shape only.
const PLACEHOLDER_GROUP = normalizeGroup({ id: 'placeholder', path: '/tmp' });
const PLACEHOLDER_SCRIPT = normalizePreScript({
  id: 'placeholder-script',
  name: 'Placeholder',
  command: 'true',
});

class MockProcessManager
  extends EventEmitter<MockProcessEvents>
  implements PreScriptProcessManager
{
  readonly _logs: Record<string, LogEntry[]> = {};
  private readonly states: Record<string, MockState> = {};
  readonly stop = vi.fn((pid: string): Promise<{ ok: boolean }> => {
    const state = this.states[pid];
    if (state?.status === 'running') {
      this.states[pid] = { status: 'stopped' };
      void Promise.resolve().then(() =>
        this.emit('action:done', {
          processId: pid,
          code: 143,
          group: PLACEHOLDER_GROUP,
          target: PLACEHOLDER_SCRIPT,
        }),
      );
    }
    return Promise.resolve({ ok: true });
  });

  constructor(private readonly pidBehaviours: Record<string, PidBehaviour>) {
    super();
  }

  pushLog(id: string, entry: LogEntry): void {
    const buffer = this._logs[id] ?? [];
    buffer.push(entry);
    this._logs[id] = buffer;
    this.emit('log', { id, entry });
  }

  getLogs(id: string): LogEntry[] {
    return this._logs[id] ?? [];
  }

  getState(id: string): MockState {
    return this.states[id] ?? { status: 'stopped' };
  }

  start(pid: string): { ok: boolean; error?: string } {
    const behaviour = this.pidBehaviours[pid];
    if (behaviour === undefined)
      return { ok: false, error: 'pid not configured' };
    if (behaviour === 'hang') {
      this.states[pid] = { status: 'running' };
      return { ok: true };
    }

    const code = typeof behaviour === 'number' ? behaviour : behaviour.code;
    this.states[pid] = { status: 'running' };
    void Promise.resolve().then(() => {
      this.emit('action:done', {
        processId: pid,
        code,
        group: PLACEHOLDER_GROUP,
        target: PLACEHOLDER_SCRIPT,
      });
      this.states[pid] = { status: 'done' };
    });
    return { ok: true };
  }
}

function makeMockPM(
  pidBehaviours: Record<string, PidBehaviour> = {},
): MockProcessManager {
  return new MockProcessManager(pidBehaviours);
}

/** A fake configStore over a fixed set of groups and a MUTABLE steps array
 * (mutate `.steps` directly — the runner re-reads it on every `run()`). */
function makeConfigStore(groups: Group[], steps: PreStep[] = []) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const state = { steps };
  return {
    getGroup: (id: string): Group | null => byId.get(id) ?? null,
    getPreSteps: (): PreStep[] => state.steps,
    setSteps: (next: PreStep[]): void => {
      state.steps = next;
    },
  };
}

function makeGroup(overrides: Partial<Group> & { id: string }): Group {
  return normalizeGroup(overrides);
}

interface ScriptInput {
  id: string;
  name: string;
  cmd?: string;
  timeoutMs?: number | null;
  confirm?: boolean;
  confirmSecs?: number | null;
  confirmOnTimeout?: 'confirm' | 'cancel';
}

function makeScript(input: ScriptInput): PreScript {
  return {
    id: input.id,
    name: input.name,
    command: input.cmd ?? 'echo ok',
    args: [],
    env: [],
    inheritGroupEnv: false,
    timeoutMs: input.timeoutMs ?? null,
    confirm: input.confirm ?? false,
    confirmSecs: input.confirmSecs ?? null,
    confirmOnTimeout: input.confirmOnTimeout ?? 'cancel',
  };
}

function makeStep(
  id: string,
  mode: 'parallel' | 'serial',
  refs: PreStepScriptRef[],
): PreStep {
  return normalizePreStep({ id, mode, scripts: refs });
}
function ref(groupId: string, scriptId: string): PreStepScriptRef {
  return { groupId, scriptId };
}

function expectFailed(
  result: RunResult,
): asserts result is Extract<RunResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected runner result to fail');
}

function expectSucceeded(
  result: RunResult,
): asserts result is Extract<RunResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`Expected runner success, got ${result.error}`);
}

function getAggregatorLines(pm: MockProcessManager): string[] {
  const aggregatorId = Object.keys(pm._logs).find((id) =>
    id.startsWith('pre-pipeline:'),
  );
  expect(aggregatorId).toBeTruthy();
  if (!aggregatorId) throw new Error('Expected aggregator log buffer');
  return pm._logs[aggregatorId].map((entry) => entry.line);
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  if (value == null) throw new Error('Expected value to be present');
  return value;
}

// A single-group, single-script fixture used by tests that only care about
// the pipeline mechanics, not about multi-group resolution.
const G1 = makeGroup({
  id: 'g1',
  name: 'My Group',
  path: '/tmp/test-group',
  preScripts: [makeScript({ id: 'sc1', name: 'A' })],
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createPreScriptRunner — run()', () => {
  it('returns ok:true immediately when the pipeline has no steps', async () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], []),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = await runner.run();
    expectSucceeded(res);
    expect(typeof res.runId).toBe('number');
  });

  it('returns already_running when called twice without cancel', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const firstRunPromise = runner.run();
    await Promise.resolve();
    const secondRes = await runner.run();
    expectFailed(secondRes);
    expect(secondRes.error).toBe('already_running');

    runner.cancel();
    await firstRunPromise;
  });

  it('full pipeline succeeds — 3 steps (parallel / serial / parallel)', async () => {
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1'), ref('g1', 'sc2')]),
      makeStep('s2', 'serial', [ref('g1', 'sc3'), ref('g1', 'sc4')]),
      makeStep('s3', 'parallel', [ref('g1', 'sc5')]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
        makeScript({ id: 'sc3', name: 'C' }),
        makeScript({ id: 'sc4', name: 'D' }),
        makeScript({ id: 'sc5', name: 'E' }),
      ],
    });

    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 0 },
      'pre:g1:sc3': { code: 0 },
      'pre:g1:sc4': { code: 0 },
      'pre:g1:sc5': { code: 0 },
    });
    const broadcast = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: broadcast,
      onError: vi.fn(),
    });

    const res = await runner.run();
    expectSucceeded(res);
    expect(res.runId).toBeTruthy();
    expect(broadcast.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('mid-pipeline failure aborts remaining steps', async () => {
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1')]),
      makeStep('s2', 'serial', [ref('g1', 'sc2')]),
      makeStep('s3', 'parallel', [ref('g1', 'sc3')]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
        makeScript({ id: 'sc3', name: 'C' }),
      ],
    });
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 1 },
      // sc3 intentionally not configured — if start() is called it errors
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expectFailed(res);
    expect(res.error).toContain('step_2');
  });

  it('parallel step partial failure surfaces as pipeline failure', async () => {
    const steps = [
      makeStep('s1', 'parallel', [
        ref('g1', 'sc1'),
        ref('g1', 'sc2'),
        ref('g1', 'sc3'),
      ]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
        makeScript({ id: 'sc3', name: 'C' }),
      ],
    });
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 1 },
      'pre:g1:sc3': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(false);
  });

  it('serial step aborts on first failure', async () => {
    const steps = [
      makeStep('s1', 'serial', [
        ref('g1', 'sc1'),
        ref('g1', 'sc2'),
        ref('g1', 'sc3'),
      ]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
        makeScript({ id: 'sc3', name: 'C' }),
      ],
    });
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 1 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(false);
    expect(pm.getLogs('pre:g1:sc2').length).toBe(0);
    expect(pm.getLogs('pre:g1:sc3').length).toBe(0);
  });

  it('aggregator log contains step boundary lines for completed steps', async () => {
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1')]),
      makeStep('s2', 'serial', [ref('g1', 'sc2')]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'X' }),
        makeScript({ id: 'sc2', name: 'Y' }),
      ],
    });
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Step 1/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Step 2/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Pipeline complete'))).toBe(true);
  });
});

describe('createPreScriptRunner — multi-group interleaving and cwd resolution', () => {
  // Threat-matrix case (Applicable): cwd authority — a script's cwd must
  // resolve from its OWN group even when a step mixes groups.
  it('a parallel step mixing two groups spawns each script with its OWN group cwd', async () => {
    const groupA = makeGroup({
      id: 'gA',
      path: '/repo/a',
      preScripts: [makeScript({ id: 'sca', name: 'A' })],
    });
    const groupB = makeGroup({
      id: 'gB',
      path: '/repo/b',
      preScripts: [makeScript({ id: 'scb', name: 'B' })],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('gA', 'sca'), ref('gB', 'scb')]),
    ];
    const pm = makeMockPM({
      'pre:gA:sca': { code: 0 },
      'pre:gB:scb': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([groupA, groupB], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Working directory: /repo/a'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('Working directory: /repo/b'))).toBe(
      true,
    );
  });

  it('cross-group interleaving executes steps strictly in list order', async () => {
    const groupA = makeGroup({
      id: 'gA',
      path: '/repo/a',
      preScripts: [
        makeScript({ id: 'a1', name: 'A1' }),
        makeScript({ id: 'a2', name: 'A2' }),
      ],
    });
    const groupB = makeGroup({
      id: 'gB',
      path: '/repo/b',
      preScripts: [makeScript({ id: 'b1', name: 'B1' })],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('gA', 'a1')]),
      makeStep('s2', 'parallel', [ref('gB', 'b1')]),
      makeStep('s3', 'parallel', [ref('gA', 'a2')]),
    ];
    const pm = makeMockPM({
      'pre:gA:a1': { code: 0 },
      'pre:gB:b1': { code: 0 },
      'pre:gA:a2': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([groupA, groupB], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const lines = getAggregatorLines(pm);
    // Step-boundary lines are a robust proxy for ordering: each step's
    // "starting" line can only appear after the previous step fully
    // resolved, regardless of which groups' scripts it references.
    const stepStarts = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('starting'))
      .map(({ i }) => i);
    expect(stepStarts).toHaveLength(3);
    expect(stepStarts[0]).toBeLessThan(stepStarts[1]);
    expect(stepStarts[1]).toBeLessThan(stepStarts[2]);
  });

  it('an empty group.path fails only that script, not the whole step', async () => {
    const brokenGroup = makeGroup({
      id: 'gBroken',
      path: '',
      preScripts: [makeScript({ id: 'sc1', name: 'Broken' })],
    });
    const okGroup = makeGroup({
      id: 'gOk',
      path: '/repo/ok',
      preScripts: [makeScript({ id: 'sc2', name: 'Ok' })],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('gBroken', 'sc1'), ref('gOk', 'sc2')]),
    ];
    const pm = makeMockPM({ 'pre:gOk:sc2': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([brokenGroup, okGroup], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    // The step fails overall (one sibling failed), but the sibling with a
    // configured path DID run — the pipeline did not abort up-front.
    expect(res.ok).toBe(false);
    expect(pm.getState('pre:gOk:sc2').status).toBe('done');
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('has no configured path'))).toBe(true);
  });

  it('an unresolvable ref (deleted group) is skipped with a warning, not a failure', async () => {
    const okGroup = makeGroup({
      id: 'gOk',
      path: '/repo/ok',
      preScripts: [makeScript({ id: 'sc1', name: 'Ok' })],
    });
    const steps = [
      makeStep('s1', 'parallel', [
        ref('ghost-group', 'ghost-script'),
        ref('gOk', 'sc1'),
      ]),
    ];
    const pm = makeMockPM({ 'pre:gOk:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([okGroup], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Broken reference'))).toBe(true);
  });
});

describe('createPreScriptRunner — onStepComplete hook', () => {
  it('fires once per successfully-completed step, strictly ascending', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
      ],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1')]),
      makeStep('s2', 'parallel', [ref('g1', 'sc2')]),
    ];
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 0 },
    });
    const events: StepCompleteEvent[] = [];
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      onStepComplete: (event) => events.push(event),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]?.stepIndex).toBe(0);
    expect(events[0]?.stepId).toBe('s1');
    expect(events[1]?.stepIndex).toBe(1);
    expect(events[1]?.stepId).toBe('s2');
    expect(events[0]?.totalSteps).toBe(2);
    if (!res.ok) throw new Error('unreachable');
    expect(events[0]?.runId).toBe(res.runId);
  });

  it('does not fire for a step that fails, and never fires after run() resolves', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
      ],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1')]),
      makeStep('s2', 'parallel', [ref('g1', 'sc2')]), // fails
    ];
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 1 },
    });
    const events: StepCompleteEvent[] = [];
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      onStepComplete: (event) => events.push(event),
    });

    const res = await runner.run();
    expect(res.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.stepIndex).toBe(0);
  });

  it('a throwing callback is caught and logged without aborting the run', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
      ],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1')]),
      makeStep('s2', 'parallel', [ref('g1', 'sc2')]),
    ];
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      onStepComplete: () => {
        throw new Error('boom');
      },
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('onStepComplete failed: boom'))).toBe(
      true,
    );
  });
});

describe('createPreScriptRunner — cancel()', () => {
  it('returns not_running when no pipeline is active', () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], []),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = runner.cancel();
    expect(res).toEqual({ ok: false, error: 'not_running' });
  });

  it('cancel during parallel step: resolves pipeline as cancelled', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A', cmd: 'sleep 9999' }),
        makeScript({ id: 'sc2', name: 'B', cmd: 'sleep 9999' }),
      ],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1'), ref('g1', 'sc2')]),
    ];
    const pm = makeMockPM({ 'pre:g1:sc1': 'hang', 'pre:g1:sc2': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run();
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel();
    const res = await runPromise;
    expectFailed(res);
    expect(res.error).toBe('cancelled');
  });

  it('cancel during serial step: resolves as cancelled', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A', cmd: 'sleep 9999' }),
        makeScript({ id: 'sc2', name: 'B', cmd: 'sleep 9999' }),
      ],
    });
    const steps = [
      makeStep('s1', 'serial', [ref('g1', 'sc1'), ref('g1', 'sc2')]),
    ];
    const pm = makeMockPM({ 'pre:g1:sc1': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run();
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel();
    const res = await runPromise;
    expectFailed(res);
    expect(res.error).toBe('cancelled');
  });
});

describe('createPreScriptRunner — timeout enforcement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('script exceeds timeoutMs: resolves ok:false, aggregator contains "timed out", no "failed (exit" line, stop called once', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'Slow', timeoutMs: 5000 })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(5001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const res = await runPromise;
    expect(res.ok).toBe(false);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('timed out'))).toBe(true);
    expect(lines.some((l) => l.includes('failed (exit'))).toBe(false);
    expect(pm.stop.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('script completes before timeout: resolves ok:true, no "timed out" line, stop not called from timeout path', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'Fast', timeoutMs: 10000 })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('timed out'))).toBe(false);
    const stopCalls = pm.stop.mock.calls.filter(
      (args) => args[0] === 'pre:g1:sc1',
    );
    expect(stopCalls.length).toBe(0);
  });

  it('simultaneous completion and timeout boundary: stop called at most once per pid', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'Race', timeoutMs: 5000 })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    const stopCalls = pm.stop.mock.calls.filter(
      (args) => args[0] === 'pre:g1:sc1',
    );
    expect(stopCalls.length).toBe(0);
  });
});

describe('createPreScriptRunner — duration markers', () => {
  it('"Pipeline complete (Xs)" present in aggregator', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const lines = getAggregatorLines(pm);
    expect(
      lines.some(
        (l) => l.includes('Pipeline complete') && l.match(/\(\d+\w+.*\)/),
      ),
    ).toBe(true);
  });

  it('"Step 1 completed (Xs)" present after step success', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Step 1 completed'))).toBe(true);
  });

  it('"Script finished ok (Xs)" contains no bare "exit N"', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const lines = getAggregatorLines(pm);
    const finishedLine = lines.find((l) => l.includes('finished ok'));
    expect(finishedLine).toBeTruthy();
    expect(finishedLine).not.toMatch(/finished ok \(exit \d+\)/);
    expect(finishedLine).toMatch(/finished ok \(\d+\w+.*\)/);
  });

  it('failed script keeps "failed (exit N, Xs)" shape', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 1 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const lines = getAggregatorLines(pm);
    const failedLine = lines.find((l) => l.includes('failed (exit'));
    expect(failedLine).toBeTruthy();
    expect(failedLine).toMatch(/failed \(exit 1,/);
  });
});

describe('createPreScriptRunner — getRunState / getRecentResult', () => {
  it('getRunState returns null when idle', () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], []),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    expect(runner.getRunState()).toBeNull();
  });

  it('getRecentResult returns null when no recent run', () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], []),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    expect(runner.getRecentResult()).toBeNull();
  });

  it('getRecentResult returns done after successful pipeline', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    expect(runner.getRunState()).toBeNull();
    const recent = expectPresent(runner.getRecentResult());
    expect(recent.status).toBe('done');
  });

  it('getRecentResult returns error after failed pipeline', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 1 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const recent = expectPresent(runner.getRecentResult());
    expect(recent.status).toBe('error');
  });
});

describe('createPreScriptRunner — confirmation gate', () => {
  it('R2.1: confirm:false → confirmScript never called, start runs normally', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'A', confirm: false })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const confirmScript = vi.fn().mockResolvedValue(true);
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    expect(confirmScript).not.toHaveBeenCalled();
  });

  it('R2.2: confirm:true + confirmScript resolves true → start is called, pipeline succeeds', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'A', confirm: true })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const confirmScript = vi.fn().mockResolvedValue(true);
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    expect(confirmScript).toHaveBeenCalledTimes(1);
    expect(pm.getState('pre:g1:sc1').status).toBe('done');
  });

  it('R2.3: confirm:true + confirmScript resolves false → declined (cancelled, NOT a failure), start never called, no onError', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'A', confirm: true })],
    });
    const steps = [makeStep('s1', 'serial', [ref('g1', 'sc1')])];
    // sc1 intentionally not configured in pm — if start() were called it
    // would error.
    const pm = makeMockPM({});
    const confirmScript = vi.fn().mockResolvedValue(false);
    const onError = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError,
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run();
    expectFailed(res);
    expect(res.cancelled).toBe(true);
    expect(res.error).toBe('cancelled');
    expect(onError).not.toHaveBeenCalled();
    expect(confirmScript).toHaveBeenCalledTimes(1);
    expect(pm.getLogs('pre:g1:sc1').length).toBe(0);
    const rr = runner.getRecentResult();
    expect(rr == null || rr.status !== 'error').toBe(true);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('cancelado por el usuario'))).toBe(
      true,
    );
  });

  it('R2.4: no confirmScript dep injected → fail-safe declined (cancelled, not failure), start never called', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'A', confirm: true })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const onError = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError,
    });

    const res = await runner.run();
    expectFailed(res);
    expect(res.cancelled).toBe(true);
    expect(res.error).toBe('cancelled');
    expect(onError).not.toHaveBeenCalled();
    expect(pm.getLogs('pre:g1:sc1').length).toBe(0);
  });

  it('R2.7: a real script failure (exit≠0) stays a failure — NOT cancelled — and calls onError', async () => {
    const steps = [makeStep('s1', 'serial', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 1 } });
    const onError =
      vi.fn<
        (
          error: string,
          context: { runId?: number; failedStepIndex?: number },
        ) => void
      >();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError,
    });

    const res = await runner.run();
    expectFailed(res);
    expect(res.cancelled).toBeFalsy();
    expect(res.error).toBe('step_1_failed');
    expect(onError).toHaveBeenCalledTimes(1);
    const [errorArg, contextArg] = onError.mock.calls[0] ?? [];
    expect(errorArg).toBe('step_1_failed');
    expect(typeof contextArg?.runId).toBe('number');
    expect(contextArg?.failedStepIndex).toBe(1);
  });

  it('R2.5: parallel step with 2 confirm:true scripts → confirmScript called once per script', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A', confirm: true }),
        makeScript({ id: 'sc2', name: 'B', confirm: true }),
      ],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1'), ref('g1', 'sc2')]),
    ];
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 0 },
      'pre:g1:sc2': { code: 0 },
    });
    const confirmScript = vi.fn().mockResolvedValue(true);
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run();
    expect(res.ok).toBe(true);
    expect(confirmScript).toHaveBeenCalledTimes(2);
  });

  it('R2.6: cancel() while awaiting confirmScript → cancelConfirm called, pipeline resolves cancelled', async () => {
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'A', confirm: true })],
    });
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({});
    let pendingResolve: ((value: boolean) => void) | null = null;
    const confirmScript = vi.fn(
      (
        _script: PreScript,
        _group: Group | null,
        _groupId: string,
      ): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          pendingResolve = resolve;
        }),
    );
    const cancelConfirm = vi.fn(() => {
      pendingResolve?.(false);
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm,
    });

    const runPromise = runner.run();
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel();
    const res = await runPromise;
    expectFailed(res);
    expect(res.error).toBe('cancelled');
    expect(cancelConfirm).toHaveBeenCalledWith();
  });
});
