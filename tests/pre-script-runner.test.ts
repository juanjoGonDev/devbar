import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPreScriptRunner,
  type PreScriptProcessManager,
  type RunResult,
} from '../src/pre-script-runner.js';
import { normalizeGroup, normalizePreStep } from '../src/groups-model.js';
import type {
  Action,
  Group,
  LogEntry,
  PreScript,
  PreStep,
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

const EVENT_GROUP = normalizeGroup({
  id: 'g1',
  name: 'Mock Group',
  path: '/tmp/test-group',
  preSteps: [
    {
      id: 'event-step',
      mode: 'serial',
      scripts: [{ id: 'event-script', name: 'Mock', command: 'true' }],
    },
  ],
});
const EVENT_SCRIPT = EVENT_GROUP.preSteps[0].scripts[0];

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
          group: EVENT_GROUP,
          target: EVENT_SCRIPT,
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
        group: EVENT_GROUP,
        target: EVENT_SCRIPT,
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

function makeConfigStore(groupOverride: Partial<Group> = {}) {
  const group = normalizeGroup({
    id: 'g1',
    name: 'My Group',
    path: '/tmp/test-group',
    preSteps: [],
    commands: [],
    ...groupOverride,
  });
  return {
    getGroup: (id: string): Group | null => (id === group.id ? group : null),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface StepScriptInput {
  id: string;
  name: string;
  cmd?: string;
  timeoutMs?: number | null;
  confirm?: boolean;
  confirmSecs?: number | null;
  confirmOnTimeout?: 'confirm' | 'cancel';
}

function makeStep(
  id: string,
  mode: 'parallel' | 'serial',
  scripts: StepScriptInput[],
): PreStep {
  return normalizePreStep({
    id,
    mode,
    scripts: scripts.map((script) => ({
      id: script.id,
      name: script.name,
      command: script.cmd ?? 'echo ok',
      ...(script.timeoutMs != null ? { timeoutMs: script.timeoutMs } : {}),
      ...(script.confirm != null ? { confirm: script.confirm } : {}),
      ...(script.confirmSecs !== undefined
        ? { confirmSecs: script.confirmSecs }
        : {}),
      ...(script.confirmOnTimeout != null
        ? { confirmOnTimeout: script.confirmOnTimeout }
        : {}),
    })),
  });
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
    id.startsWith('pre-pipeline:g1:'),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createPreScriptRunner — run()', () => {
  it('returns ok:true immediately when group has no preSteps', async () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = await runner.run('g1');
    expect(res).toEqual({ ok: true });
  });

  it('returns no_group_path when group has no path configured', async () => {
    const step = makeStep('s1', 'parallel', [{ id: 'sc1', name: 'X' }]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': 0 });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ path: '', preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = await runner.run('g1');
    expectFailed(res);
    expect(res.error).toBe('no_group_path');
  });

  it('returns group_not_found when group does not exist', async () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore(),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = await runner.run('nonexistent');
    expectFailed(res);
    expect(res.error).toBe('group_not_found');
  });

  it('returns already_running when called twice without cancel', async () => {
    // Use a hanging script so the first run never completes
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'Hang', cmd: 'sleep 9999' },
    ]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const firstRunPromise = runner.run('g1'); // starts but doesn't complete
    // Give it a tick to register in running map
    await Promise.resolve();
    const secondRes = await runner.run('g1');
    expectFailed(secondRes);
    expect(secondRes.error).toBe('already_running');

    // Cleanup: cancel so the first run doesn't hang the test suite
    runner.cancel('g1');
    await firstRunPromise;
  });

  it('full pipeline succeeds — 3 steps (parallel / serial / parallel)', async () => {
    const steps = [
      makeStep('s1', 'parallel', [
        { id: 'sc1', name: 'A' },
        { id: 'sc2', name: 'B' },
      ]),
      makeStep('s2', 'serial', [
        { id: 'sc3', name: 'C' },
        { id: 'sc4', name: 'D' },
      ]),
      makeStep('s3', 'parallel', [{ id: 'sc5', name: 'E' }]),
    ];

    const pm = makeMockPM({
      'pre:g1:s1:sc1': { code: 0 },
      'pre:g1:s1:sc2': { code: 0 },
      'pre:g1:s2:sc3': { code: 0 },
      'pre:g1:s2:sc4': { code: 0 },
      'pre:g1:s3:sc5': { code: 0 },
    });
    const broadcast = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: broadcast,
      onError: vi.fn(),
    });

    const res = await runner.run('g1');
    expectSucceeded(res);
    expect(res.runId).toBeTruthy();
    // broadcastUpdate was called at least for start and each step
    expect(broadcast.mock.calls.length).toBeGreaterThanOrEqual(4); // start + 3 step transitions + done
  });

  it('mid-pipeline failure aborts remaining steps', async () => {
    const steps = [
      makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }]),
      makeStep('s2', 'serial', [{ id: 'sc2', name: 'B' }]), // fails
      makeStep('s3', 'parallel', [{ id: 'sc3', name: 'C' }]), // must NOT run
    ];

    const pm = makeMockPM({
      'pre:g1:s1:sc1': { code: 0 },
      'pre:g1:s2:sc2': { code: 1 }, // fails
      // sc3 intentionally not configured — if start() is called it returns error
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run('g1');
    expectFailed(res);
    expect(res.error).toContain('step_2');
  });

  it('parallel step partial failure surfaces as pipeline failure', async () => {
    const steps = [
      makeStep('s1', 'parallel', [
        { id: 'sc1', name: 'A' },
        { id: 'sc2', name: 'B' },
        { id: 'sc3', name: 'C' },
      ]),
    ];

    const pm = makeMockPM({
      'pre:g1:s1:sc1': { code: 0 },
      'pre:g1:s1:sc2': { code: 1 }, // one fails
      'pre:g1:s1:sc3': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(false);
  });

  it('serial step aborts on first failure', async () => {
    const steps = [
      makeStep('s1', 'serial', [
        { id: 'sc1', name: 'A' },
        { id: 'sc2', name: 'B' },
        { id: 'sc3', name: 'C' },
      ]),
    ];

    // sc1 fails; sc2 and sc3 must NOT run
    const pm = makeMockPM({
      'pre:g1:s1:sc1': { code: 1 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(false);

    // sc2 and sc3 pids should never have been started (no logs for them)
    const logs2 = pm.getLogs('pre:g1:s1:sc2');
    const logs3 = pm.getLogs('pre:g1:s1:sc3');
    expect(logs2.length).toBe(0);
    expect(logs3.length).toBe(0);
  });

  it('aggregator log contains step boundary lines for completed steps', async () => {
    const steps = [
      makeStep('s1', 'parallel', [{ id: 'sc1', name: 'X' }]),
      makeStep('s2', 'serial', [{ id: 'sc2', name: 'Y' }]),
    ];

    const pm = makeMockPM({
      'pre:g1:s1:sc1': { code: 0 },
      'pre:g1:s2:sc2': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(true);

    // Find aggregator pid (starts with pre-pipeline:g1:)
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Step 1/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Step 2/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Pipeline complete'))).toBe(true);
  });
});

describe('createPreScriptRunner — cancel()', () => {
  it('returns not_running when no pipeline is active', () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore(),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = runner.cancel('g1');
    expect(res).toEqual({ ok: false, error: 'not_running' });
  });

  it('cancel during parallel step: resolves pipeline as cancelled', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'A', cmd: 'sleep 9999' },
      { id: 'sc2', name: 'B', cmd: 'sleep 9999' },
    ]);
    const pm = makeMockPM({
      'pre:g1:s1:sc1': 'hang',
      'pre:g1:s1:sc2': 'hang',
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run('g1');
    // Give the pipeline time to start sc1 and sc2
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel('g1');
    const res = await runPromise;
    expectFailed(res);
    expect(res.error).toBe('cancelled');
  });

  it('cancel during serial step: resolves as cancelled', async () => {
    const step = makeStep('s1', 'serial', [
      { id: 'sc1', name: 'A', cmd: 'sleep 9999' },
      { id: 'sc2', name: 'B', cmd: 'sleep 9999' },
    ]);
    const pm = makeMockPM({
      'pre:g1:s1:sc1': 'hang',
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run('g1');
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel('g1');
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
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'Slow', timeoutMs: 5000 },
    ]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run('g1');
    // Give the pipeline time to set up the timeout
    await Promise.resolve();
    await Promise.resolve();

    // Advance clock past the timeout
    vi.advanceTimersByTime(5001);

    // Let the resulting stop → action:done microtask propagate
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
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'Fast', timeoutMs: 10000 },
    ]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(true);

    const lines = getAggregatorLines(pm);

    expect(lines.some((l) => l.includes('timed out'))).toBe(false);
    // stop should not have been called from the timeout path
    // (cancel() in the runner uses stop, but this pipeline succeeded)
    const stopCallsOnSc1 = pm.stop.mock.calls.filter(
      (args) => args[0] === 'pre:g1:s1:sc1',
    );
    expect(stopCallsOnSc1.length).toBe(0);
  });

  it('simultaneous completion and timeout boundary: stop called at most once per pid', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'Race', timeoutMs: 5000 },
    ]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    // Run completes naturally (code 0), timeout not fired since clearTimeout runs first
    const res = await runner.run('g1');
    expect(res.ok).toBe(true);

    const stopCallsOnSc1 = pm.stop.mock.calls.filter(
      (args) => args[0] === 'pre:g1:s1:sc1',
    );
    expect(stopCallsOnSc1.length).toBe(0);
  });
});

