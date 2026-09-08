import type {
  Action,
  AvailableUpdate,
  Command,
  GlobalSettings,
  Group,
  LogEntry,
  PreScript,
  PreStep,
  ProcessStatus,
  ReleaseSummary,
  SilencedPatterns,
  StagedUpdate,
} from './domain-types.js';

export type SilenceLevel = 'warn' | 'error';
export type TrayColor = 'stopped' | 'running' | 'warn' | 'error';
type SimpleResult =
  | { ok: true }
  | {
      ok: false;
      error?: string | undefined;
      canceled?: boolean;
      cancelled?: boolean;
    };
export interface CommandRuntimeState {
  commandId: string;
  processId: string;
  status: ProcessStatus;
  warnCount: number;
  errorCount: number;
  lastError: string | null;
  startedAt: number | null;
  color: TrayColor;
  muteWarn: boolean;
  muteErr: boolean;
}
export interface ActionRuntimeState {
  actionId: string;
  processId: string;
  status: ProcessStatus | 'idle';
  lastExitCode: number | null;
  lastFinishedAt: number | null;
  startedAt: number | null;
}
export interface GroupState {
  groupId: string;
  group: Group;
  currentBranch: string | null;
  color: TrayColor;
  commands: CommandRuntimeState[];
  actions: ActionRuntimeState[];
  lastError: string | null;
  preScriptsStatus: 'running' | 'done' | 'error' | 'idle';
  preScriptsCurrentStep: number | null;
  preScriptsTotalSteps: number;
  preScriptsLastError: string | null;
  preScriptsLastRunId: string | null;
  preScriptsStartedAt: number | null;
}
export type LogsTarget =
  | { kind: 'command'; group: Group; target: Command }
  | { kind: 'action'; group: Group; target: Action }
  | { kind: 'prescript'; group: Group; target: PreScript }
  | { kind: 'unknown'; group: null; target: { name: string } };
interface LogsSnapshot {
  target: LogsTarget;
  lines: LogEntry[];
  /** What main actually retains for this target, frozen at start. */
  logLimit: number;
  /** How far the buffer's count had got — the snapshot/stream boundary. */
  seq: number;
  commandState: { status: ProcessStatus; startedAt: number | null };
}
/** A log line that knows which service in the group produced it. */
export type SourcedLogEntry = LogEntry & { srcId: string };
/** One source in a merged stream, and the group it belongs to. */
export interface LogSource {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
}
/** Several services merged into a single chronological stream. */
interface GroupLogsSnapshot {
  groupName: string;
  sources: LogSource[];
  lines: SourcedLogEntry[];
  /** Per source, how far its count had got — the snapshot/stream boundary. */
  seqs: Record<string, number>;
}
export interface LogListItem {
  id: string;
  type: 'command' | 'action' | 'prescript' | 'pipeline';
  name: string;
  icon: string | null;
  lineCount: number;
  status: ProcessStatus;
  warnCount: number;
  errorCount: number;
  startedAt: number | null;
  lastFinishedAt: number | null;
  /** What main actually retains for this item, frozen at start. */
  logLimit: number;
}
export interface LogListGroup {
  groupId: string;
  groupName: string;
  groupIcon: string;
  items: LogListItem[];
}
export interface IconBatteryItem {
  emoji: string;
  label: string;
  group: string;
  keywords?: readonly string[];
}
export interface UpdateStatus {
  available: AvailableUpdate | null;
  /** Downloaded and unpacked — applying it is just a restart. */
  staged: StagedUpdate | null;
  lastCheckAt: string | null;
  currentVersion: string;
}
export interface ImportPreview {
  groupsCount: number;
  commandsCount: number;
  actionsCount: number;
  preStepsCount: number;
  preScriptsCount: number;
  hasGlobalSettings: boolean;
}
export interface PrescriptConfirmContext {
  name: string;
  command: string;
  secs: number | null;
  onTimeout: 'confirm' | 'cancel';
  logo: string | null;
}
interface ChangelogPayload {
  releases: ReleaseSummary[];
  repoUrl: string;
}
interface SilencedCommandPayload {
  ok: boolean;
  error?: string | undefined;
  group?: { id: string; name: string } | undefined;
  command?:
    | { id: string; name: string; silencedPatterns: SilencedPatterns }
    | undefined;
}
interface BranchListResult {
  ok: boolean;
  branches?: string[] | undefined;
  error?: string | undefined;
}
interface BranchResult {
  ok: boolean;
  branch?: string | undefined;
  error?: string | undefined;
}
interface ProcessResult {
  ok: boolean;
  error?: string | undefined;
  cancelled?: boolean | undefined;
  processId?: string | undefined;
}
interface ExportResult {
  ok: boolean;
  path?: string | undefined;
  error?: string | undefined;
  canceled?: boolean | undefined;
}
interface ImportResult {
  ok: boolean;
  token?: string | undefined;
  preview?: ImportPreview | undefined;
  path?: string | undefined;
  error?: string | undefined;
  canceled?: boolean | undefined;
}
interface ApplyImportResult {
  ok: boolean;
  backupPath?: string | undefined;
  error?: string | undefined;
}
type NotificationAction = string;

