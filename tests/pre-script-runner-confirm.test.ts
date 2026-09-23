import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
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

function expectSucceeded(
  result: RunResult,
): asserts result is Extract<RunResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`Expected runner success, got ${result.error}`);
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

// A single-group, single-script fixture used by tests that only care about
// the pipeline mechanics, not about multi-group resolution.
const G1 = makeGroup({
  id: 'g1',
  name: 'My Group',
  path: '/tmp/test-group',
  preScripts: [makeScript({ id: 'sc1', name: 'A' })],
});

// ─── Tests ───────────────────────────────────────────────────────────────────

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
    // sc1 IS configured with a real success behaviour (unlike a bare
    // "not configured" pid) so a regression that calls start() despite the
    // decline actually flips its state away from 'stopped' — getState is
    // what can prove "never started"; getLogs cannot, since the runner only
    // ever pushes logs under the aggregator id (sdd-verify W4).
    const pm = makeMockPM({ 'pre:g1:sc1': { code: 0 } });
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
    expect(pm.getState('pre:g1:sc1').status).toBe('stopped');
    const rr = runner.getRecentResult();
    expect(rr == null || rr.status !== 'error').toBe(true);
    expect(
      getScriptLines(pm, 'pre:g1:sc1').some((l) =>
        l.includes('Cancelado por el usuario'),
      ),
    ).toBe(true);
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
    // sc1 IS configured with a real success behaviour — see the getState
    // rationale on the R2.3 test above (sdd-verify W4).
    expect(pm.getState('pre:g1:sc1').status).toBe('stopped');
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

describe('createPreScriptRunner — parallel concurrency and log labelling', () => {
  it('parallel step: the second ref starts without waiting for the first (real overlap)', async () => {
    const steps = [
      makeStep('s1', 'parallel', [ref('g1', 'sc1'), ref('g1', 'sc2')]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
      ],
    });
    // Mirror of the serial no-overlap test: sc1 hangs until the test emits
    // its action:done. Under a sequential implementation sc2 would still be
    // 'stopped' here, so this is what tells `Promise.all` apart from
    // `for…await` — the exact mutation the suite previously survived.
    const pm = makeMockPM({ 'pre:g1:sc1': 'hang', 'pre:g1:sc2': { code: 0 } });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pm.getState('pre:g1:sc2').status).toBe('done');

    pm.emit('action:done', {
      processId: 'pre:g1:sc1',
      code: 0,
      group: PLACEHOLDER_GROUP,
      target: PLACEHOLDER_SCRIPT,
    });
    const res = await runPromise;
    expect(res.ok).toBe(true);
  });

  it('every script line names its group, so same-named scripts stay distinct', async () => {
    const steps = [
      makeStep('s1', 'serial', [ref('back', 'setup'), ref('auto', 'setup')]),
    ];
    const groups = [
      makeGroup({
        id: 'back',
        name: 'Back',
        path: '/tmp/back',
        preScripts: [makeScript({ id: 'setup', name: 'Make setup' })],
      }),
      makeGroup({
        id: 'auto',
        name: 'Automator',
        path: '/tmp/auto',
        preScripts: [makeScript({ id: 'setup', name: 'Make setup' })],
      }),
    ];
    const pm = makeMockPM({
      'pre:back:setup': { code: 0 },
      'pre:auto:setup': { code: 0 },
    });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore(groups, steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const res = await runner.run();
    expectSucceeded(res);
    // Identity now lives in each line's SOURCE, not in its text: the two
    // same-named scripts are distinguishable because each one's narration
    // lands in its own buffer, which the merged view tags [Group] [Script].
    // Asserting on prose would pass even if both lines shared one buffer.
    expect(
      getScriptLines(pm, 'pre:back:setup').some((l) =>
        l.includes('Finalizado correctamente'),
      ),
      'Back·Make setup has no line of its own',
    ).toBe(true);
    expect(
      getScriptLines(pm, 'pre:auto:setup').some((l) =>
        l.includes('Finalizado correctamente'),
      ),
      'Automator·Make setup has no line of its own',
    ).toBe(true);
    // And the aggregator names neither: it carries pipeline narration only.
    expect(getAggregatorLines(pm).some((l) => l.includes('Make setup'))).toBe(
      false,
    );
  });

  it('never copies a script’s own output into the aggregator buffer', async () => {
    const steps = [makeStep('s1', 'serial', [ref('back', 'setup')])];
    const group = makeGroup({
      id: 'back',
      name: 'Back',
      path: '/tmp/back',
      preScripts: [makeScript({ id: 'setup', name: 'Make setup' })],
    });
    const pm = makeMockPM({ 'pre:back:setup': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const runPromise = runner.run();
    await Promise.resolve();
    await Promise.resolve();
    // Simulates the script's own child process emitting real output — this is
    // ordinary per-process logging done by processManager, unrelated to the
    // runner. The runner must not additionally relay it into the aggregator.
    pm.pushLog('pre:back:setup', {
      ts: Date.now(),
      stream: 'stdout',
      level: null,
      line: 'compilando…',
    });
    pm.emit('action:done', {
      processId: 'pre:back:setup',
      code: 0,
      group: PLACEHOLDER_GROUP,
      target: PLACEHOLDER_SCRIPT,
    });
    const res = await runPromise;
    expectSucceeded(res);
    // The aggregator only ever carries the pipeline's own narration — never a
    // copy of a script's stdout/stderr, which would duplicate the same line
    // between two buffers and make the pipeline's line count lie about how
    // much a script actually produced.
    const aggregatorLines = pm
      .getLogs(`pre-pipeline:${res.runId}`)
      .map((entry) => entry.line);
    expect(aggregatorLines.some((line) => line.includes('compilando…'))).toBe(
      false,
    );
    // The line still lives exactly once, in the script's own buffer, and
    // verbatim — no `[tag]` prefix rewriting it, no duplication. Its own
    // narration shares that buffer, which is what lets the merged view tag
    // both as [Group] [Script].
    const scriptLines = pm.getLogs('pre:back:setup').map((entry) => entry.line);
    expect(scriptLines.filter((line) => line === 'compilando…')).toHaveLength(
      1,
    );
  });
});

describe('createPreScriptRunner — adopting a run already in flight', () => {
  it('hands back the in-flight promise synchronously with the rejected attempt', async () => {
    // The adopting caller reads `current()` in the statement right after
    // calling `run()`. Nothing may settle in between, or a run that finishes
    // in that window leaves the caller holding the synthetic
    // `already_running` result: a cancellation reported as a failure, and no
    // aggregatorId, so the withheld notice never reaches the real run's log.
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [makeScript({ id: 'sc1', name: 'A' })],
    });
    const steps = [makeStep('s1', 'serial', [ref('g1', 'sc1')])];
    const pm = makeMockPM({ 'pre:g1:sc1': 'hang' });
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([group], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });

    const first = runner.run();
    await Promise.resolve();

    // Exactly what the adopting caller does: call, then capture, then await.
    const attempt = runner.run();
    const inFlight = runner.current();
    const res = await attempt;
    expect(res.ok).toBe(false);
    expect(inFlight).not.toBeNull();

    // Let the real run finish AFTER the attempt was rejected — the window the
    // racy version lost.
    pm.emit('action:done', {
      processId: 'pre:g1:sc1',
      code: 0,
      group: PLACEHOLDER_GROUP,
      target: PLACEHOLDER_SCRIPT,
    });
    const adopted = await inFlight!;
    const real = await first;
    expect(adopted).toEqual(real);
    expect(adopted.ok).toBe(true);
  });
});
