import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { expandTilde, enhancedEnv } from './path-helper.js';
import { buildCmdline } from './parse-command.js';
import { parseProcessId } from './compound-id.js';
import { materializeEnv } from './groups-model.js';
import type {
  Action,
  Command,
  GlobalSettings,
  Group,
  LogEntry,
  LogLevel,
  PreScript,
  ProcessState,
} from './domain-types.js';
import type { TrayColor } from './tray-icon.js';

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
function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}
function isShellNoise(line: string): boolean {
  const clean = stripAnsi(line).trim();
  return (
    Boolean(clean) &&
    SHELL_NOISE_PATTERNS.some((pattern) => pattern.test(clean))
  );
}
function safeRegex(source: string | null | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}
function matchesPattern(pattern: string, cleaned: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes('\\')) return cleaned.includes(pattern);
  const regex = safeRegex(pattern);
  return regex ? regex.test(cleaned) : cleaned.includes(pattern);
}

interface ConfigStoreLike {
  getGroup(id: string): Group | null;
  listGroups(): Group[];
  getGlobalSettings(): GlobalSettings;
}
interface InternalState extends ProcessState {
  child: ChildProcessWithoutNullStreams | null;
  logLimit: number;
}
type ResolvedTarget =
  | { group: Group; target: Command; kind: 'command' }
  | { group: Group; target: Action; kind: 'action' }
  | { group: Group; target: PreScript; kind: 'prescript' };
export interface ProcessEntry extends ProcessState {
  group: Group;
  target: Command | Action;
  kind: 'command' | 'action';
}
interface ProcessManagerEvents {
  log: [payload: { id: string; entry: LogEntry }];
  change: [state: InternalState];
  'action:done': [
    payload: {
      processId: string;
      code: number | null;
      group: Group;
      target: Action | PreScript;
    },
  ];
}
function defaultState(id: string): InternalState {
  return {
    id,
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: null,
    lastExitCode: null,
    lastFinishedAt: null,
    child: null,
    logLimit: DEFAULT_LOG_BUFFER_LIMIT,
  };
}

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private readonly states = new Map<string, InternalState>();
  private readonly logs = new Map<string, LogEntry[]>();
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
    const step = group.preSteps.find(
      (candidate) => candidate.id === parsed.stepId,
    );
    const target = step?.scripts.find(
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
          ...this.publicState(this.getState(`cmd:${group.id}:${command.id}`)),
          group,
          target: command,
          kind: 'command',
        });
      }
      for (const action of group.actions) {
        entries.push({
          ...this.publicState(this.getState(`act:${group.id}:${action.id}`)),
          group,
          target: action,
          kind: 'action',
        });
      }
    }
    return entries;
  }
  private publicState(state: InternalState): ProcessState {
    const {
      id,
      status,
      warnCount,
      errorCount,
      lastError,
      startedAt,
      lastExitCode,
      lastFinishedAt,
    } = state;
    return {
      id,
      status,
      warnCount,
      errorCount,
      lastError,
      startedAt,
      lastExitCode,
      lastFinishedAt,
    };
  }
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
      cmdline = buildCmdline(target.command, target.args),
      shell = process.env.SHELL || '/bin/zsh';
    let spawnEnv: NodeJS.ProcessEnv;
    if (kind === 'command')
      spawnEnv = enhancedEnv({
        ...process.env,
        ...materializeEnv(group.env),
        ...materializeEnv(target.env),
      });
    else {
      let env = { ...process.env };
      if (target.inheritGroupEnv)
        env = { ...env, ...materializeEnv(group.env) };
      spawnEnv = enhancedEnv({ ...env, ...materializeEnv(target.env) });
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell, ['-ic', cmdline], {
        cwd,
        env: spawnEnv,
        shell: false,
        detached: true,
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
      line: `▶ start: ${shell} -ic '${cmdline}'  (cwd=${cwd})`,
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
      const killed = signal === 'SIGTERM' || signal === 'SIGKILL';
      this.pushLog(processId, {
        ts: Date.now(),
        stream: 'sys',
        level: killed ? null : code !== 0 ? 'error' : null,
        line: killed ? `■ stopped (${signal})` : `■ exited with code ${code}`,
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
  async stopAll(): Promise<void> {
    const running = [...this.states]
      .filter(([, state]) => state.status === 'running' && state.child)
      .map(([id]) => id);
    await Promise.all(running.map((id) => this.stop(id)));
    this.states.clear();
    this.logs.clear();
  }
  async stop(id: string): Promise<{ ok: boolean; error?: string | undefined }> {
    const state = this.states.get(id);
    if (!state?.child || state.status !== 'running') {
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
      const error = killGroup(child, 'SIGTERM');
      if (error) {
        clearTimeout(timer);
        this.setState(id, {
          status: 'stopped',
          child: null,
          lastError: error.message,
        });
        resolve({ ok: false, error: error.message });
      }
    });
  }
}
function killGroup(
  child: ChildProcessWithoutNullStreams | null,
  signal: NodeJS.Signals,
): Error | null {
  if (!child?.pid) return null;
  try {
    process.kill(-child.pid, signal);
    return null;
  } catch {
    try {
      child.kill(signal);
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}
export function deriveColor(
  state: Pick<
    ProcessState,
    'status' | 'lastError' | 'errorCount' | 'warnCount'
  >,
  command: Partial<Command> | null | undefined,
  group: Partial<Group> | null | undefined,
  globals: Partial<GlobalSettings> | null | undefined,
): TrayColor {
  if (state.status !== 'running') return state.lastError ? 'error' : 'stopped';
  const muteError = Boolean(
      globals?.silenceErrors || group?.silenceErrors || command?.silenceErrors,
    ),
    muteWarn = Boolean(
      globals?.silenceWarnings ||
      group?.silenceWarnings ||
      command?.silenceWarnings,
    );
  if (state.errorCount > 0 && !muteError) return 'error';
  if (state.warnCount > 0 && !muteWarn) return 'warn';
  return 'running';
}
