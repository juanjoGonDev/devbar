import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPreScriptRunner,
  type PreScriptProcessManager,
  type RunResult,
  type StepCompleteEvent,
} from '../src/pre-script-runner.js';
import {
  planAutoStartRelease,
  withheldGroupIds,
  describeWithheldGroups,
} from '../src/autostart-schedule.js';
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
    // sc2/sc3 ARE configured with a real success behaviour (unlike a bare
    // "not configured" pid): if the abort-on-first-failure guard regressed,
    // processManager.start() would actually run and flip their state away
    // from 'stopped'. getState, not getLogs, is what can prove "never
    // started" — the runner only ever pushes logs under the aggregator id
    // (sdd-verify W4), so a per-script getLogs() is always empty regardless
    // of whether the script ran.
    const pm = makeMockPM({
      'pre:g1:sc1': { code: 1 },
      'pre:g1:sc2': { code: 0 },
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
    expect(pm.getState('pre:g1:sc2').status).toBe('stopped');
    expect(pm.getState('pre:g1:sc3').status).toBe('stopped');
  });

  it('serial step: the second ref does not start until the first completes (no overlap)', async () => {
    const steps = [
      makeStep('s1', 'serial', [ref('g1', 'sc1'), ref('g1', 'sc2')]),
    ];
    const group = makeGroup({
      id: 'g1',
      path: '/tmp/g1',
      preScripts: [
        makeScript({ id: 'sc1', name: 'A' }),
        makeScript({ id: 'sc2', name: 'B' }),
      ],
    });
    // sc1 "hangs" — it will not resolve until the test manually emits its
    // action:done — so if sc2 were started before sc1 finishes, its state
    // would already be 'running' well before that emission.
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
    // sc1 is still pending: sc2 must not have been started yet.
    expect(pm.getState('pre:g1:sc2').status).toBe('stopped');

    pm.emit('action:done', {
      processId: 'pre:g1:sc1',
      code: 0,
      group: PLACEHOLDER_GROUP,
      target: PLACEHOLDER_SCRIPT,
    });
    const res = await runPromise;
    expect(res.ok).toBe(true);
    expect(pm.getState('pre:g1:sc2').status).toBe('done');
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
    expect(lines.some((l) => l.includes('Paso 1/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Paso 2/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Pipeline completado'))).toBe(true);
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
    expect(
      getScriptLines(pm, 'pre:gA:sca').some((l) =>
        l.includes('Directorio: /repo/a'),
      ),
    ).toBe(true);
    expect(
      getScriptLines(pm, 'pre:gB:scb').some((l) =>
        l.includes('Directorio: /repo/b'),
      ),
    ).toBe(true);
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

    // Record the real spawn sequence. Stronger than the old index compare:
    // it asserts the exact order, so a reversed or concurrent pipeline fails
    // rather than merely shifting indices that were derived from one log.
    const started: string[] = [];
    const realStart = pm.start.bind(pm);
    pm.start = (pid: string) => {
      started.push(pid);
      return realStart(pid);
    };

    const res = await runner.run();
    expect(res.ok).toBe(true);
    expect(started).toEqual(['pre:gA:a1', 'pre:gB:b1', 'pre:gA:a2']);
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
    expect(
      getScriptLines(pm, 'pre:gBroken:sc1').some((l) =>
        l.includes('Sin ruta configurada'),
      ),
    ).toBe(true);
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
    expect(lines.some((l) => l.includes('Referencia rota'))).toBe(true);
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

  it('an empty step is a no-op barrier: the pipeline advances through it and still fires onStepComplete for it', async () => {
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
      makeStep('s2', 'parallel', []), // empty step — a user-authored ordering slot
      makeStep('s3', 'parallel', [ref('g1', 'sc2')]),
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
    expect(events.map((e) => e.stepIndex)).toEqual([0, 1, 2]);
    const lines = getAggregatorLines(pm);
    expect(lines.some((l) => l.includes('Paso 2/3'))).toBe(true);
    expect(lines.some((l) => l.includes('Paso 2 completado'))).toBe(true);
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
    expect(lines.some((l) => l.includes('aviso de fin de paso: boom'))).toBe(
      true,
    );
  });
});

