'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const { expandTilde, enhancedEnv } = require('./path-helper');
const { buildCmdline } = require('./parse-command');
const { parseProcessId } = require('./compound-id');
const { materializeEnv } = require('./groups-model');

const DEFAULT_LOG_BUFFER_LIMIT = 2000;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const SHELL_NOISE_PATTERNS = [
  /^\(anon\):setopt:\d+: can't change option: monitor$/,
  /^\[ERROR\]: gitstatus failed to initialize/,
  /^Add the following parameter to/,
  /^GITSTATUS_LOG_LEVEL=DEBUG$/,
  /^Restart Zsh to retry gitstatus/,
  /^exec zsh$/,
  /^zsh: no job control in this shell$/,
];

function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

function isShellNoise(line) {
  const clean = stripAnsi(line).trim();
  if (!clean) return false;
  return SHELL_NOISE_PATTERNS.some((re) => re.test(clean));
}

function safeRegex(source) {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch (_) {
    return null;
  }
}

/**
 * Test whether a cleaned log line matches a silenced pattern.
 *
 * Heuristic: patterns produced by buildSilencePattern always contain at least
 * one backslash (either from regex-escape or from \d+). Legacy literals that
 * were stored before this change have no backslashes — fall back to substring.
 *
 * This avoids the trap where a literal like "[12:34:56] WARN msg" would parse
 * as a valid regex (bracket = char class) but match in unintended ways.
 *
 * @param {string} p       — stored pattern
 * @param {string} cleaned — ANSI-stripped log line
 * @returns {boolean}
 */
function matchesPattern(p, cleaned) {
  if (!p) return false;
  if (!p.includes('\\')) return cleaned.includes(p);
  const re = safeRegex(p);
  return re ? re.test(cleaned) : cleaned.includes(p);
}

class ProcessManager extends EventEmitter {
  constructor(configStore) {
    super();
    this.configStore = configStore;
    this.states = new Map();
    this.logs = new Map();
  }

  getLogs(id) {
    return this.logs.get(id) || [];
  }

  pushLog(id, entry) {
    let buf = this.logs.get(id);
    if (!buf) {
      buf = [];
      this.logs.set(id, buf);
    }
    buf.push(entry);
    const state = this.states.get(id);
    const limit = (state && state.logLimit) || DEFAULT_LOG_BUFFER_LIMIT;
    if (buf.length > limit) buf.shift();
    this.emit('log', { id, entry });
  }

  /**
   * Resolve group + command/action/prescript from a compound process id.
   * Returns { group, target, kind } or null if not found.
   *
   * NOTE: preAggregator kind is virtual (logs-only); it intentionally returns
   * null here so process-manager never spawns for it.
   *
   * NOTE: pre-script pids are intentionally excluded from allStates() — they
   * are transient and aggregated via preScriptsStatus on the group state in
   * snapshotGroupStates(). A future maintainer should NOT add them to allStates().
   */
  resolveTarget(processId) {
    const parsed = parseProcessId(processId);
    if (parsed.kind === 'unknown') return null;
    if (parsed.kind === 'preAggregator') return null; // virtual pid; logs window opens by pid only
    const group = this.configStore.getGroup(parsed.groupId);
    if (!group) return null;
    if (parsed.kind === 'command') {
      const command = group.commands.find((c) => c.id === parsed.commandId);
      if (!command) return null;
      return { group, target: command, kind: 'command' };
    }
    if (parsed.kind === 'action') {
      const action = group.actions.find((a) => a.id === parsed.actionId);
      if (!action) return null;
      return { group, target: action, kind: 'action' };
    }
    if (parsed.kind === 'prescript') {
      const step = (group.preSteps || []).find((s) => s.id === parsed.stepId);
      if (!step) return null;
      const script = (step.scripts || []).find(
        (sc) => sc.id === parsed.scriptId,
      );
      if (!script) return null;
      return { group, target: script, kind: 'prescript' };
    }
    return null;
  }

  recount(id) {
    const state = this.states.get(id);
    if (!state) return;
    const buf = this.logs.get(id) || [];
    const resolved = this.resolveTarget(id);
    const patterns = (resolved &&
      resolved.target &&
      resolved.target.silencedPatterns) || { warn: [], error: [] };
    let warns = 0;
    let errs = 0;
    for (const e of buf) {
      const lvl = e.originalLevel || e.level;
      if (!lvl) continue;
      const list = patterns[lvl] || [];
      const cleaned = stripAnsi(e.line);
      const isSilenced =
        list.length && list.some((p) => matchesPattern(p, cleaned));
      e.silenced = isSilenced;
      e.level = isSilenced ? null : lvl;
      if (!isSilenced) {
        if (lvl === 'error') errs += 1;
        else warns += 1;
      }
    }
    state.warnCount = warns;
    state.errorCount = errs;
    this.emit('change', state);
  }

