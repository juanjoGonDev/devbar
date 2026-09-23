/**
 * The bookkeeping shapes `ProcessManager` keeps per process id, plus the two
 * pure state helpers over them.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  Action,
  Command,
  GlobalSettings,
  Group,
  LogEntry,
  PreScript,
  ProcessState,
} from '../domain-types.js';

export const DEFAULT_LOG_BUFFER_LIMIT = 2000;

export interface ConfigStoreLike {
  getGroup(id: string): Group | null;
  listGroups(): Group[];
  getGlobalSettings(): GlobalSettings;
}

/** `ProcessState` plus the two fields that must never leave the manager. */
export interface InternalState extends ProcessState {
  child: ChildProcessWithoutNullStreams | null;
  logLimit: number;
}

export type ResolvedTarget =
  | { group: Group; target: Command; kind: 'command' }
  | { group: Group; target: Action; kind: 'action' }
  | { group: Group; target: PreScript; kind: 'prescript' };

export interface ProcessEntry extends ProcessState {
  group: Group;
  target: Command | Action;
  kind: 'command' | 'action';
}

export interface ProcessManagerEvents {
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

export function defaultState(id: string): InternalState {
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

/** Everything outside the manager may see — never `child` or `logLimit`. */
export function publicState(state: InternalState): ProcessState {
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