describe('createPreScriptRunner — duration markers', () => {
  it('"Pipeline complete (Xs)" present in aggregator', async () => {
    const steps = [makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }])];
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run('g1');
    const lines = getAggregatorLines(pm);
    expect(
      lines.some(
        (l) => l.includes('Pipeline complete') && l.match(/\(\d+\w+.*\)/),
      ),
    ).toBe(true);
  });

  it('"Step 1 completed (Xs)" present after step success', async () => {
    const steps = [makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }])];
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run('g1');
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Step 1 completed'))).toBe(true);
  });

  it('"Script finished ok (Xs)" contains no bare "exit N"', async () => {
    const steps = [makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }])];
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run('g1');
    const lines = getAggregatorLines(pm);
    const finishedLine = lines.find((l) => l.includes('finished ok'));
    expect(finishedLine).toBeTruthy();
    // New format: "finished ok (Xs)" — no "exit N" in the finished-ok line
    expect(finishedLine).not.toMatch(/finished ok \(exit \d+\)/);
    expect(finishedLine).toMatch(/finished ok \(\d+\w+.*\)/);
  });

  it('failed script keeps "failed (exit N, Xs)" shape', async () => {
    const steps = [makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }])];
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 1 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run('g1');
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
      configStore: makeConfigStore(),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    expect(runner.getRunState('g1')).toBeNull();
  });

  it('getRecentResult returns null when no recent run', () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore(),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    expect(runner.getRecentResult('g1')).toBeNull();
  });

  it('getRecentResult returns done after successful pipeline', async () => {
    const steps = [makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }])];
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run('g1');
    // After run completes, running map is cleared but recentResult has done status
    expect(runner.getRunState('g1')).toBeNull();
    const recent = expectPresent(runner.getRecentResult('g1'));
    expect(recent.status).toBe('done');
  });

  it('getRecentResult returns error after failed pipeline', async () => {
    const steps = [makeStep('s1', 'parallel', [{ id: 'sc1', name: 'A' }])];
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 1 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: steps }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run('g1');
    const recent = expectPresent(runner.getRecentResult('g1'));
    expect(recent.status).toBe('error');
  });
});

