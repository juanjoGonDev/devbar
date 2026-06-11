'use strict';

/**
 * pre-script-runner.js — pure factory for running and cancelling pre-script pipelines.
 *
 * The runner is pure in the sense that it has no Electron deps: all
 * collaborators (processManager, configStore, broadcastUpdate, onError)
 * are injected.  This keeps the module unit-testable with mock collaborators.
 *
 * Usage:
 *   const runner = createPreScriptRunner({ processManager, configStore, broadcastUpdate, onError });
 *   const result = await runner.run(groupId);  // { ok, runId? } or { ok: false, error }
 *   runner.cancel(groupId);                     // { ok } or { ok: false, error: 'not_running' }
 */

const { makePreScriptId, makeAggregatorId } = require('./compound-id');

/**
 * @param {{
 *   processManager: import('./process-manager').ProcessManager,
 *   configStore: object,
 *   broadcastUpdate: () => void,
 *   onError: (err: string, ctx: object) => void,
 * }} deps
 */
function createPreScriptRunner({ processManager, configStore, broadcastUpdate, onError }) {
  // groupId → RunHandle
  const running = new Map();

  // groupId → { status: 'done'|'error', error?: string, runId: number, expiresAt: number }
  const recentResult = new Map();

  /**
   * RunHandle shape:
   * {
   *   runId: number,
   *   aggregatorId: string,
   *   cancelled: boolean,
   *   childPids: Set<string>,
   *   currentStep: number,   // 1-based
   *   totalSteps: number,
   *   status: 'running'|'done'|'error',
   * }
   */

  // ── Helpers ─────────────────────────────────────────────────────────

  function pushAggregatorLog(aggregatorId, line, level) {
    processManager.pushLog(aggregatorId, {
      ts: Date.now(),
      stream: 'sys',
      level: level || null,
      line,
    });
  }

  function setRecentResult(groupId, status, error, runId, delayMs) {
    const expiresAt = Date.now() + delayMs;
    recentResult.set(groupId, { status, error: error || null, runId, expiresAt });
    setTimeout(() => {
      const entry = recentResult.get(groupId);
      if (entry && entry.runId === runId) {
        recentResult.delete(groupId);
        broadcastUpdate();
      }
    }, delayMs);
  }

  // ── runOne ──────────────────────────────────────────────────────────

  /**
   * Run a single pre-script inside a pipeline step.
   * CRITICAL: subscribes to 'action:done' BEFORE calling processManager.start(pid)
   * to avoid missing the event for fast-finishing scripts (Risk R1).
   */
  function runOne(script, step, groupId, handle) {
    const pid = makePreScriptId(groupId, step.id, script.id);
    handle.childPids.add(pid);
    const tag = `[${script.name}]`;

    return new Promise((resolve) => {
      // Forward every per-script log line to the aggregator with a
      // [scriptName] prefix so the user sees stdout/stderr inline in
      // the pipeline view — no need to open the per-script log to
      // diagnose a failure.
      const logHandler = ({ id, entry }) => {
        if (id !== pid) return;
        // Skip our own synthetic "▶ start" / "✗ exit N" lines from
        // process-manager: they'd just clutter the aggregator with
        // duplicates of what we already emit as step boundaries.
        if (entry && entry.stream === 'sys') return;
        pushAggregatorLog(
          handle.aggregatorId,
          `${tag} ${entry.line}`,
          entry.level || null,
        );
      };
      processManager.on('log', logHandler);

      // SUBSCRIBE BEFORE START — must be synchronous before start() returns.
      const handler = ({ processId, code }) => {
        if (processId !== pid) return;
        processManager.removeListener('action:done', handler);
        processManager.removeListener('log', logHandler);
        handle.childPids.delete(pid);
        const ok = code === 0;
        pushAggregatorLog(
          handle.aggregatorId,
          ok
            ? `── Script "${script.name}" finished ok (exit ${code}) ──`
            : `── Script "${script.name}" failed (exit ${code}) ──`,
          ok ? null : 'error',
        );
        resolve({ ok, code });
      };
      processManager.on('action:done', handler);

      const result = processManager.start(pid);
      if (!result.ok) {
        processManager.removeListener('action:done', handler);
        processManager.removeListener('log', logHandler);
        handle.childPids.delete(pid);
        pushAggregatorLog(
          handle.aggregatorId,
          `── Script "${script.name}" failed to start: ${result.error} ──`,
          'error',
        );
        resolve({ ok: false, code: -1, error: result.error });
      }
    });
  }

  // ── run ─────────────────────────────────────────────────────────────

  async function run(groupId) {
    if (running.has(groupId)) {
      return { ok: false, error: 'already_running' };
    }

    const group = configStore.getGroup(groupId);
    if (!group) return { ok: false, error: 'group_not_found' };

    const steps = group.preSteps || [];
    if (steps.length === 0) return { ok: true }; // no-op, no broadcast

    // Pre-scripts MUST run inside the group's path. Without one, process-manager
    // would silently fall back to process.cwd() (the app's launch dir), which is
    // almost never what the user wants. Fail loudly so the user fixes the group.
    const groupPath = (group.path || '').trim();
    if (!groupPath) {
      const runIdEarly = Date.now();
      const aggregatorIdEarly = makeAggregatorId(groupId, runIdEarly);
      pushAggregatorLog(
        aggregatorIdEarly,
        `── Pipeline aborted: group "${group.name}" has no path configured ──`,
        'error',
      );
      setRecentResult(groupId, 'error', 'Group has no path configured', runIdEarly, 5000);
      broadcastUpdate();
      if (onError) onError('Group has no path configured', { groupId });
      return { ok: false, error: 'no_group_path' };
    }

    const runId = Date.now();
    const aggregatorId = makeAggregatorId(groupId, runId);

    const handle = {
      runId,
      aggregatorId,
      cancelled: false,
      childPids: new Set(),
      currentStep: 1,
      totalSteps: steps.length,
      status: 'running',
    };
    running.set(groupId, handle);
    broadcastUpdate();

    pushAggregatorLog(aggregatorId, `── Pipeline started (${steps.length} steps) ──`);
    pushAggregatorLog(aggregatorId, `── Working directory: ${groupPath} ──`);

    let pipelineOk = true;
    let failedStepIdx = -1;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      handle.currentStep = i + 1;
      broadcastUpdate();

      if (handle.cancelled) {
        pipelineOk = false;
        break;
      }

      pushAggregatorLog(aggregatorId, `── Step ${i + 1}/${steps.length} (${step.mode}) starting ──`);

      let stepOk = false;
      if (step.mode === 'serial') {
        // Serial: run one by one, abort on first failure
        stepOk = true;
        for (const script of step.scripts || []) {
          if (handle.cancelled) { stepOk = false; break; }
          const r = await runOne(script, step, groupId, handle);
          if (!r.ok) { stepOk = false; break; }
        }
      } else {
        // Parallel: run all, succeed only if all exit 0
        const results = await Promise.all(
          (step.scripts || []).map((script) => runOne(script, step, groupId, handle)),
        );
        stepOk = results.every((r) => r.ok);
      }

      if (!stepOk || handle.cancelled) {
        pipelineOk = false;
        failedStepIdx = i + 1;
        break;
      }
    }

    running.delete(groupId);

    if (!pipelineOk) {
      const reason = handle.cancelled ? 'cancelled' : `step_${failedStepIdx}_failed`;
      const logLine = handle.cancelled
        ? '── Pipeline cancelled ──'
        : `── Pipeline failed at step ${failedStepIdx} ──`;
      pushAggregatorLog(aggregatorId, logLine, 'error');
      handle.status = 'error';
      // Keep error visible for 5 seconds
      setRecentResult(groupId, 'error', reason, runId, 5000);
      broadcastUpdate();
      if (onError) onError(reason, { groupId, runId });
      return { ok: false, error: reason };
    }

    handle.status = 'done';
    pushAggregatorLog(aggregatorId, '── Pipeline complete ──');
    // Keep done visible for 3 seconds
    setRecentResult(groupId, 'done', null, runId, 3000);
    broadcastUpdate();
    return { ok: true, runId };
  }

  // ── cancel ──────────────────────────────────────────────────────────

  function cancel(groupId) {
    const handle = running.get(groupId);
    if (!handle) return { ok: false, error: 'not_running' };
    handle.cancelled = true;
    for (const pid of handle.childPids) {
      try { processManager.stop(pid); } catch (_) {}
    }
    return { ok: true };
  }

  // ── State accessors ──────────────────────────────────────────────────

  function isRunning(groupId) {
    return running.has(groupId);
  }

  function getRunState(groupId) {
    const h = running.get(groupId);
    if (!h) return null;
    return {
      status: h.status,
      currentStep: h.currentStep,
      totalSteps: h.totalSteps,
      runId: h.runId,
      aggregatorId: h.aggregatorId,
    };
  }

  function getRecentResult(groupId) {
    const entry = recentResult.get(groupId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      recentResult.delete(groupId);
      return null;
    }
    return entry;
  }

  return { run, cancel, isRunning, getRunState, getRecentResult, running };
}

module.exports = { createPreScriptRunner };