  getState(id) {
    return (
      this.states.get(id) || {
        id,
        status: 'stopped',
        warnCount: 0,
        errorCount: 0,
        lastError: null,
        startedAt: null,
        // Action-specific (null for commands)
        lastExitCode: null,
        lastFinishedAt: null,
      }
    );
  }

  setState(id, patch) {
    const prev = this.getState(id);
    const next = { ...prev, ...patch, id };
    this.states.set(id, next);
    this.emit('change', next);
    return next;
  }

  /**
   * allStates returns per-group structured states used by snapshotGroupStates in main.js.
   * Returns a flat array of state entries (with id and kind metadata from the compound id).
   */
  allStates() {
    // Collect all known compound ids
    const groups = this.configStore.listGroups();
    const entries = [];
    for (const group of groups) {
      for (const cmd of group.commands || []) {
        const pid = `cmd:${group.id}:${cmd.id}`;
        entries.push({
          ...this.getState(pid),
          group,
          target: cmd,
          kind: 'command',
        });
      }
      for (const act of group.actions || []) {
        const actPid = `act:${group.id}:${act.id}`;
        entries.push({
          ...this.getState(actPid),
          group,
          target: act,
          kind: 'action',
        });
      }
    }
    return entries;
  }

  resolveLogLimit(resolved) {
    const globals = this.configStore.getGlobalSettings();
    if (resolved && resolved.kind === 'command' && resolved.target) {
      const cmdLimit = resolved.target.maxLogLines;
      if (cmdLimit != null) return cmdLimit;
    }
    return globals.maxLogLines || DEFAULT_LOG_BUFFER_LIMIT;
  }

  start(processId) {
    const resolved = this.resolveTarget(processId);
    if (!resolved) return { ok: false, error: 'Process not found' };
    const { group, target, kind } = resolved;

    const current = this.getState(processId);
    if (current.status === 'running') return { ok: true };

    if (!target.command) {
      this.setState(processId, {
        status: 'stopped',
        lastError: 'No command configured',
      });
      return { ok: false, error: 'No command configured' };
    }

    const cwd = expandTilde(target.cwd || group.path) || process.cwd();
    const cmdline = buildCmdline(target.command, target.args);
    const shell = process.env.SHELL || '/bin/zsh';

    // Build effective env for spawn
    let spawnEnv;
    if (kind === 'command') {
      // Commands always inherit group env + command env
      spawnEnv = enhancedEnv({
        ...process.env,
        ...materializeEnv(group.env),
        ...materializeEnv(target.env),
      });
    } else {
      // Actions: own env entries always apply.
      // Group env only flows in when inheritGroupEnv === true.
      let env = { ...process.env };
      if (target.inheritGroupEnv === true) {
        env = { ...env, ...materializeEnv(group.env) };
      }
      env = { ...env, ...materializeEnv(target.env) };
      spawnEnv = enhancedEnv(env);
    }

    let child;
    try {
      child = spawn(shell, ['-ic', cmdline], {
        cwd,
        env: spawnEnv,
        shell: false,
        detached: true,
      });
    } catch (err) {
      this.setState(processId, { status: 'stopped', lastError: err.message });
      return { ok: false, error: err.message };
    }

    // Actions don't drive the tray color — no regex classification needed
    const warnRe = kind === 'command' ? safeRegex(target.warnRegex) : null;
    const errRe = kind === 'command' ? safeRegex(target.errorRegex) : null;

    let initWindow = true;
    setTimeout(() => {
      initWindow = false;
    }, 1500);

    const logLimit = this.resolveLogLimit(resolved);

    this.logs.set(processId, []);
    this.states.set(processId, {
      id: processId,
      status: 'running',
      warnCount: 0,
      errorCount: 0,
      lastError: null,
      startedAt: Date.now(),
      child,
      logLimit,
      // Action extras
      lastExitCode: null,
      lastFinishedAt: null,
    });
    this.pushLog(processId, {
      ts: Date.now(),
      stream: 'sys',
      level: null,
      line: `▶ start: ${shell} -ic '${cmdline}'  (cwd=${cwd})`,
    });
    this.emit('change', this.getState(processId));

    const handleLine = (stream) => (line) => {
      const state = this.states.get(processId);
      if (!state) return;
      if (isShellNoise(line)) return;
      if (initWindow && stripAnsi(line).trim() === '') return;
      let detectedLevel = null;
      if (kind === 'command') {
        if (errRe && errRe.test(line)) {
          detectedLevel = 'error';
        } else if (warnRe && warnRe.test(line)) {
          detectedLevel = 'warn';
        }
      }

      let silenced = false;
      if (detectedLevel) {
        // Re-read fresh config for silenced patterns
        const freshResolved = this.resolveTarget(processId);
        const patterns =
          (freshResolved &&
            freshResolved.target &&
            freshResolved.target.silencedPatterns &&
            freshResolved.target.silencedPatterns[detectedLevel]) ||
          [];
        if (patterns.length) {
          const cleaned = stripAnsi(line);
          if (patterns.some((p) => matchesPattern(p, cleaned))) {
            silenced = true;
          }
        }
      }

      if (detectedLevel && !silenced) {
        if (detectedLevel === 'error') state.errorCount += 1;
        else state.warnCount += 1;
      }

      const level = silenced ? null : detectedLevel;
      this.pushLog(processId, {
        ts: Date.now(),
        stream,
        level,
        originalLevel: detectedLevel,
        silenced,
        line,
      });
      if (detectedLevel && !silenced) this.emit('change', state);
    };

    readline
      .createInterface({ input: child.stdout })
      .on('line', handleLine('stdout'));
    readline
      .createInterface({ input: child.stderr })
      .on('line', handleLine('stderr'));

    child.on('error', (err) => {
      this.pushLog(processId, {
        ts: Date.now(),
        stream: 'sys',
        level: 'error',
        line: `✕ spawn error: ${err.message}`,
      });
      this.setState(processId, {
        status: 'stopped',
        lastError: `spawn error: ${err.message}`,
        child: null,
      });
    });

    child.on('exit', (code, signal) => {
      const state = this.states.get(processId);
      if (!state || state.child !== child) return;
      const wasKilled = signal === 'SIGTERM' || signal === 'SIGKILL';

      this.pushLog(processId, {
        ts: Date.now(),
        stream: 'sys',
        level: wasKilled ? null : code !== 0 ? 'error' : null,
        line: wasKilled
          ? `■ stopped (${signal})`
          : `■ exited with code ${code}`,
      });

      if (kind === 'action' || kind === 'prescript') {
        // Actions and prescripts use 'done' status to distinguish from a long-running stop.
        // We reuse the same event name 'action:done' for prescripts (ADR-2): listeners that
        // only care about actions can filter by parseProcessId(processId).kind.
        this.setState(processId, {
          status: 'done',
          lastError: wasKilled
            ? null
            : code !== 0
              ? `exited with code ${code}`
              : null,
          lastExitCode: code,
          lastFinishedAt: Date.now(),
          child: null,
        });
        this.emit('action:done', { processId, code, group, target });
      } else {
        this.setState(processId, {
          status: 'stopped',
          lastError: wasKilled
            ? null
            : code !== 0
              ? `exited with code ${code}`
              : null,
          child: null,
        });
      }
    });

    return { ok: true };
  }