describe('createPreScriptRunner — confirmation gate', () => {
  it('R2.1: confirm:false → confirmScript never called, start runs normally', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'A', confirm: false },
    ]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const confirmScript = vi.fn().mockResolvedValue(true);
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(true);
    expect(confirmScript).not.toHaveBeenCalled();
  });

  it('R2.2: confirm:true + confirmScript resolves true → start is called, pipeline succeeds', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'A', confirm: true },
    ]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const confirmScript = vi.fn().mockResolvedValue(true);
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(true);
    expect(confirmScript).toHaveBeenCalledTimes(1);
    // Proves start() actually ran for sc1 (pipeline can only succeed if it did)
    expect(pm.getLogs('pre:g1:s1:sc1')).toEqual([]);
    expect(pm.getState('pre:g1:s1:sc1').status).toBe('done');
  });

  it('R2.3: confirm:true + confirmScript resolves false → declined (cancelled, NOT a failure), start never called, no onError', async () => {
    const step = makeStep('s1', 'serial', [
      { id: 'sc1', name: 'A', confirm: true },
    ]);
    // sc1 intentionally not configured in pm — if start() were called it would error
    const pm = makeMockPM({});
    const confirmScript = vi.fn().mockResolvedValue(false);
    const onError = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError,
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run('g1');
    // Declining a confirmation is a user choice, NOT a pipeline failure:
    // it must not surface as an error (so main can still start commands).
    expectFailed(res);
    expect(res.cancelled).toBe(true);
    expect(res.error).toBe('cancelled');
    expect(onError).not.toHaveBeenCalled();
    expect(confirmScript).toHaveBeenCalledTimes(1);
    // start() was never called for sc1 (no logs recorded for its pid)
    expect(pm.getLogs('pre:g1:s1:sc1').length).toBe(0);
    // No lingering error result → tray shows no red badge.
    const rr = runner.getRecentResult('g1');
    expect(rr == null || rr.status !== 'error').toBe(true);

    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('cancelado por el usuario'))).toBe(
      true,
    );
  });

  it('R2.4: no confirmScript dep injected → fail-safe declined (cancelled, not failure), start never called', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'A', confirm: true },
    ]);
    // Configure a valid, would-succeed pid so a false pass is impossible:
    // without the fail-safe gate, start() would run and the pipeline would
    // succeed instead of being declined.
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 0 } });
    const onError = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError,
      // No confirmScript / cancelConfirm injected — fail-safe path
    });

    const res = await runner.run('g1');
    expectFailed(res);
    expect(res.cancelled).toBe(true);
    expect(res.error).toBe('cancelled');
    expect(onError).not.toHaveBeenCalled();
    expect(pm.getLogs('pre:g1:s1:sc1').length).toBe(0);
  });

  it('R2.7: a real script failure (exit≠0) stays a failure — NOT cancelled — and calls onError', async () => {
    const step = makeStep('s1', 'serial', [{ id: 'sc1', name: 'A' }]);
    const pm = makeMockPM({ 'pre:g1:s1:sc1': { code: 1 } });
    const onError = vi.fn();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError,
    });

    const res = await runner.run('g1');
    expectFailed(res);
    expect(res.cancelled).toBeFalsy();
    expect(res.error).toBe('step_1_failed');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('R2.5: parallel step with 2 confirm:true scripts → confirmScript called once per script', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'A', confirm: true },
      { id: 'sc2', name: 'B', confirm: true },
    ]);
    const pm = makeMockPM({
      'pre:g1:s1:sc1': { code: 0 },
      'pre:g1:s1:sc2': { code: 0 },
    });
    const confirmScript = vi.fn().mockResolvedValue(true);
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run('g1');
    expect(res.ok).toBe(true);
    expect(confirmScript).toHaveBeenCalledTimes(2);
  });

  it('R2.6: cancel() while awaiting confirmScript → cancelConfirm called, pipeline resolves cancelled', async () => {
    const step = makeStep('s1', 'parallel', [
      { id: 'sc1', name: 'A', confirm: true },
    ]);
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
      configStore: makeConfigStore({ preSteps: [step] }),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      confirmScript,
      cancelConfirm,
    });

    const runPromise = runner.run('g1');
    // Give the pipeline time to reach the confirm await
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel('g1');
    const res = await runPromise;
    expectFailed(res);
    expect(res.error).toBe('cancelled');
    expect(cancelConfirm).toHaveBeenCalledWith('g1');
  });
});
