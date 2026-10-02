import type { GlobalSettings, LogEntry } from '../../domain-types.js';
import type { GroupState, PipelineState } from '../../ipc-contract.js';
import type { UpdateStatus } from '../../ipc-contract/updates-api.js';
import type {
  RemoteGroupView,
  RemoteLogLine,
  RemotePipelineView,
  RemoteSettingsView,
  RemoteUpdateView,
} from '../../ipc-contract/remote-wire.js';
import { stripAnsi } from '../../process/log-filters.js';
import { isBusyPhase, phaseVersion } from '../update-phase.js';

/**
 * The live state as a linked phone may see it. Every view is built field by
 * field from a whitelist — never by spreading a config object — so an env
 * value, a repository path or a regex cannot reach the LAN by accident, even
 * after someone adds a field to the config shapes.
 */

export function groupViews(
  groups: readonly GroupState[],
  branches: ReadonlyMap<string, string | null>,
): RemoteGroupView[] {
  return groups.map((state) => {
    const { group } = state;
    const commandName = (id: string): string =>
      group.commands.find((command) => command.id === id)?.name ?? id;
    const actionName = (id: string): string =>
      group.actions.find((action) => action.id === id)?.name ?? id;
    return {
      id: state.groupId,
      name: group.name,
      color: state.color,
      branch: branches.get(state.groupId) ?? null,
      lastError: state.lastError,
      commands: state.commands.map((command) => ({
        id: command.commandId,
        processId: command.processId,
        name: commandName(command.commandId),
        status: command.status,
        color: command.color,
        warnCount: command.warnCount,
        errorCount: command.errorCount,
        lastError: command.lastError,
        startedAt: command.startedAt,
      })),
      actions: state.actions.map((action) => ({
        id: action.actionId,
        processId: action.processId,
        name: actionName(action.actionId),
        status: action.status,
        lastExitCode: action.lastExitCode,
        startedAt: action.startedAt,
      })),
    };
  });
}

export function pipelineView(pipeline: PipelineState): RemotePipelineView {
  return {
    status: pipeline.status,
    currentStep: pipeline.currentStep,
    totalSteps: pipeline.totalSteps,
    lastError: pipeline.lastError,
  };
}

/**
 * `ready` only when the staged copy can be swapped in without a dialog;
 * anything else that is newer has to be installed from the computer.
 */
export function updateView(
  status: UpdateStatus,
  canInstallStaged: boolean,
): RemoteUpdateView {
  const { phase } = status;
  const base = { currentVersion: status.currentVersion };
  if (phase.state === 'restarting')
    return { ...base, state: 'restarting', version: phase.version };
  if (isBusyPhase(phase))
    return { ...base, state: 'busy', version: phaseVersion(phase) };
  const version = status.available?.version ?? null;
  if (version === null) return { ...base, state: 'current', version };
  return { ...base, state: canInstallStaged ? 'ready' : 'manual', version };
}

export function logLine(entry: LogEntry): RemoteLogLine {
  return {
    seq: entry.seq ?? 0,
    ts: entry.ts,
    level: entry.level,
    line: stripAnsi(entry.line),
  };
}

export function settingsView(settings: GlobalSettings): RemoteSettingsView {
  return {
    autostart: settings.autostart,
    notifySuccess: settings.notifySuccess,
    silenceWarnings: settings.silenceWarnings,
    silenceErrors: settings.silenceErrors,
  };
}
