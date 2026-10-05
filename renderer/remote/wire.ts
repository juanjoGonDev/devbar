import type { ProcessStatus } from '../../src/domain-types.js';
import type {
  RemoteActionView,
  RemoteCommandView,
  RemoteConfirmView,
  RemoteDot,
  RemoteGroupView,
  RemoteLogLine,
  RemoteNotice,
  RemoteNoticeKind,
  RemotePipelineView,
  RemoteSettingsView,
  RemoteStateView,
  RemoteUpdateView,
} from '../../src/ipc-contract/remote-wire.js';

/**
 * Every payload the server sends, narrowed from `unknown` into the wire
 * shapes of src/ipc-contract/remote-wire.ts. A missing or malformed field
 * falls back to a harmless default and a malformed list entry is dropped, so
 * the views never have to second-guess what they paint — and a newer server
 * talking to a page that is still loaded cannot crash it.
 */

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : {};
}
const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
/** The entries that are objects with a string id, each narrowed. */
function list<T>(value: unknown, item: (raw: Raw) => T, key = 'id'): T[] {
  return (Array.isArray(value) ? value : [])
    .filter(
      (entry): entry is Raw =>
        isRecord(entry) && typeof entry[key] === 'string',
    )
    .map(item);
}

const DOTS: readonly RemoteDot[] = ['stopped', 'running', 'warn', 'error'];
const STATUSES: readonly ProcessStatus[] = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
  'done',
];

const command = (raw: Raw): RemoteCommandView => ({
  id: str(raw.id),
  processId: str(raw.processId),
  name: str(raw.name),
  status: oneOf(raw.status, STATUSES, 'stopped'),
  color: oneOf(raw.color, DOTS, 'stopped'),
  warnCount: num(raw.warnCount),
  errorCount: num(raw.errorCount),
  lastError: strOrNull(raw.lastError),
  startedAt: numOrNull(raw.startedAt),
});

const action = (raw: Raw): RemoteActionView => ({
  id: str(raw.id),
  processId: str(raw.processId),
  name: str(raw.name),
  status: oneOf(raw.status, [...STATUSES, 'idle'] as const, 'idle'),
  lastExitCode: numOrNull(raw.lastExitCode),
  startedAt: numOrNull(raw.startedAt),
});

const group = (raw: Raw): RemoteGroupView => ({
  id: str(raw.id),
  name: str(raw.name),
  color: oneOf(raw.color, DOTS, 'stopped'),
  branch: strOrNull(raw.branch),
  lastError: strOrNull(raw.lastError),
  commands: list(raw.commands, command),
  actions: list(raw.actions, action),
});

function pipeline(value: unknown): RemotePipelineView {
  const raw = record(value);
  return {
    status: oneOf(raw.status, ['running', 'done', 'error', 'idle'], 'idle'),
    currentStep: numOrNull(raw.currentStep),
    totalSteps: num(raw.totalSteps),
    lastError: strOrNull(raw.lastError),
  };
}

export function updateView(value: unknown): RemoteUpdateView {
  const raw = record(value);
  return {
    currentVersion: str(raw.currentVersion),
    state: oneOf(
      raw.state,
      ['current', 'ready', 'manual', 'busy', 'restarting'],
      'current',
    ),
    version: strOrNull(raw.version),
  };
}

const confirm = (raw: Raw): RemoteConfirmView => ({
  token: str(raw.token),
  name: str(raw.name),
  command: str(raw.command),
  groupName: strOrNull(raw.groupName),
  secs: numOrNull(raw.secs),
  onTimeout: oneOf(raw.onTimeout, ['confirm', 'cancel'], 'cancel'),
  deadline: numOrNull(raw.deadline),
});

export function stateView(value: unknown): RemoteStateView {
  const raw = record(value);
  const host = record(raw.host);
  return {
    now: num(raw.now),
    host: { name: str(host.name), version: str(host.version) },
    groups: list(raw.groups, group),
    pipeline: pipeline(raw.pipeline),
    update: updateView(raw.update),
    confirms: list(raw.confirms, confirm, 'token'),
  };
}

export function confirmsView(value: unknown): {
  now: number;
  confirms: RemoteConfirmView[];
} {
  const raw = record(value);
  return { now: num(raw.now), confirms: list(raw.confirms, confirm, 'token') };
}

const KINDS: readonly RemoteNoticeKind[] = [
  'error',
  'success',
  'scheduled',
  'update',
  'info',
];

export function noticeView(value: unknown): RemoteNotice | null {
  const raw = record(value);
  if (typeof raw.id !== 'number') return null;
  return {
    id: raw.id,
    ts: num(raw.ts),
    kind: oneOf(raw.kind, KINDS, 'info'),
    title: str(raw.title),
    body: str(raw.body),
  };
}

export function noticesView(value: unknown): RemoteNotice[] {
  const notices = record(value).notices;
  return (Array.isArray(notices) ? notices : [])
    .map(noticeView)
    .filter((notice): notice is RemoteNotice => notice !== null);
}

function logLines(value: unknown): RemoteLogLine[] {
  return (Array.isArray(value) ? value : [])
    .filter(
      (entry): entry is Raw => isRecord(entry) && typeof entry.seq === 'number',
    )
    .map((raw) => ({
      seq: num(raw.seq),
      ts: num(raw.ts),
      level: raw.level === 'warn' || raw.level === 'error' ? raw.level : null,
      line: str(raw.line),
    }));
}

/** A `log` event, or the answer of the `logs` call (which also has `seq`). */
export function logBatch(value: unknown): {
  id: string;
  lines: RemoteLogLine[];
} {
  const raw = record(value);
  return { id: str(raw.id), lines: logLines(raw.lines) };
}

export function settingsView(value: unknown): RemoteSettingsView {
  const raw = record(value);
  return {
    autostart: raw.autostart === true,
    notifySuccess: raw.notifySuccess === true,
    silenceWarnings: raw.silenceWarnings === true,
    silenceErrors: raw.silenceErrors === true,
  };
}
