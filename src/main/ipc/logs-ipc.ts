import type { IpcMainInvokeEvent } from 'electron';
import {
  belongsToMergedScope,
  makeActionId,
  makeCommandId,
  parseProcessId,
} from '../../compound-id.js';
import {
  formatPipelineRunName,
  PIPELINE_LOG_GROUP_ID,
  PIPELINE_LOG_NAME,
} from '../../pipeline-labels.js';
import { mergeNewestByTs } from '../../merge-logs.js';
import { ipcString, type IpcRegistrar } from '../ipc-validators.js';
import type {
  GlobalSettings,
  Group,
  LogEntry,
  ProcessState,
} from '../../domain-types.js';
import type {
  LogListGroup,
  LogListItem,
  LogSource,
  LogsTarget,
} from '../../ipc-contract.js';

/**
 * Reading log buffers: one service, a merged scope, or the whole browsable
 * list. The one rule that has to hold across all of them is that a view never
 * LISTS a buffer the live stream then withholds — which is why membership goes
 * through the same `belongsToMergedScope` the broadcaster uses.
 */

interface LogsProcessManager {
  resolveTarget: (processId: string) => LogsTarget | null;
  getState: (id: string) => ProcessState;
  getLogs: (id: string) => LogEntry[];
  getLogLimit: (id: string) => number;
  getLogSeq: (id: string) => number;
  listLogBuffers: () => Array<{ id: string; lineCount: number }>;
  clearLogs: (id: string) => boolean;
}

export interface LogsIpcDeps {
  configStore: {
    getGroup: (id: string) => Group | null;
    listGroups: () => Group[];
    getGlobalSettings: () => GlobalSettings;
  };
  processManager: LogsProcessManager;
  logWindows: {
    /** True when the request came from the shared multi-log window. */
    isSharedWindowSender: (sender: unknown) => boolean;
    watchSingle: (processId: string) => void;
    watchScope: (groupId: string | null) => void;
  };
}

