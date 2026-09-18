import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { isWin } from './platform.js';
import { expandTilde } from './path-helper.js';
import { buildCmdline, buildCmdlineWindows } from './parse-command.js';
import { parseProcessId } from './compound-id.js';
import {
  isShellNoise,
  matchesPattern,
  safeRegex,
  stripAnsi,
} from './process/log-filters.js';
import {
  buildSpawnArgs,
  killGroup,
  resolveSpawnEnv,
  serviceSpawnOptions,
} from './process/spawn.js';
import {
  DEFAULT_LOG_BUFFER_LIMIT,
  defaultState,
  publicState,
  type ConfigStoreLike,
  type InternalState,
  type ProcessEntry,
  type ProcessManagerEvents,
  type ResolvedTarget,
} from './process/state.js';
import type { LogEntry, LogLevel } from './domain-types.js';

export { buildSpawnArgs, serviceSpawnOptions } from './process/spawn.js';
export { deriveColor } from './process/tray-color.js';
export type { ProcessEntry } from './process/state.js';

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private readonly states = new Map<string, InternalState>();
  private readonly logs = new Map<string, LogEntry[]>();
  // pids we asked to die — tracked on Windows ONLY: there a killed process
  // exits with a plain code (no signal), so this is how the exit handler
  // still knows the stop was ours rather than a real crash. On macOS/Linux
  // a kill always arrives as SIGTERM/SIGKILL, so the set is never needed —
  // and a stale entry (e.g. the 6.5 s give-up path, where the exit handler
  // may already have run against a replaced state) could match a REUSED
  // pid and mislabel an unrelated process's natural exit as "stopped".
  private readonly killRequested = new Set<number>();
  constructor(private readonly configStore: ConfigStoreLike) {
    super();
  }
  getLogs(id: string): LogEntry[] {
    return this.logs.get(id) ?? [];
  }
  clearLogs(id: string): boolean {
    const buffer = this.logs.get(id);
    if (!buffer) return false;
    buffer.length = 0;
    this.recount(id);
    return true;
  }
  listLogBuffers(): Array<{ id: string; lineCount: number }> {
    return [...this.logs].map(([id, buffer]) => ({
      id,
      lineCount: buffer.length,
    }));
  }
  /**
   * How many lines this process's buffer actually keeps. A running process
   * froze its limit at start(), so a setting edited since then does not apply
   * to it. Anyone mirroring the buffer must ask here instead of recomputing
   * from config, or they hold lines this buffer has already dropped.
   */
  /**
   * How many lines this buffer has ever been given. Monotonic and never reset,
   * so a restart continues the count and a line from the run before it can
   * never be mistaken for a new one.
   */
  getLogSeq(id: string): number {
    return this.logSeqs.get(id) ?? 0;
  }
  getLogLimit(id: string): number {
    const state = this.states.get(id);
    if (state) return state.logLimit;
    const resolved = this.resolveTarget(id);
    return resolved ? this.resolveLogLimit(resolved) : DEFAULT_LOG_BUFFER_LIMIT;
  }
  pushLog(id: string, entry: LogEntry): void {
    let buffer = this.logs.get(id);
    if (!buffer) {
      buffer = [];
      this.logs.set(id, buffer);
    }
    const seq = this.getLogSeq(id) + 1;
    this.logSeqs.set(id, seq);
    entry.seq = seq;
    buffer.push(entry);
    const limit = this.getLogLimit(id);
    if (buffer.length > limit) buffer.shift();
    this.emit('log', { id, entry });
  }
  removeState(id: string): void {
    this.states.delete(id);
  }
  resolveTarget(processId: unknown): ResolvedTarget | null {
    const parsed = parseProcessId(processId);
    if (parsed.kind === 'unknown' || parsed.kind === 'preAggregator')
      return null;
    const group = this.configStore.getGroup(parsed.groupId);
    if (!group) return null;
    if (parsed.kind === 'command') {
      const target = group.commands.find(
        (command) => command.id === parsed.commandId,
      );
      return target ? { group, target, kind: 'command' } : null;
    }
    if (parsed.kind === 'action') {
      const target = group.actions.find(
        (action) => action.id === parsed.actionId,
      );
      return target ? { group, target, kind: 'action' } : null;
    }
    const target = group.preScripts.find(
      (script) => script.id === parsed.scriptId,
    );
    return target ? { group, target, kind: 'prescript' } : null;
  }
  recount(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    const buffer = this.logs.get(id) ?? [],
      resolved = this.resolveTarget(id),
      patterns =
        resolved?.kind === 'command'
          ? resolved.target.silencedPatterns
          : { warn: [], error: [] };
    let warns = 0,
      errors = 0;
    for (const entry of buffer) {
      const level = entry.originalLevel ?? entry.level;
      if (!level) continue;
      const cleaned = stripAnsi(entry.line),
        silenced = patterns[level].some((pattern) =>
          matchesPattern(pattern, cleaned),
        );
      entry.silenced = silenced;
      entry.level = silenced ? null : level;
      if (!silenced) {
        if (level === 'error') errors++;
        else warns++;
      }
    }
    state.warnCount = warns;
    state.errorCount = errors;
    this.emit('change', state);
  }
  getState(id: string): InternalState {
    return this.states.get(id) ?? defaultState(id);
  }
  setState(id: string, patch: Partial<InternalState>): InternalState {
    const next = { ...this.getState(id), ...patch, id };
    this.states.set(id, next);
    this.emit('change', next);
    return next;
  }
  allStates(): ProcessEntry[] {
    const entries: ProcessEntry[] = [];
    for (const group of this.configStore.listGroups()) {
      for (const command of group.commands) {
        entries.push({
          ...publicState(this.getState(`cmd:${group.id}:${command.id}`)),
          group,
          target: command,
          kind: 'command',
        });
      }
      for (const action of group.actions) {
        entries.push({
          ...publicState(this.getState(`act:${group.id}:${action.id}`)),
          group,
          target: action,
          kind: 'action',
        });
      }
    }
    return entries;
  }
  private readonly logSeqs = new Map<string, number>();
  private resolveLogLimit(resolved: ResolvedTarget): number {
    if (resolved.kind === 'command' && resolved.target.maxLogLines != null)
      return resolved.target.maxLogLines;
    return (
      this.configStore.getGlobalSettings().maxLogLines ||
      DEFAULT_LOG_BUFFER_LIMIT
    );
  }
  start(processId: string): { ok: boolean; error?: string | undefined } {
    const resolved = this.resolveTarget(processId);
    if (!resolved) return { ok: false, error: 'Process not found' };
    const { group, target, kind } = resolved,
      current = this.getState(processId);
    if (current.status === 'running') return { ok: true };
    if (!target.command) {
      this.setState(processId, {
        status: 'stopped',
        lastError: 'No command configured',
      });
      return { ok: false, error: 'No command configured' };
    }
    const cwd =
        expandTilde(('cwd' in target ? target.cwd : null) || group.path) ||
        process.cwd(),
      // Windows: cmd.exe-compatible quoting (MSVCRT double quotes + ^
      // escapes). The POSIX builder's single quotes are meaningless to
      // cmd, and its raw join for metacharacter args would let `>`/`&`
      // become redirects and chains in cmd /c.
      cmdline = isWin
        ? buildCmdlineWindows(target.command, target.args)
        : buildCmdline(target.command, target.args),
      spawnSpec = buildSpawnArgs(cmdline);
    const spawnEnv = resolveSpawnEnv(resolved);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spawnSpec.file, spawnSpec.args, {
        cwd,
        env: spawnEnv,
        shell: false,
        ...serviceSpawnOptions(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState(processId, { status: 'stopped', lastError: message });
      return { ok: false, error: message };
    }
    const warnRegex = kind === 'command' ? safeRegex(target.warnRegex) : null,
      errorRegex = kind === 'command' ? safeRegex(target.errorRegex) : null;
    let initWindow = true;
    setTimeout(() => {
      initWindow = false;
    }, 1500);
    const logLimit = this.resolveLogLimit(resolved);
    this.logs.set(processId, []);
    this.states.set(processId, {
      ...defaultState(processId),
      status: 'running',
      startedAt: Date.now(),
      child,
      logLimit,
    });
    this.pushLog(processId, {
      ts: Date.now(),
      stream: 'sys',
      level: null,
      line: `▶ start: ${spawnSpec.description}  (cwd=${cwd})`,
    });
    this.emit('change', this.getState(processId));
    const handleLine =
      (stream: 'stdout' | 'stderr') =>
      (line: string): void => {
        const state = this.states.get(processId);
        if (
          !state ||
          isShellNoise(line) ||
          (initWindow && stripAnsi(line).trim() === '')
        )
          return;
        let detected: LogLevel | null = null;
        if (kind === 'command') {
          if (errorRegex?.test(line)) detected = 'error';
          else if (warnRegex?.test(line)) detected = 'warn';
        }
        let silenced = false;
        if (detected) {
          const fresh = this.resolveTarget(processId);
          const patterns =
            fresh?.kind === 'command'
              ? fresh.target.silencedPatterns[detected]
              : [];
          const cleaned = stripAnsi(line);
          silenced = patterns.some((pattern) =>
            matchesPattern(pattern, cleaned),
          );
          if (!silenced) {
            if (detected === 'error') state.errorCount++;
            else state.warnCount++;
          }
        }
        this.pushLog(processId, {
          ts: Date.now(),
          stream,
          level: silenced ? null : detected,
          originalLevel: detected,
          silenced,
          line,
        });
        if (detected && !silenced) this.emit('change', state);
      };
    readline
      .createInterface({ input: child.stdout })
      .on('line', handleLine('stdout'));
    readline
      .createInterface({ input: child.stderr })
      .on('line', handleLine('stderr'));
    child.on('error', (error) => {
      this.pushLog(processId, {
        ts: Date.now(),
        stream: 'sys',
        level: 'error',
        line: `✕ spawn error: ${error.message}`,
      });
      this.setState(processId, {
        status: 'stopped',
        lastError: `spawn error: ${error.message}`,
        child: null,
      });
    });
    child.on('exit', (code, signal) => {
      const state = this.states.get(processId);
      if (!state || state.child !== child) return;
      const killed =
        signal === 'SIGTERM' ||
        signal === 'SIGKILL' ||
        (child.pid != null && this.killRequested.delete(child.pid));
      this.pushLog(processId, {
        ts: Date.now(),
        stream: 'sys',
        level: killed ? null : code !== 0 ? 'error' : null,
        // On Windows the kill arrives via taskkill with a NULL signal (the
        // killRequested set is win-only, so a signalless killed exit can
        // only be a taskkill) — label it instead of logging "(null)".
        line: killed
          ? `■ stopped (${signal ?? 'taskkill'})`
          : `■ exited with code ${code}`,
      });
      if (kind === 'action' || kind === 'prescript') {
        this.setState(processId, {
          status: 'done',
          lastError: killed
            ? null
            : code !== 0
              ? `exited with code ${code}`
              : null,
          lastExitCode: code,
          lastFinishedAt: Date.now(),
          child: null,
        });
        this.emit('action:done', { processId, code, group, target });
      } else
        this.setState(processId, {
          status: 'stopped',
          lastError: killed
            ? null
            : code !== 0
              ? `exited with code ${code}`
              : null,
          lastFinishedAt: Date.now(),
          child: null,
        });
    });
    return { ok: true };
  }
  /**
   * Stops every running service. A service whose stop FAILED (kill error or
   * the 6.5 s give-up) keeps its running state + handle: it is reported in
   * `failed`, so callers can refuse to proceed on a half-stopped fleet
   * (config import) or log what is still alive (shutdown) — the entry also
   * survives for a later stop() to retry/escalate.
   */
  async stopAll(): Promise<{ ok: boolean; failed: string[] }> {
    const running = [...this.states]
      .filter(([, state]) => state.status === 'running' && state.child)
      .map(([id]) => id);
    const results = await Promise.all(
      running.map(async (id) => ({ id, result: await this.stop(id) })),
    );
    const failed = results.filter((r) => !r.result.ok).map((r) => r.id);
    // Confirmed-stopped entries (including earlier stopped ones) release
    // their state and log buffers; failed running ones are kept on purpose.
    for (const [id, state] of [...this.states]) {
      if (state.status !== 'running' || !state.child) {
        this.states.delete(id);
        this.logs.delete(id);
      }
    }
    return { ok: failed.length === 0, failed };
  }
  async stop(id: string): Promise<{ ok: boolean; error?: string | undefined }> {
    const state = this.states.get(id);
    if (!state?.child || state.status !== 'running') {
      this.setState(id, { status: 'stopped', child: null });
      return { ok: true };
    }
    const child = state.child;
    // Windows-only: on macOS/Linux the kill arrives as a signal, which the
    // exit handler sees directly (see killRequested).
    if (isWin && child.pid != null) this.killRequested.add(child.pid);
    return new Promise((resolve) => {
      let settled = false;
      const timers = new Set<NodeJS.Timeout>();
      const finish = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        // Drop the pid BEFORE resolving: the 6.5 s give-up path settles
        // while the child is still alive, so its later exit may run
        // against a replaced state and never delete it — a stale entry
        // could then match a reused pid.
        if (child.pid != null) this.killRequested.delete(child.pid);
        for (const timer of timers) clearTimeout(timer);
        if (!ok) {
          // Failed stop (kill error or the 6.5 s give-up): the child may
          // still be alive. Keep it tracked as RUNNING with its handle so
          // a later start() cannot launch a duplicate on the same port —
          // the exit handler settles it to stopped when it actually dies.
          if (error) this.setState(id, { lastError: error });
          resolve({ ok: false, error });
          return;
        }
        this.setState(id, { status: 'stopped', child: null });
        resolve({ ok: true });
      };
      timers.add(setTimeout(() => killGroup(child, 'SIGKILL'), 5000));
      timers.add(
        setTimeout(() => {
          // Both kill attempts (initial + the 5 s SIGKILL / taskkill
          // repeat) failed to reap the child. Resolve instead of
          // hanging until the shutdown deadline — the caller can see
          // the failure and the log line from killGroup says why.
          finish(false, 'child still alive after forced kill');
        }, 6500),
      );
      child.once('exit', () => finish(true));
      const error = killGroup(child, 'SIGTERM');
      if (error) finish(false, error.message);
    });
  }
}
