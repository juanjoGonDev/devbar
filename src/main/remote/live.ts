import type { LogEntry } from '../../domain-types.js';
import type { GroupState, PipelineState } from '../../ipc-contract.js';
import type { RemoteDeviceView } from '../../ipc-contract/remote-api.js';
import type {
  RemoteConfirmView,
  RemoteNotice,
  RemoteStateView,
} from '../../ipc-contract/remote-wire.js';
import type { UpdateStatus } from '../../ipc-contract/updates-api.js';
import type { ApiRequest } from './api.js';
import { createEventHub } from './events.js';
import { bannerNotice, createNoticeLog, toastNotice } from './notices.js';
import type { StreamAnswer } from './server.js';
import type { TimerHandle, Timers } from './timers.js';
import { idField, record } from './validate.js';
import { groupViews, logLine, pipelineView, updateView } from './views.js';

/**
 * The live half of «Control remoto»: the /api/events streams and what feeds
 * them. It listens to the same renderer stream the windows hear
 * (`groups:update`, `pipeline:update`, toasts, update pushes, branch
 * changes), to the log lines and to the confirmation queue, and relays each
 * as an SSE event:
 *
 *   state    the whole view, at most every 250 ms (a warn line alone fires
 *            a broadcast, so the raw rate is far too high for a phone);
 *   log      the lines of the process that stream subscribed to;
 *   notice   one new entry of the notice log;
 *   confirm  the pending confirmations, the moment they change;
 *   update   the update summary, debounced like the state.
 *
 * The checked-out branch of each group is cached here (git is a process
 * spawn) and re-read when a repository changes, when a group appears and
 * when a phone opens a stream.
 */

const PUSH_DEBOUNCE_MS = 250;

/** What the app hands the live layer (built in remote-control.ts). */
export interface RemoteRuntime {
  groupStates(): GroupState[];
  pipelineState(): PipelineState;
  currentBranch(groupId: string): Promise<unknown>;
  onLog(listener: (payload: { id: string; entry: LogEntry }) => void): void;
  confirms: {
    pending(): RemoteConfirmView[];
    onChange(listener: () => void): () => void;
  };
  updater: { status(): UpdateStatus; canInstallStaged(): boolean };
  /** Subscribes to the renderer stream the windows hear. */
  onBus(listener: (channel: string, payload: unknown) => void): void;
}

export interface LiveDeps {
  runtime: RemoteRuntime;
  hostInfo(): { name: string; version: string };
  now(): number;
  timers: Timers;
  /** A device opened its first stream or closed its last one. */
  onPresenceChange(deviceId: string): void;
}

export interface Live {
  state(): Promise<RemoteStateView>;
  stream(request: ApiRequest, device: RemoteDeviceView): StreamAnswer;
  notices(): RemoteNotice[];
  notice(banner: { title: string; body: string; action: string | null }): void;
  branchSwitched(groupId: string): void;
  isConnected(deviceId: string): boolean;
  /** Says `unlinked` to that device's streams and closes them. */
  drop(deviceId: string): void;
  close(): void;
}

export function createLive(deps: LiveDeps): Live {
  const { runtime, timers } = deps;
  const hub = createEventHub({
    timers,
    onPresenceChange: (deviceId) => deps.onPresenceChange(deviceId),
  });
  const notices = createNoticeLog({ now: () => deps.now() });
  const branches = new Map<string, string | null>();
  const debounced = new Map<string, TimerHandle>();

  const snapshot = (): RemoteStateView => ({
    now: deps.now(),
    host: deps.hostInfo(),
    groups: groupViews(runtime.groupStates(), branches),
    pipeline: pipelineView(runtime.pipelineState()),
    update: updateView(
      runtime.updater.status(),
      runtime.updater.canInstallStaged(),
    ),
    confirms: runtime.confirms.pending(),
  });

  /** Runs `push` once, 250 ms after the first of a burst of changes. */
  const debounce = (key: string, push: () => void): void => {
    if (!hub.hasClients() || debounced.has(key)) return;
    debounced.set(
      key,
      timers.setTimeout(() => {
        debounced.delete(key);
        if (hub.hasClients()) push();
      }, PUSH_DEBOUNCE_MS),
    );
  };
  const pushState = (): void =>
    debounce('state', () => hub.broadcast('state', snapshot()));

  async function readBranch(groupId: string): Promise<boolean> {
    // git owns its failures (ok: false); a rejection reads the same way.
    const answer = record(
      await runtime.currentBranch(groupId).catch(() => null),
    );
    const branch =
      answer?.ok === true && typeof answer.branch === 'string'
        ? answer.branch
        : null;
    const changed = branches.get(groupId) !== branch;
    branches.set(groupId, branch);
    return changed;
  }

  async function readBranches(groupIds: readonly string[]): Promise<void> {
    const changes = await Promise.all(groupIds.map(readBranch));
    if (changes.includes(true)) pushState();
  }
  const groupIds = (): string[] =>
    runtime.groupStates().map((state) => state.groupId);
  const unknownGroups = (): string[] =>
    groupIds().filter((id) => !branches.has(id));

  const addNotice = (input: Parameters<typeof notices.add>[0]): void => {
    hub.broadcast('notice', notices.add(input));
  };

  runtime.onBus((channel, payload) => {
    if (channel === 'groups:update' || channel === 'pipeline:update') {
      pushState();
      const fresh = unknownGroups();
      if (fresh.length > 0) void readBranches(fresh);
    } else if (channel === 'updates:status' || channel === 'updates:phase') {
      debounce('update', () =>
        hub.broadcast(
          'update',
          updateView(
            runtime.updater.status(),
            runtime.updater.canInstallStaged(),
          ),
        ),
      );
    } else if (channel === 'branches:changed') {
      void readBranches(groupIds());
    } else if (channel === 'groups:toast') {
      const toast = record(payload);
      if (typeof toast?.kind === 'string' && typeof toast.message === 'string')
        addNotice(toastNotice(toast.kind, toast.message));
    }
  });

  runtime.onLog(({ id, entry }) => {
    if (hub.watches(id)) hub.log(id, logLine(entry));
  });

  runtime.confirms.onChange(() => {
    hub.broadcast('confirm', {
      now: deps.now(),
      confirms: runtime.confirms.pending(),
    });
  });

  return {
    state: async () => {
      await readBranches(unknownGroups());
      return snapshot();
    },

    stream: (request, device) => {
      const raw = request.query.get('logs');
      const logsId = raw === null ? null : idField({ raw }, 'raw');
      if (raw !== null && logsId === null)
        return { status: 400, body: { error: 'invalid-request' } };
      if (!hub.canAttach(device.id))
        return { status: 429, body: { error: 'too-many-streams' } };
      return {
        open: (sink) => {
          const client = hub.attach(device.id, logsId, sink);
          if (!client) {
            sink.end();
            return () => undefined;
          }
          client.send('state', snapshot());
          void readBranches(groupIds());
          return () => client.detach();
        },
      };
    },

    notices: () => notices.list(),
    notice: (banner) => addNotice(bannerNotice(banner)),
    branchSwitched: (groupId) => void readBranches([groupId]),
    isConnected: (deviceId) => hub.isConnected(deviceId),
    drop: (deviceId) => hub.drop(deviceId),

    close: () => {
      for (const handle of debounced.values()) timers.clearTimeout(handle);
      debounced.clear();
      hub.closeAll();
    },
  };
}