describe('createPreScriptRunner — staged auto-start release composition (mirrors main.ts wiring)', () => {
  // main.ts has no unit-test file in this repo (it is Electron-bound), so
  // this reconstructs its ACTUAL onStepComplete wiring — an `activeAutoStartRelease`-
  // style `fired` set plus the real, already-tested `planAutoStartRelease`/
  // `withheldGroupIds` pure functions — around a REAL runner, at runtime.
  it('a parallel sibling failure withholds an otherwise-successful group in the same step', async () => {
    const groupA = makeGroup({
      id: 'gA',
      path: '/repo/a',
      preScripts: [makeScript({ id: 'a1', name: 'A1' })],
    });
    const groupB = makeGroup({
      id: 'gB',
      path: '/repo/b',
      preScripts: [makeScript({ id: 'b1', name: 'B1' })],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('gA', 'a1'), ref('gB', 'b1')]),
    ];
    const pm = makeMockPM({
      'pre:gA:a1': { code: 0 }, // A succeeds
      'pre:gB:b1': { code: 1 }, // B fails — the step as a whole fails
    });

    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB'],
    });
    const fired = new Set<number>();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([groupA, groupB], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      onStepComplete: ({ stepIndex }) => fired.add(stepIndex),
    });

    const res = await runner.run();
    expectFailed(res);
    const withheld = withheldGroupIds(plan, fired);
    // Neither group is released: onStepComplete never fires for a step that
    // did not fully succeed, so gA — whose OWN script succeeded — is
    // withheld right alongside gB.
    expect(withheld).toEqual(['gA', 'gB']);
  });

  // The C2 seam: a declined confirmation, at runtime, releases groups whose
  // last step already fired and withholds the rest — reported as a
  // cancellation, never an error.
  it('a declined confirmation releases groups whose last step already fired and withholds the rest, reported as a cancellation', async () => {
    const groupA = makeGroup({
      id: 'gA',
      name: 'Group A',
      path: '/repo/a',
      preScripts: [makeScript({ id: 'a1', name: 'A1' })],
    });
    const groupB = makeGroup({
      id: 'gB',
      name: 'Group B',
      path: '/repo/b',
      preScripts: [makeScript({ id: 'b1', name: 'B1', confirm: true })],
    });
    const groupC = makeGroup({
      id: 'gC',
      name: 'Group C',
      path: '/repo/c',
      preScripts: [makeScript({ id: 'c1', name: 'C1' })],
    });
    const steps = [
      makeStep('s1', 'parallel', [ref('gA', 'a1')]),
      makeStep('s2', 'serial', [ref('gB', 'b1')]),
      makeStep('s3', 'parallel', [ref('gC', 'c1')]),
    ];
    // b1/c1 are never actually started (declined before b1 starts).
    const pm = makeMockPM({ 'pre:gA:a1': { code: 0 } });
    const plan = planAutoStartRelease({
      steps,
      eligibleGroupIds: ['gA', 'gB', 'gC'],
    });
    const fired = new Set<number>();
    const confirmScript = vi.fn().mockResolvedValue(false); // decline
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore([groupA, groupB, groupC], steps),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
      onStepComplete: ({ stepIndex }) => fired.add(stepIndex),
      confirmScript,
      cancelConfirm: vi.fn(),
    });

    const res = await runner.run();
    expectFailed(res);
    expect(res.cancelled).toBe(true);

    const withheld = withheldGroupIds(plan, fired);
    expect(withheld).toEqual(['gB', 'gC']);
    expect(withheld).not.toContain('gA'); // gA's step already fired — stays released

    const report = expectPresent(
      describeWithheldGroups({
        withheldIds: withheld,
        groupsById: new Map([
          ['gB', groupB],
          ['gC', groupC],
        ]),
        cause: res.cancelled ? 'cancelled' : 'failure',
      }),
    );
    expect(report.toastKind).toBe('ok'); // a decline is a cancellation, never an error
    expect(report.aggregatorLevel).toBe('warn');
    expect(report.message).toContain('Group B');
    expect(report.message).toContain('Group C');
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