/**
 * Simulation hooks for events that are painful to reproduce by hand. The
 * invokers always exist; the handlers behind them ship only when the dev panel
 * does — any dev run, or a `DEVBAR_DEV_PANEL=1` package — so each call rejects
 * in a normal build.
 */
interface DevSimulationApi {
  simulateUpdate(version?: string): Promise<{ ok: boolean; version: string }>;
  /** The real thing: builds a bundle one minor up and stages it for install. */
  simulateRealUpdate(): Promise<{
    ok: boolean;
    version?: string;
    error?: string;
  }>;
  clearUpdate(): Promise<SimpleResult>;
  simulateTrayColor(color: TrayColor | null): Promise<SimpleResult>;
  simulateBanner(withCta: boolean): Promise<SimpleResult>;
  simulateFallbackBanner(withCta: boolean): Promise<SimpleResult>;
  simulateSuccess(): Promise<SimpleResult>;
  simulatePrescriptConfirm(): Promise<SimpleResult>;
  simulateToast(kind: 'ok' | 'error'): Promise<SimpleResult>;
}

export interface DevBarApi {
  listGroups(): Promise<Group[]>;
  getGroupStates(): Promise<GroupState[]>;
  saveGroup(
    groupData: unknown,
  ): Promise<Group & { _autoStartEnforced: boolean }>;
  deleteGroup(groupId: string): Promise<SimpleResult>;
  reorderGroups(groupIds: string[]): Promise<SimpleResult>;
  saveCommand(groupId: string, commandData: unknown): Promise<Command | null>;
  deleteCommand(groupId: string, commandId: string): Promise<SimpleResult>;
  reorderCommands(groupId: string, commandIds: string[]): Promise<SimpleResult>;
  setCommandAutoStart(
    groupId: string,
    commandId: string,
    enabled: boolean,
  ): Promise<SimpleResult>;
  saveAction(groupId: string, actionData: unknown): Promise<Action | null>;
  deleteAction(groupId: string, actionId: string): Promise<SimpleResult>;
  reorderActions(groupId: string, actionIds: string[]): Promise<SimpleResult>;
  runAction(groupId: string, actionId: string): Promise<ProcessResult>;
  startProcess(processId: string): Promise<ProcessResult>;
  stopProcess(processId: string): Promise<ProcessResult>;
  listBranches(groupId: string): Promise<BranchListResult>;
  currentBranch(groupId: string): Promise<BranchResult>;
  switchBranch(groupId: string, branch: string): Promise<SimpleResult>;
  addSilencePattern(
    groupId: string,
    commandId: string,
    level: SilenceLevel,
    pattern: string,
  ): Promise<{ ok: boolean; command: Command | null }>;
  removeSilencePattern(
    groupId: string,
    commandId: string,
    level: SilenceLevel,
    pattern: string,
  ): Promise<{ ok: boolean; command: Command | null }>;
  setCommandSilence(
    groupId: string,
    commandId: string,
    level: SilenceLevel,
    enabled: boolean,
  ): Promise<{ ok: boolean; command: Command | null }>;
  setGroupSilence(
    groupId: string,
    level: SilenceLevel,
    enabled: boolean,
  ): Promise<{ ok: boolean; group: Group | null }>;
  getLogs(processId: string): Promise<LogsSnapshot>;
  getMergedLogs(groupId: string | null): Promise<GroupLogsSnapshot>;
  /** Sources only, to learn about a service that started after the view. */
  getMergedSources(groupId: string | null): Promise<LogSource[]>;
  clearLogs(processId: string): Promise<SimpleResult>;
  listLogs(): Promise<LogListGroup[]>;
  openConfig(): Promise<SimpleResult>;
  openConfigChangelog(): Promise<SimpleResult>;
  hideTray(): Promise<SimpleResult>;
  onConfigGoto(callback: (target: string) => void): () => void;
  openLogs(
    arg:
      | string
      | { processId: string; filter?: string; detached?: boolean }
      | { scope: 'all'; level?: SilenceLevel }
      | { scope: 'group'; groupId: string; level?: SilenceLevel },
  ): Promise<SimpleResult>;
  openSilenced(groupId: string, commandId: string): Promise<SimpleResult>;
  getSilencedForCommand(
    groupId: string,
    commandId: string,
  ): Promise<SilencedCommandPayload>;
  setTrayHeight(
    height: number,
  ): Promise<{ ok: boolean; applied?: number | undefined }>;
  getSettings(): Promise<GlobalSettings>;
  saveSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings>;
  testNotification(): Promise<SimpleResult>;
  dismissNotification(): Promise<SimpleResult>;
  notificationAction(action: NotificationAction): Promise<SimpleResult>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  applyUpdate(): Promise<Record<string, unknown>>;
  onUpdateStatus(callback: (payload: UpdateStatus) => void): () => void;
  getIconBattery(): Promise<readonly IconBatteryItem[]>;
  exportConfig(): Promise<ExportResult>;
  importConfig(): Promise<ImportResult>;
  confirmImport(args: {
    preview: ImportPreview;
  }): Promise<{ confirmed: boolean }>;
  applyImportedConfig(args: { token: string }): Promise<ApplyImportResult>;
  pickFolder(defaultPath?: string): Promise<{
    ok: boolean;
    path?: string | undefined;
    error?: string | undefined;
    canceled?: boolean | undefined;
  }>;
  runPreScripts(groupId: string): Promise<{
    ok: boolean;
    runId?: number | undefined;
    error?: string | undefined;
    cancelled?: boolean | undefined;
  }>;
  cancelPreScripts(groupId: string): Promise<SimpleResult>;
  savePreStep(groupId: string, data: unknown): Promise<PreStep | null>;
  deletePreStep(groupId: string, stepId: string): Promise<SimpleResult>;
  reorderPreSteps(groupId: string, orderedIds: string[]): Promise<SimpleResult>;
  savePreScript(
    groupId: string,
    stepId: string,
    data: unknown,
  ): Promise<PreScript | null>;
  deletePreScript(
    groupId: string,
    stepId: string,
    scriptId: string,
  ): Promise<SimpleResult>;
  reorderPreScripts(
    groupId: string,
    stepId: string,
    orderedIds: string[],
  ): Promise<SimpleResult>;
  getPrescriptConfirmContext(
    token: string,
  ): Promise<PrescriptConfirmContext | null>;
  resolvePrescriptConfirm(
    token: string,
    decision: 'confirm' | 'cancel',
  ): Promise<SimpleResult>;
  quit(): Promise<SimpleResult>;
  /**
   * Whether this build shipped the dev simulation panel — true for any dev run
   * and for a `DEVBAR_DEV_PANEL=1` package, false for a normal build. Gates
   * loading the panel.
   */
  isDev(): Promise<boolean>;
  /** Dev-only: handlers exist solely while running unpackaged (src/dev). */
  dev: DevSimulationApi;
  getAppVersion(): Promise<string>;
  getChangelog(): Promise<ChangelogPayload>;
  openExternal(url: string): Promise<SimpleResult>;
  /** macOS notification settings, aimed at this app's own row. */
  openNotificationSettings(): Promise<SimpleResult>;
  confirmDirty(
    context: string,
  ): Promise<{ choice: 'cancel' | 'discard' | 'save' }>;
  confirmCloseConfig(): Promise<SimpleResult>;
  onConfigCloseRequested(callback: () => void): () => void;
  buildSilencePattern(line: string | null | undefined): string;
  onUpdate(callback: (payload: GroupState[]) => void): () => void;
  onLog(
    callback: (payload: { id: string; entry: LogEntry }) => void,
  ): () => void;
  onLogsSelect(
    callback: (payload: {
      processId?: string;
      filter?: string;
      scope?: 'all' | 'group';
      groupId?: string | null;
      level?: SilenceLevel | null;
    }) => void,
  ): () => void;
  onBranchesChanged(
    callback: (payload: { repoPath: string }) => void,
  ): () => void;
  onActionDone(
    callback: (payload: { processId: string; code: number | null }) => void,
  ): () => void;
  onToast(
    callback: (payload: { kind: string; message: string }) => void,
  ): () => void;
}

declare global {
  interface Window {
    api: DevBarApi;
  }
}
