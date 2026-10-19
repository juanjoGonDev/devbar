import type { GlobalSettings, LogEntry } from '../../domain-types.js';
import type { GroupState, WorkflowEntry } from '../../ipc-contract.js';
import type { UpdateStatus } from '../../ipc-contract/updates-api.js';
import type {
  RemoteGroupView,
  RemoteLogLine,
  RemoteSettingsView,
  RemoteUpdateView,
  RemoteWorkflowView,
} from '../../ipc-contract/remote-wire.js';
import { stripAnsi } from '../../process/log-filters.js';
import { trayGroupLayout } from '../../tray-group-layout.js';
import { isBusyPhase, phaseVersion } from '../update-phase.js';

/**
 * The live state as a linked phone may see it. Every view is built field by
 * field from a whitelist — never by spreading a config object — so an env
 * value, a repository path or a regex cannot reach the LAN by accident, even
 * after someone adds a field to the config shapes.
 */

/**
 * The groups in the tray's order: the hidden ones last and flagged, behind
 * the same fold — or left out when the tray does not list them either.
 */
export function groupViews(
  groups: readonly GroupState[],
  branches: ReadonlyMap<string, string | null>,
  showHiddenGroupsFold: boolean,
): RemoteGroupView[] {
  const { shown, folded } = trayGroupLayout(groups, showHiddenGroupsFold);
  return [...shown, ...folded].map((state) => {
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
      hidden: group.hiddenInTray,
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

/**
 * The workflows a phone may see, run and stop: a running one (so it can be
 * stopped), else an enabled one shown on the phone, whatever its trigger.
 */
export function remoteWorkflowVisible(entry: WorkflowEntry): boolean {
  if (entry.running) return true;
  return entry.workflow.enabled && entry.workflow.showInRemote;
}

export function workflowViews(
  entries: readonly WorkflowEntry[],
): RemoteWorkflowView[] {
  return entries
    .filter(remoteWorkflowVisible)
    .map(({ workflow, running, scriptCount, lastRun }) => ({
      id: workflow.id,
      name: workflow.name,
      startup: workflow.trigger.kind === 'startup',
      running: running !== null,
      doneScripts: running ? running.doneScripts : null,
      totalScripts: running ? running.totalScripts : scriptCount,
      lastResult: lastRun ? lastRun.result : null,
      lastFinishedAt: lastRun ? lastRun.finishedAt : null,
    }));
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