  /**
   * Stop all currently-running processes, then clear states and logs.
   * Iterates this.states directly so it works even after replaceConfig
   * has removed the old groups from configStore.
   */
  async stopAll() {
    const runningIds = [];
    for (const [id, state] of this.states.entries()) {
      if (state && state.status === 'running' && state.child) {
        runningIds.push(id);
      }
    }
    await Promise.all(runningIds.map((id) => this.stop(id)));
    this.states.clear();
    this.logs.clear();
  }

  async stop(id) {
    const state = this.states.get(id);
    if (!state || !state.child || state.status !== 'running') {
      this.setState(id, { status: 'stopped', child: null });
      return { ok: true };
    }
    const child = state.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        killGroup(child, 'SIGKILL');
      }, 5000);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve({ ok: true });
      });

      const err = killGroup(child, 'SIGTERM');
      if (err) {
        clearTimeout(timer);
        this.setState(id, {
          status: 'stopped',
          child: null,
          lastError: err.message,
        });
        resolve({ ok: false, error: err.message });
      }
    });
  }
}

function killGroup(child, signal) {
  if (!child || !child.pid) return null;
  try {
    process.kill(-child.pid, signal);
    return null;
  } catch (groupErr) {
    try {
      child.kill(signal);
      return null;
    } catch (err) {
      return err;
    }
  }
}

function deriveColor(state, command, group, globals) {
  if (state.status !== 'running') {
    if (state.lastError) return 'error';
    return 'stopped';
  }
  const g = globals || {};
  const grp = group || {};
  const cmd = command || {};
  const muteErr = !!(g.silenceErrors || grp.silenceErrors || cmd.silenceErrors);
  const muteWarn = !!(
    g.silenceWarnings ||
    grp.silenceWarnings ||
    cmd.silenceWarnings
  );
  if (state.errorCount > 0 && !muteErr) return 'error';
  if (state.warnCount > 0 && !muteWarn) return 'warn';
  return 'running';
}

module.exports = { ProcessManager, deriveColor };