export function registerLogsIpc(ipc: IpcRegistrar, deps: LogsIpcDeps): void {
  const { configStore, processManager } = deps;

  /**
   * Cap for a merged snapshot. Follows the user's retention setting, like a
   * single log does — a hardcoded number here meant the global view silently
   * ignored the value they had chosen.
   */
  const mergedSnapshotLimit = (): number =>
    configStore.getGlobalSettings().maxLogLines;

  /**
   * Sources of a merged scope: null groupId means every group;
   * `PIPELINE_LOG_GROUP_ID` means the pipeline's own top-level bucket. The
   * pipeline aggregator log is a SIBLING of group buckets — it surfaces in the
   * "every group" view and in its own scope, but never inside a real group's
   * merged view (it belongs to no single group).
   *
   * The pipeline's own scope is a genuine cross-group merge: every pre-script
   * only ever runs through the pipeline, so its merged view must include every
   * one of them, each tagged with its OWN real group and script name — never
   * the pipeline's sentinel. The aggregator itself carries only the pipeline's
   * narration; it never holds a copy of a script's output, so without this a
   * script's lines would have no source of their own here at all.
   */
  const collectMergedSources = (groupId: string | null): LogSource[] => {
    const isPipelineScope = groupId === PIPELINE_LOG_GROUP_ID;
    const groups = isPipelineScope
      ? []
      : groupId
        ? [configStore.getGroup(groupId)].filter((g) => g !== null)
        : configStore.listGroups();
    const sources: LogSource[] = [];
    for (const group of groups) {
      for (const command of group.commands || [])
        sources.push({
          id: makeCommandId(group.id, command.id),
          name: command.name,
          groupId: group.id,
          groupName: group.name,
        });
      for (const action of group.actions || [])
        sources.push({
          id: makeActionId(group.id, action.id),
          name: action.name,
          groupId: group.id,
          groupName: group.name,
        });
    }
    // Pre-scripts only exist once they have run, so they come from the retained
    // buffers rather than from config — the same way `logs:list` finds them.
    const wanted = new Map(groups.map((group) => [group.id, group.name]));
    for (const { id } of processManager.listLogBuffers()) {
      const parsed = parseProcessId(id);
      // Membership is the SHARED rule — the very same call the broadcaster
      // makes — so this view can never list a buffer the live stream then
      // withholds. Only NAMING a source differs by kind below.
      if (!belongsToMergedScope(parsed, groupId)) continue;
      if (parsed.kind === 'prescript') {
        // Always the script's OWN real group, in the pipeline's cross-group
        // view and inside its own group's view alike.
        const resolved = processManager.resolveTarget(id);
        if (resolved && resolved.group) {
          sources.push({
            id,
            name: resolved.target.name,
            groupId: resolved.group.id,
            groupName: resolved.group.name,
          });
          continue;
        }
        // The script is gone but its buffer survives. Inside that group's own
        // view its name is still known, so keep the logs reachable under the
        // raw id rather than dropping them; nothing can name it in the
        // pipeline's cross-group view, where it is skipped.
        const groupName = wanted.get(parsed.groupId);
        if (groupName === undefined) continue;
        sources.push({ id, name: id, groupId: parsed.groupId, groupName });
      } else if (parsed.kind === 'preAggregator') {
        sources.push({
          // Every run lands in the same bucket, so the start time is what tells
          // two of them apart; the bucket keeps the constant name.
          id,
          name: formatPipelineRunName(Number(parsed.runId)),
          groupId: PIPELINE_LOG_GROUP_ID,
          groupName: PIPELINE_LOG_NAME,
        });
      }
    }
    return sources;
  };

  const optionalGroupId = (raw: unknown): string | null =>
    raw === null || raw === undefined ? null : ipcString(raw, 'groupId');

  ipc.handle('logs:get', (event: IpcMainInvokeEvent, rawProcessId: unknown) => {
    const processId = ipcString(rawProcessId, 'processId');
    // Reading the buffer and subscribing to it happen in the same tick, so a
    // line emitted mid-switch cannot land in both the snapshot and the live
    // stream (which would render it twice).
    if (deps.logWindows.isSharedWindowSender(event.sender))
      deps.logWindows.watchSingle(processId);
    const cmdState = processManager.getState(processId);
    return {
      target: processManager.resolveTarget(processId) || {
        kind: 'unknown',
        group: null,
        target: { name: '?' },
      },
      lines: processManager.getLogs(processId),
      logLimit: processManager.getLogLimit(processId),
      seq: processManager.getLogSeq(processId),
      commandState: {
        status: cmdState.status,
        startedAt: cmdState.startedAt,
      },
    };
  });

  // Just the sources, for a merged view that saw a line from a service it did
  // not know about — a pre-script running for the first time since it opened.
  ipc.handle(
    'logs:getMergedSources',
    (_e: IpcMainInvokeEvent, rawGroupId: unknown) =>
      collectMergedSources(optionalGroupId(rawGroupId)),
  );

  ipc.handle(
    'logs:getMerged',
    (event: IpcMainInvokeEvent, rawGroupId: unknown) => {
      // null → every group (the generic telemetry view); otherwise one group.
      const groupId = optionalGroupId(rawGroupId);
      const sources = collectMergedSources(groupId);
      if (deps.logWindows.isSharedWindowSender(event.sender))
        deps.logWindows.watchScope(groupId);

      // Bounded k-way merge, not concatenate-then-sort: this runs on the main
      // thread, and with the cap following the retention setting the naive form
      // would build and order S × maxLogLines objects on every view open.
      const lines = mergeNewestByTs(
        sources.map((source) => ({
          srcId: source.id,
          entries: processManager.getLogs(source.id),
        })),
        mergedSnapshotLimit(),
      );
      const scopeName =
        groupId === PIPELINE_LOG_GROUP_ID
          ? PIPELINE_LOG_NAME
          : groupId
            ? (configStore.getGroup(groupId)?.name ?? '?')
            : 'Telemetría';
      // An empty merged view has no way to explain itself from the renderer:
      // no sources and no buffers look identical on screen.
      console.log(
        `[logs] merged ${groupId ?? 'all'}: ${sources.length} fuentes, ${lines.length} líneas`,
      );
      return {
        groupName: scopeName,
        sources,
        lines,
        seqs: Object.fromEntries(
          sources.map((source) => [
            source.id,
            processManager.getLogSeq(source.id),
          ]),
        ),
      };
    },
  );

  // Really wipe a process's retained log buffer (not just the on-screen view).
  ipc.handle('logs:clear', (_e: IpcMainInvokeEvent, rawProcessId: unknown) => {
    processManager.clearLogs(ipcString(rawProcessId, 'processId'));
    return { ok: true };
  });

  // Every retained log buffer since app start, grouped by group → type, for the
  // Logs browser. Each item opens in the normal logs window via its processId.
  ipc.handle('logs:list', (): LogListGroup[] => {
    const lineCounts = new Map(
      processManager
        .listLogBuffers()
        .map(({ id, lineCount }) => [id, lineCount] as const),
    );
    const groups = new Map<string, LogListGroup>();
    const groupEntry = (groupId: string): LogListGroup => {
      let entry = groups.get(groupId);
      if (!entry) {
        const group = configStore.getGroup(groupId);
        entry = {
          groupId,
          groupName: group ? group.name : '(grupo eliminado)',
          groupIcon: group ? group.icon : '📁',
          items: [],
        };
        groups.set(groupId, entry);
      }
      return entry;
    };
    // The pipeline aggregator log's own top-level bucket — a sibling of every
    // group bucket, never nested under one.
    const pipelineEntry = (): LogListGroup => {
      let entry = groups.get(PIPELINE_LOG_GROUP_ID);
      if (!entry) {
        entry = {
          groupId: PIPELINE_LOG_GROUP_ID,
          groupName: PIPELINE_LOG_NAME,
          groupIcon: '🧬',
          items: [],
        };
        groups.set(PIPELINE_LOG_GROUP_ID, entry);
      }
      return entry;
    };
    const item = (
      id: string,
      type: LogListItem['type'],
      name: string,
      icon: string | null,
    ): LogListItem => {
      const state = processManager.getState(id);
      return {
        id,
        type,
        name,
        icon,
        lineCount: lineCounts.get(id) ?? 0,
        status: state.status,
        warnCount: state.warnCount,
        errorCount: state.errorCount,
        startedAt: state.startedAt,
        lastFinishedAt: state.lastFinishedAt,
        logLimit: processManager.getLogLimit(id),
      };
    };

    // Everything configured, whether or not it has ever run — the logs window
    // doubles as a launcher, so a command with no buffer still needs a row.
    for (const group of configStore.listGroups()) {
      const entry = groupEntry(group.id);
      for (const command of group.commands)
        entry.items.push(
          item(
            makeCommandId(group.id, command.id),
            'command',
            command.name,
            command.icon,
          ),
        );
      for (const action of group.actions)
        entry.items.push(
          item(
            makeActionId(group.id, action.id),
            'action',
            action.name,
            action.icon,
          ),
        );
    }
    // Pre-script and pipeline buffers only exist once they have run.
    for (const id of lineCounts.keys()) {
      const parsed = parseProcessId(id);
      if (parsed.kind === 'prescript') {
        const resolved = processManager.resolveTarget(id);
        groupEntry(parsed.groupId).items.push(
          item(id, 'prescript', resolved ? resolved.target.name : id, null),
        );
      } else if (parsed.kind === 'preAggregator') {
        pipelineEntry().items.push(
          item(
            id,
            'pipeline',
            formatPipelineRunName(Number(parsed.runId)),
            null,
          ),
        );
      }
    }
    return [...groups.values()];
  });
}
