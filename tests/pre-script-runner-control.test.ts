import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPreScriptRunner,
  type PreScriptProcessManager,
  type RunResult,
} from '../src/pre-script-runner.js';
import {} from '../src/autostart-schedule.js';
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

/** Narration ABOUT one script now lives in that script's OWN buffer, so the
 * merged view can tag it `[Group] [Script]` from a real source. */
function getScriptLines(pm: MockProcessManager, pid: string): string[] {
  return pm.getLogs(pid).map((entry) => entry.line);
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

  it('script exceeds timeoutMs: resolves ok:false, aggregator contains the timeout line, no failure line, stop called once', async () => {
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
    const lines = getScriptLines(pm, 'pre:g1:sc1');
    expect(lines.some((l) => l.includes('excedido el tiempo'))).toBe(true);
    expect(lines.some((l) => l.includes('Ha fallado (salida'))).toBe(false);
    expect(pm.stop.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('script completes before timeout: resolves ok:true, no timeout line, stop not called from timeout path', async () => {
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
    const lines = getScriptLines(pm, 'pre:g1:sc1');
    expect(lines.some((l) => l.includes('excedido el tiempo'))).toBe(false);
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
  it('"Pipeline completado (Xs)" present in aggregator', async () => {
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
        (l) => l.includes('Pipeline completado') && l.match(/\(\d+\w+.*\)/),
      ),
    ).toBe(true);
  });

  it('"Paso 1 completado (Xs)" present after step success', async () => {
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
    expect(lines.some((l) => l.includes('Paso 1 completado'))).toBe(true);
  });

  it('"Script finalizado correctamente (Xs)" contains no bare "exit N"', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const finishedLine = getScriptLines(pm, 'pre:g1:sc1').find((l) =>
      l.includes('Finalizado correctamente'),
    );
    expect(finishedLine).toBeTruthy();
    expect(finishedLine).not.toMatch(/Finalizado correctamente \(exit \d+\)/);
    expect(finishedLine).toMatch(/Finalizado correctamente \(\d+\w+.*\)/);
  });

  it('failed script keeps "ha fallado (salida N, Xs)" shape', async () => {
    const steps = [makeStep('s1', 'parallel', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 1 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([G1], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    await runner.run();
    const failedLine = getScriptLines(pm, 'pre:g1:sc1').find((l) =>
      l.includes('Ha fallado (salida'),
    );
    expect(failedLine).toBeTruthy();
    expect(failedLine).toMatch(/Ha fallado \(salida 1,/);
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

describe('createPreScriptRunner — current()', () => {
  it('is null when idle', () => {
    const runner = createPreScriptRunner({
      processManager: makeMockPM(),
      configStore: makeConfigStore([G1], []),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    expect(runner.current()).toBeNull();
  });

  it('returns the in-flight promise while running, resolving to the same result the original caller gets, and goes null again once it settles', async () => {
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
    const inFlight = runner.current();
    expect(inFlight).not.toBeNull();

    runner.cancel();
    const [firstRes, inFlightRes] = await Promise.all([
      firstRunPromise,
      inFlight as Promise<RunResult>,
    ]);
    expect(inFlightRes).toEqual(firstRes);
    expect(runner.current()).toBeNull();
  });
});
