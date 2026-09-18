/**
 * One script of one pipeline step: the collaborator contracts it needs, the
 * per-run handle it mutates, and the single `runOne` call that starts the
 * process and settles when it finishes, fails, times out or is declined.
 *
 * Split out of `pre-script-runner.ts` so the step/pipeline sequencing there
 * reads as sequencing, and this one script's lifecycle reads as a lifecycle.
 */
import type {
  Action,
  Group,
  LogEntry,
  PreScript,
  PreStep,
  PreStepScriptRef,
} from '../domain-types.js';
import { makePreScriptId } from '../compound-id.js';
import { formatUptime } from '../format-uptime.js';

export interface ConfigStoreLike {
  getGroup(groupId: string): Group | null;
  getPreSteps(): PreStep[];
}

export interface PreScriptProcessManager {
  pushLog(id: string, entry: LogEntry): void;
  on(
    event: 'log',
    listener: (payload: { id: string; entry: LogEntry }) => void,
  ): unknown;
  on(
    event: 'action:done',
    listener: (payload: {
      processId: string;
      code: number | null;
      group: Group;
      target: Action | PreScript;
    }) => void,
  ): unknown;
  removeListener(
    event: 'log',
    listener: (payload: { id: string; entry: LogEntry }) => void,
  ): unknown;
  removeListener(
    event: 'action:done',
    listener: (payload: {
      processId: string;
      code: number | null;
      group: Group;
      target: Action | PreScript;
    }) => void,
  ): unknown;
  start(processId: string): { ok: boolean; error?: string | undefined };
  stop(processId: string): Promise<{ ok: boolean; error?: string | undefined }>;
}

export type RunnerStatus = 'running' | 'done' | 'error' | 'idle';

export interface RunHandle {
  runId: number;
  aggregatorId: string;
  cancelled: boolean;
  childPids: Set<string>;
  currentStep: number;
  totalSteps: number;
  status: RunnerStatus;
  _timedOutScripts: Set<string>;
}

export interface OneResult {
  ok: boolean;
  code: number | null;
  error?: string | undefined;
  cancelled?: boolean;
  skipped?: boolean;
}

/** Writes one narration line into a log buffer (`pushSysLog` in the runner). */
type PushSysLog = (
  bufferId: string,
  line: string,
  level?: 'warn' | 'error' | null,
) => void;

export interface RunOneDeps {
  processManager: PreScriptProcessManager;
  configStore: ConfigStoreLike;
  /** Pipeline-level narration: the run itself, never one script. */
  pushAggregatorLog: PushSysLog;
  /**
   * Narration ABOUT one script goes into that script's OWN buffer, so the
   * merged view tags it `[Back] [Make setup]` from a real source instead of
   * attributing it to the pipeline. The tag now carries the identity, so the
   * message no longer repeats `Script "Grupo · Script"` in its text.
   */
  pushScriptLog: PushSysLog;
  confirmScript:
    | ((
        script: PreScript,
        group: Group | null,
        groupId: string,
      ) => Promise<boolean>)
    | undefined;
}

/**
 * Resolves `ref` against its OWN group for every run-time concern (script
 * definition, cwd, env) — never the step's or the pipeline's — since a
 * step can now mix refs from different groups. An unresolvable ref (a
 * dangling reference the write-time prune could not catch, e.g. hand-
 * edited JSON) is skipped with a warning rather than failing the step: a
 * leftover ref must not deadlock boot auto-start (D6).
 */
export async function runOne(
  ref: PreStepScriptRef,
  handle: RunHandle,
  deps: RunOneDeps,
): Promise<OneResult> {
  const { processManager, configStore, pushAggregatorLog, pushScriptLog } =
    deps;
  const group = configStore.getGroup(ref.groupId);
  const script = group?.preScripts.find(
    (candidate) => candidate.id === ref.scriptId,
  );
  if (!group || !script) {
    pushAggregatorLog(
      handle.aggregatorId,
      `── Referencia rota (grupo o script inexistente), omitida ──`,
      'warn',
    );
    return { ok: true, code: null, skipped: true };
  }
  const pid = makePreScriptId(ref.groupId, script.id);
  const groupPath = group.path.trim();
  if (!groupPath) {
    // An ordinary per-script failure, not a whole-pipeline abort: siblings
    // already spawned in the same parallel step still complete.
    pushScriptLog(pid, `── Sin ruta configurada en su grupo ──`, 'error');
    return { ok: false, code: -1, error: 'no_group_path' };
  }
  if (script.confirm) {
    const confirmed = deps.confirmScript
      ? await deps.confirmScript(script, group, ref.groupId)
      : false;
    if (!confirmed) {
      pushScriptLog(pid, `── Cancelado por el usuario ──`);
      return {
        ok: false,
        code: -1,
        error: 'confirm_declined',
        cancelled: true,
      };
    }
  }
  handle.childPids.add(pid);
  return new Promise<OneResult>((resolve) => {
    let timeoutToken: NodeJS.Timeout | null = null;
    const scriptStartedAt = Date.now();
    const handler = ({
      processId,
      code,
    }: {
      processId: string;
      code: number | null;
    }): void => {
      if (processId !== pid) return;
      if (timeoutToken) {
        clearTimeout(timeoutToken);
        timeoutToken = null;
      }
      processManager.removeListener('action:done', handler);
      handle.childPids.delete(pid);
      const elapsed = formatUptime(Date.now() - scriptStartedAt),
        ok = code === 0;
      if (!handle._timedOutScripts.has(pid))
        pushScriptLog(
          pid,
          ok
            ? `── Finalizado correctamente (${elapsed}) ──`
            : `── Ha fallado (salida ${code}, ${elapsed}) ──`,
          ok ? null : 'error',
        );
      resolve({ ok, code });
    };
    processManager.on('action:done', handler);
    if (script.timeoutMs) {
      timeoutToken = setTimeout(() => {
        pushScriptLog(
          pid,
          `── Ha excedido el tiempo límite (${formatUptime(Date.now() - scriptStartedAt)}) ──`,
          'error',
        );
        handle._timedOutScripts.add(pid);
        void processManager.stop(pid);
      }, script.timeoutMs);
    }
    pushScriptLog(pid, `── Directorio: ${groupPath} ──`);
    const result = processManager.start(pid);
    if (!result.ok) {
      if (timeoutToken) {
        clearTimeout(timeoutToken);
        timeoutToken = null;
      }
      processManager.removeListener('action:done', handler);
      handle.childPids.delete(pid);
      pushScriptLog(
        pid,
        `── No ha podido arrancar: ${result.error ?? 'error desconocido'} ──`,
        'error',
      );
      resolve({ ok: false, code: -1, error: result.error });
    }
  });
}
