import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPreScriptRunner } from '../src/pre-script-runner.js';

// ─── Mock factory ───────────────────────────────────────────────────────────

/**
 * Create a mock processManager with controllable exit behaviour.
 *
 * @param {Record<string, { code: number } | 'hang'>} pidBehaviours
 *   Map from pid to exit behaviour: { code } resolves action:done, 'hang' never resolves.
 */
function makeMockPM(pidBehaviours = {}) {
  const listeners = {};
  const logs = {};
  const states = {};

  const pm = {
    on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    removeListener(event, fn) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((f) => f !== fn);
    },
    emit(event, payload) {
      for (const fn of listeners[event] || []) fn(payload);
    },
    pushLog(id, entry) {
      if (!logs[id]) logs[id] = [];
      logs[id].push(entry);
    },
    getLogs(id) {
      return logs[id] || [];
    },
    getState(id) {
      return states[id] || { status: 'stopped' };
    },
    start(pid) {
      const behaviour = pidBehaviours[pid];
      if (behaviour === undefined || behaviour === 'hang') {
        // Never resolves — caller must drive action:done manually or it hangs
        if (behaviour === undefined)
          return { ok: false, error: 'pid not configured' };
        // 'hang' means start ok but never fires action:done
        states[pid] = { status: 'running' };
        return { ok: true };
      }
      // Async: emit action:done on next microtask so the listener is attached first
      states[pid] = { status: 'running' };
      Promise.resolve().then(() => {
        pm.emit('action:done', { processId: pid, code: behaviour.code });
        states[pid] = { status: 'done' };
      });
      return { ok: true };
    },
    stop: vi.fn((pid) => {
      // Simulate stop: emit action:done with code 143 (SIGTERM) if hanging
      const state = states[pid];
      if (state && state.status === 'running') {
        states[pid] = { status: 'stopped' };
        Promise.resolve().then(() => {
          pm.emit('action:done', { processId: pid, code: 143 });
        });
      }
      return Promise.resolve({ ok: true });
    }),
    _logs: logs,
    _listeners: listeners,
  };

  return pm;
}

function makeConfigStore(groupOverride = {}) {
  const group = {
    id: 'g1',
    name: 'My Group',
    path: '/tmp/test-group',
    preSteps: [],
    commands: [],
    ...groupOverride,
  };
  return {
    getGroup: (id) => (id === group.id ? group : null),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStep(id, mode, scripts) {
  return {
    id,
    mode,
    scripts: scripts.map((sc) => ({
      id: sc.id,
      name: sc.name,
      command: sc.cmd || 'echo ok',
      ...(sc.timeoutMs != null ? { timeoutMs: sc.timeoutMs } : {}),
    })),
  };
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
    expect(res.ok).toBe(false);
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
    expect(res.ok).toBe(false);
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
    expect(secondRes.ok).toBe(false);
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
    expect(res.ok).toBe(true);
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
    expect(res.ok).toBe(false);
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
    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    expect(aggKey).toBeTruthy();
    const lines = pm._logs[aggKey].map((e) => e.line);
    expect(lines.some((l) => l.includes('Step 1/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Step 2/2'))).toBe(true);
    expect(lines.some((l) => l.includes('Pipeline complete'))).toBe(true);
  });
});

describe('createPreScriptRunner — cancel()', () => {
  it('returns not_running when no pipeline is active', async () => {
    const pm = makeMockPM();
    const runner = createPreScriptRunner({
      processManager: pm,
      configStore: makeConfigStore(),
      broadcastUpdate: vi.fn(),
      onError: vi.fn(),
    });
    const res = runner.cancel('g1');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_running');
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
    expect(res.ok).toBe(false);
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
    expect(res.ok).toBe(false);
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

    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    expect(aggKey).toBeTruthy();
    const lines = pm._logs[aggKey].map((e) => e.line);

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

    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    expect(aggKey).toBeTruthy();
    const lines = pm._logs[aggKey].map((e) => e.line);

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
    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    const lines = pm._logs[aggKey].map((e) => e.line);
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
    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    const lines = pm._logs[aggKey].map((e) => e.line);
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
    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    const lines = pm._logs[aggKey].map((e) => e.line);
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
    const aggKey = Object.keys(pm._logs).find((k) =>
      k.startsWith('pre-pipeline:g1:'),
    );
    const lines = pm._logs[aggKey].map((e) => e.line);
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
    const recent = runner.getRecentResult('g1');
    expect(recent).not.toBeNull();
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
    const recent = runner.getRecentResult('g1');
    expect(recent).not.toBeNull();
    expect(recent.status).toBe('error');
  });
});
