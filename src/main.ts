import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  screen,
  dialog,
  shell,
  powerMonitor,
  nativeTheme,
  nativeImage,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type Rectangle,
  type SaveDialogOptions,
} from 'electron';
import { menubar, type Menubar } from 'menubar';
import { appHome } from './app-paths.js';
import { isDue } from './scheduler.js';
import * as configStore from './config-store.js';
import {
  validateImportedConfig,
  summarizeImport,
  type ImportPayload,
} from './config-io.js';
import { ProcessManager, deriveColor } from './process-manager.js';
import {
  SessionResumeTracker,
  consumeSnapshot,
  type ResumeExitReason,
} from './session-resume.js';
import * as gitManager from './git-manager.js';
import * as trayIcon from './tray-icon.js';
import * as logger from './logger.js';
import {
  checkForUpdate,
  fetchReleases,
  fetchReleaseSha256,
  normalizeArch,
} from './update-check.js';
import {
  canInstallInPlace,
  extractUpdate,
  installedAppPath,
  stageableAsset,
  stageDownloadedArtifact,
  spawnSwap,
  verifySha256,
  windowsUpdateMode,
} from './self-update.js';
import {
  setLinuxAutostart,
  wasOpenedAtLoginFromArgv,
  LOGIN_ARG,
} from './autostart.js';
import { isLinux, isMac, isWin, platformLabel } from './platform.js';
import { loadShellPath, expandTilde } from './path-helper.js';
import { mergeNewestByTs } from './merge-logs.js';
import { RepoWatcher } from './repo-watcher.js';
import {
  makeCommandId,
  makeActionId,
  parseProcessId,
  belongsToMergedScope,
} from './compound-id.js';
import {
  formatPipelineRunName,
  PIPELINE_LOG_GROUP_ID,
  PIPELINE_LOG_NAME,
} from './pipeline-labels.js';
import { createPreScriptRunner } from './pre-script-runner.js';
import {
  planAutoStartRelease,
  withheldGroupIds,
  shouldAutoRunPipeline,
  filterAutoStartEligibleGroups,
  describeWithheldGroups,
  shouldShowGenericFailureToast,
  type AutoStartPlan,
} from './autostart-schedule.js';
import { ICON_BATTERY } from './icon-battery.js';
import type {
  Action,
  AvailableUpdate,
  Command,
  Group,
  PreScript,
  Schedule,
  LogEntry,
  StagedUpdate,
} from './domain-types.js';
import type {
  GroupState,
  ImportPreview,
  LogSource,
  LogListGroup,
  LogListItem,
  PipelineState,
  PrescriptConfirmContext,
  SilenceLevel,
  TrayColor,
} from './ipc-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Whether the development-only simulation panel shipped with this build. One
 * source of truth: the files are either in the bundle or they are not.
 */
const devPanelAvailable = fs.existsSync(
  path.join(__dirname, 'dev', 'dev-ipc.js'),
);
const { aggregateColor } = trayIcon;

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

type UnknownRecord = Record<string, unknown>;
function ipcRecord(value: unknown, label = 'payload'): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid IPC ${label}: expected object`);
  }
  return value as UnknownRecord;
}
function ipcString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`Invalid IPC ${label}: expected string`);
  return value;
}
function ipcStringField(value: unknown, field: string): string {
  return ipcString(ipcRecord(value)[field], field);
}
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  );
}
function ipcStringArrayField(value: unknown, field: string): string[] {
  const candidate = ipcRecord(value)[field];
  if (!isStringArray(candidate))
    throw new TypeError(`Invalid IPC ${field}: expected string[]`);
  return candidate;
}

function ipcBooleanField(value: unknown, field: string): boolean {
  const candidate = ipcRecord(value)[field];
  if (typeof candidate !== 'boolean')
    throw new TypeError(`Invalid IPC ${field}: expected boolean`);
  return candidate;
}
function ipcNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid IPC ${label}: expected finite number`);
  }
  return value;
}
function ipcSilenceLevel(value: unknown): SilenceLevel {
  if (value !== 'warn' && value !== 'error')
    throw new TypeError('Invalid IPC silence level');
  return value;
}
function ipcConfirmDecision(value: unknown): ConfirmDecision {
  if (value !== 'confirm' && value !== 'cancel')
    throw new TypeError('Invalid IPC confirmation decision');
  return value;
}
function ipcImportPreview(value: unknown): ImportPreview {
  const preview = ipcRecord(value, 'import preview');
  const numberField = (
    field: keyof Pick<
      ImportPreview,
      | 'groupsCount'
      | 'commandsCount'
      | 'actionsCount'
      | 'preStepsCount'
      | 'preScriptsCount'
    >,
  ): number => ipcNumber(preview[field], String(field));
  const hasGlobalSettings = preview.hasGlobalSettings;
  if (typeof hasGlobalSettings !== 'boolean')
    throw new TypeError('Invalid IPC hasGlobalSettings');
  return {
    groupsCount: numberField('groupsCount'),
    commandsCount: numberField('commandsCount'),
    actionsCount: numberField('actionsCount'),
    preStepsCount: numberField('preStepsCount'),
    preScriptsCount: numberField('preScriptsCount'),
    hasGlobalSettings,
  };
}
function ipcGlobalSettingsPatch(
  value: unknown,
): Partial<ReturnType<typeof configStore.getGlobalSettings>> {
  const raw = ipcRecord(value, 'settings patch');
  const patch: Partial<ReturnType<typeof configStore.getGlobalSettings>> = {};
  for (const field of [
    'autostart',
    'silenceWarnings',
    'silenceErrors',
    'notifySuccess',
    'preScriptsAutoRun',
  ] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== 'boolean')
        throw new TypeError(`Invalid IPC ${field}`);
      patch[field] = raw[field];
    }
  }
  if (raw['theme'] !== undefined) {
    if (
      raw['theme'] !== 'auto' &&
      raw['theme'] !== 'light' &&
      raw['theme'] !== 'dark'
    )
      throw new TypeError('Invalid IPC theme');
    patch['theme'] = raw['theme'];
  }
  for (const field of ['maxLogLines'] as const) {
    if (raw[field] !== undefined) patch[field] = ipcNumber(raw[field], field);
  }
  return patch;
}

function showMessageBox(
  owner: BrowserWindow | null,
  options: MessageBoxOptions,
) {
  return owner
    ? dialog.showMessageBox(owner, options)
    : dialog.showMessageBox(options);
}

function showOpenDialog(
  owner: BrowserWindow | null,
  options: OpenDialogOptions,
) {
  return owner
    ? dialog.showOpenDialog(owner, options)
    : dialog.showOpenDialog(options);
}

function showSaveDialog(
  owner: BrowserWindow | null,
  options: SaveDialogOptions,
) {
  return owner
    ? dialog.showSaveDialog(owner, options)
    : dialog.showSaveDialog(options);
}

// Keep the app identity consistent across platforms. macOS already gets
// "DevBar" from the bundle (CFBundleName); Windows and Linux would fall back
// to the package.json `name` ("devbar"). The pin moves the name (and, on
// Windows, the default paths); on Linux the XDG directory is resolved at
// process start, so the data locations are pinned explicitly in app-paths.ts
// instead — packaged builds own one per-OS "DevBar" folder for config, logs
// and update staging. (Dev mode is left untouched so existing dev stores
// keep working.)
if (app.isPackaged) app.name = 'DevBar';

loadShellPath();

// ─── File logger ────────────────────────────────────────────────────
// Initialise before anything noisy so we capture early `console.*`
// from the main process. The renderer side is hooked later, when each
// BrowserWindow is created (we need its `webContents` to subscribe).
//
// File lives at app.log under the per-OS log dir: `app.getPath('logs')`
// (~/Library/Logs/DevBar on macOS), or the pinned "DevBar" folder on
// Windows/Linux packaged builds — there app.getPath('logs') would stay
// under the package.json name, splitting logs from config and updates
// (see app-paths.ts). `install-local.sh` drops a symlink at the repo
// root (macOS) so the user can `tail -f app.log` from the workspace.
try {
  const logsDir =
    app.isPackaged && process.platform !== 'darwin'
      ? path.join(appHome(), 'logs')
      : app.getPath('logs');
  logger.init({ filePath: path.join(logsDir, 'app.log') });
  logger.attachMainConsole();
} catch (e) {
  // Logger is best-effort; never block startup.

  console.error('logger init failed:', e);
}

const processManager = new ProcessManager(configStore);

// ── Session resume ─────────────────────────────────────────────────────
// Persists the running set so a restart (reinstall, update, kill, crash)
// can bring the services back. Created in whenReady (needs the app-data
// dir); null until then.
let sessionResume: SessionResumeTracker | null = null;
/** How this exit should be recorded in the snapshot. `quit` is the
 *  default (tray "Salir", `app:quit`, window quits); the signal handler
 *  rewrites it to `kill` and the update flows rewrite it to `update`
 *  right before they quit. A `quit` snapshot is never resumed — a
 *  deliberate stop stays a stop. */
let pendingExitReason: ResumeExitReason = 'quit';
function markUpdateExit(): void {
  pendingExitReason = 'update';
}
/** The command services currently running (actions/pre-scripts never
 *  resume: they are one-shots). */
function runningCommandIds(): string[] {
  return processManager
    .allStates()
    .filter((entry) => entry.kind === 'command' && entry.status === 'running')
    .map((entry) => entry.id);
}

/**
 * Launch: consume the previous session's snapshot and restart what it says
 * was running. Only commands that are still configured, still have a
 * command, and are NOT confirm-gated are started — an unattended launch
 * must never bypass a confirmation gate. The snapshot file is already
 * deleted by `consumeSnapshot` in every branch: this launch had the only
 * right to it, and the content must not outlive the restart (even for the
 * ids that failed to start — the user sees them stopped in the tray).
 */
function resumeSavedServices(): void {
  const canResume = (id: string): boolean => {
    const resolved = processManager.resolveTarget(id);
    if (!resolved || resolved.kind !== 'command') return false;
    if (!resolved.target.command || !resolved.target.command.trim())
      return false;
    return !resolved.target.confirm;
  };
  const decision = consumeSnapshot(appHome(), canResume);
  if (decision.resume.length === 0) return;
  let started = 0;
  for (const id of decision.resume) {
    const result = processManager.start(id);
    if (result.ok) started++;
    else console.warn(`[resume] ${id}: ${result.error ?? 'start failed'}`);
  }
  console.log(
    `[resume] ${started}/${decision.resume.length} services restored (reason: ${decision.reason})`,
  );
  // No window may exist yet (tray app) — then this is a harmless no-op.
  broadcastToast(
    'ok',
    started === decision.resume.length
      ? `Servicios restaurados: ${started}`
      : `Servicios restaurados: ${started} de ${decision.resume.length}`,
  );
}

// ── Pre-script confirmation orchestrator ────────────────────────────────
// Owns ALL Electron concerns for the confirmation gate: the token → pending
// map, the authoritative auto-resolve timer (ADR-1), the global serial modal
// queue (ADR-2), and the frameless BrowserWindow. This is the ONLY place
// with mutable confirm state.
type ConfirmDecision = 'confirm' | 'cancel';
/**
 * `pipeline` = the global pre-script pipeline, cancellable in bulk via
 * `cancelConfirm` below. `interactive` = a manual/scheduled command or
 * action confirmation (`confirmIfNeeded`). Both origins share the SAME
 * serial modal queue (`confirmChain`, ADR-2) and the SAME `pendingConfirms`
 * map — origin only decides which entries `cancelConfirm` may resolve, and
 * which queued jobs `pipelineConfirmGeneration` may pre-empt.
 */
type ConfirmOrigin = 'pipeline' | 'interactive';
interface PendingConfirm {
  resolve: (confirmed: boolean) => void;
  timer: NodeJS.Timeout | null;
  win: BrowserWindow | null;
  context: PrescriptConfirmContext;
  origin: ConfirmOrigin;
}
const pendingConfirms = new Map<string, PendingConfirm>();
const prescriptConfirmWindows = new Map<string, BrowserWindow>();
let confirmChain: Promise<void> = Promise.resolve();
/**
 * Bumped only by a pipeline cancel (`cancelConfirm`), so a PIPELINE job still
 * queued behind `confirmChain` declines instead of showing. An interactive
 * (manual/scheduled command or action) confirmation never consults this
 * counter — the pipeline and an unrelated interactive confirmation happened
 * to share one queue and one counter before, so cancelling the pipeline
 * could silently cancel or invalidate a manual command's confirmation too.
 */
let pipelineConfirmGeneration = 0;
let _prescriptConfirmLogo: string | null = null;

function getPrescriptConfirmLogo(): string {
  if (_prescriptConfirmLogo !== null) return _prescriptConfirmLogo;
  try {
    const p = path.join(__dirname, '..', 'assets', 'icon.png');
    _prescriptConfirmLogo = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (e) {
    _prescriptConfirmLogo = ''; // renderer degrades gracefully (hides <img>)
  }
  return _prescriptConfirmLogo;
}

function resolvePrescriptConfirm(
  token: string,
  decision: ConfirmDecision,
): void {
  const entry = pendingConfirms.get(token);
  if (!entry) return; // no-op guard => double-resolve safe
  pendingConfirms.delete(token); // delete FIRST so a re-entrant close is a no-op
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.win && !entry.win.isDestroyed()) entry.win.close();
  entry.resolve(decision === 'confirm');
}

/**
 * Cancels every pending PIPELINE pre-script confirmation — the pipeline is
 * global now, so a cancel is never scoped to one group. Never touches an
 * `interactive`-origin entry: a manual/scheduled command's or action's
 * confirmation shares the same queue but has nothing to do with a pipeline
 * cancel and must keep running (or keep waiting its turn) unaffected.
 */
function cancelConfirm(): void {
  // Bump FIRST: a pipeline job still queued behind `confirmChain` is not in
  // `pendingConfirms` yet, so without this it would open its modal after
  // the user already cancelled and leave the runner's Promise.all pending.
  pipelineConfirmGeneration += 1;
  for (const [token, entry] of pendingConfirms) {
    if (entry.origin === 'pipeline') resolvePrescriptConfirm(token, 'cancel');
  }
}

function showConfirmModal(
  script: Pick<
    PreScript,
    'name' | 'command' | 'args' | 'confirmSecs' | 'confirmOnTimeout'
  >,
  origin: ConfirmOrigin,
  groupName: string | null,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const token = crypto.randomUUID();
    const entry: PendingConfirm = {
      resolve,
      timer: null,
      win: null,
      origin,
      context: {
        name: script.name,
        command: [script.command, ...(script.args || [])].join(' ').trim(),
        secs: script.confirmSecs, // null => no countdown (indefinite)
        onTimeout: script.confirmOnTimeout, // 'confirm' | 'cancel'
        logo: getPrescriptConfirmLogo(),
        groupName,
      },
    };
    pendingConfirms.set(token, entry);
    entry.win = ensurePrescriptConfirmWindow(token);
    // AUTHORITATIVE auto-resolve timer lives in MAIN (ADR-1) — the renderer's
    // countdown is purely cosmetic and never resolves on its own.
    if (script.confirmSecs != null) {
      entry.timer = setTimeout(
        () => resolvePrescriptConfirm(token, script.confirmOnTimeout),
        script.confirmSecs * 1000,
      );
    }
  });
}

/**
 * Shared enqueue mechanics for BOTH confirm origins: always serializes
 * through the SAME `confirmChain` so only one modal ever shows at a time
 * (ADR-2), regardless of whether the job came from the pipeline or from an
 * interactive command/action. Only a `pipeline` job can be pre-empted while
 * still queued (via `pipelineConfirmGeneration`, bumped by `cancelConfirm`);
 * an `interactive` job always shows when its turn comes up.
 */
function enqueueConfirm(
  script: Pick<
    PreScript,
    'name' | 'command' | 'args' | 'confirmSecs' | 'confirmOnTimeout'
  >,
  origin: ConfirmOrigin,
  groupName: string | null,
): Promise<boolean> {
  const generation = pipelineConfirmGeneration;
  const run = (): Promise<boolean> =>
    origin === 'pipeline' && generation !== pipelineConfirmGeneration
      ? Promise.resolve(false)
      : showConfirmModal(script, origin, groupName); // always resolves boolean, never rejects
  const result = confirmChain.then(run, run);
  confirmChain = result.then(
    () => undefined,
    () => undefined,
  ); // neutralize so the next job is unaffected
  return result;
}

// Injected into the runner. Serializes via confirmChain so only ONE modal
// shows at a time across ALL concurrent group pipelines (global queue).
function confirmScript(
  script: Pick<
    PreScript,
    'name' | 'command' | 'args' | 'confirmSecs' | 'confirmOnTimeout'
  >,
  group: Group | null,
  _groupId: string,
): Promise<boolean> {
  return enqueueConfirm(script, 'pipeline', group?.name ?? null);
}

/**
 * Gate a command/action start behind its optional confirmation modal.
 * Returns true to proceed, false if the user (or the timeout default) declined.
 * `target` is a normalized command or action carrying confirm/confirmSecs/
 * confirmOnTimeout. Reuses the pre-script confirm modal + serial queue, so
 * manual and scheduled starts share one dialog UX. For scheduled runs with
 * nobody watching, confirmOnTimeout decides after the countdown.
 */
function confirmIfNeeded(
  target: Command | Action | null | undefined,
  group: Group | null,
  _groupId: string,
): Promise<boolean> {
  if (!target || !target.confirm) return Promise.resolve(true);
  // origin: 'interactive' — a manual/scheduled confirmation must never be
  // cancelled or pre-empted by an unrelated pipeline cancel (sdd-verify,
  // third round): see `enqueueConfirm`/`cancelConfirm`.
  return enqueueConfirm(
    {
      name: target.name,
      command: target.command,
      args: target.args,
      confirmSecs: target.confirmSecs,
      confirmOnTimeout: target.confirmOnTimeout,
    },
    'interactive',
    group?.name ?? null,
  );
}

// ── Staged auto-start release (D2/D7) ───────────────────────────────────
// Set only while `autoStartAllMarkedCommands` awaits the BOOT-time pipeline
// run; read by `onStepComplete` below to release each eligible group's
// autoStart commands as soon as its LAST referencing step clears. Null the
// rest of the time — including during a manual, tray-triggered run —
// because releasing autoStart commands is exclusively a boot concern, same
// as before this migration.
let activeAutoStartRelease: {
  plan: AutoStartPlan;
  groupsById: ReadonlyMap<string, Group>;
  fired: Set<number>;
} | null = null;

const preScriptRunner = createPreScriptRunner({
  processManager,
  configStore,
  broadcastUpdate: () => broadcast(),
  onStepComplete: ({ stepIndex }) => {
    const active = activeAutoStartRelease;
    if (!active) return;
    active.fired.add(stepIndex);
    for (const groupId of active.plan.releases.get(stepIndex) ?? []) {
      const group = active.groupsById.get(groupId);
      if (group) startGroupAutoStartCommands(group);
    }
  },
  onError: (err: string, _ctx) => {
    // sdd-verify W5: during a boot auto-start run, a more informative toast
    // naming the withheld groups follows right after `run()` resolves
    // (reportWithheldGroups, below) — this generic one would only duplicate
    // it. A manual (non-boot) run, or a boot run that withholds nothing, has
    // no other message coming, so it still needs this one. The decision
    // itself is the pure, tested `shouldShowGenericFailureToast`; reading
    // `activeAutoStartRelease` here is plain main.ts IO glue.
    const active = activeAutoStartRelease;
    const withheldCount = active
      ? withheldGroupIds(active.plan, active.fired).length
      : 0;
    if (
      shouldShowGenericFailureToast({
        isBootRun: active !== null,
        withheldCount,
      })
    ) {
      broadcastToast('error', `Pre-scripts: ${err}`);
    }
  },
  onSuccess: ({ stepCount }: { runId: number; stepCount: number }) => {
    // Pipeline-level messaging now — there is no single "the" group anymore.
    showCompletionNotification(
      'DevBar — pre-scripts',
      `Pipeline completado (${stepCount} paso${stepCount === 1 ? '' : 's'})`,
    );
  },
  confirmScript,
  cancelConfirm,
});

let mb: Menubar | null = null;
let configWindow: BrowserWindow | null = null;
let forceCloseConfig = false;
// Key '@main' is the shared multi-log window (sidebar + one visible log);
// any other key is a processId detached into its own window.
const MAIN_LOGS_KEY = '@main';
const logsWindows = new Map<string, BrowserWindow>();
// Which log the shared window is currently showing — it only receives lines
// for that one, so N running services don't flood it with N streams.
let mainLogsWatching: string | null = null;
/*
 * The merged scope the shared window is showing, or null when it shows one
 * service. `{ groupId: null }` means every group.
 *
 * Gating by SCOPE rather than by a snapshot of ids is what lets a pre-script
 * whose first run starts after the view opened still stream into it — its id
 * cannot be in a set captured beforehand, but its group is known.
 */
let mainLogsScope: { groupId: string | null } | null = null;
/**
 * Cap for a merged snapshot. Follows the user's retention setting, like a
 * single log does — a hardcoded number here meant the global view silently
 * ignored the value they had chosen.
 */
function mergedSnapshotLimit(): number {
  return configStore.getGlobalSettings().maxLogLines;
}
const silencedWindows = new Map<string, BrowserWindow>();
const repoWatcher = new RepoWatcher();

// GitHub repo to check for newer releases, and the result once found.
const UPDATE_REPO = { owner: 'juanjoGonDev', repo: 'devbar' };
let availableUpdate: AvailableUpdate | null = null; // { version, url, dmgUrl, zipUrl } when newer exists
let lastUpdateCheckAt: string | null = null; // ISO of the last completed release check
let updateNotifiedThisLaunch = false; // banner shown at most once per launch
let stagedUpdate: StagedUpdate | null = null; // downloaded, waiting for a restart
let stagingVersion: string | null = null; // download in flight, to avoid duplicates
const stagingFailedVersions = new Set<string>(); // don't retry a bad download all session

// Group-level transient errors (not persisted)
const groupErrors = new Map<string, string | null>();

// Last pipeline run id — one global pipeline now, not one per group. Kept
// beyond the recent-result badge TTL so the tray can still open that run's
// (still-retained) log buffer.
let lastPipelineRunId: string | null = null;

// Action pids started by the scheduler, awaiting their action:done so we can
// fire a completion notification (manual runs don't notify — you're watching).
const scheduledActionPids = new Set<string>();

// Pending import payloads — keyed by opaque token (5-min TTL)
// Prevents renderer from smuggling an unvalidated payload to applyImport.
const pendingImports = new Map<string, ImportPayload>();

// ─────────────────────── State snapshot ──────────────────────────────

/**
 * Build a GroupState[] payload for all groups.
 * Shape per group (D4 broadcast format):
 *   { groupId, group, currentBranch, color, commands[], actions[], lastError? }
 */
function snapshotGroupStates(): GroupState[] {
  const globals = configStore.getGlobalSettings();
  const groups = configStore.listGroups();

  return groups.map((group) => {
    const commandStates = (group.commands || []).map((cmd) => {
      const pid = makeCommandId(group.id, cmd.id);
      const state = processManager.getState(pid);
      const color = deriveColor(state, cmd, group, globals);
      const muteWarn = !!(
        globals.silenceWarnings ||
        group.silenceWarnings ||
        cmd.silenceWarnings
      );
      const muteErr = !!(
        globals.silenceErrors ||
        group.silenceErrors ||
        cmd.silenceErrors
      );
      return {
        commandId: cmd.id,
        processId: pid,
        status: state.status,
        warnCount: state.warnCount,
        errorCount: state.errorCount,
        lastError: state.lastError,
        startedAt: state.startedAt,
        color,
        muteWarn,
        muteErr,
      };
    });

    const actionStates = (group.actions || []).map((act) => {
      const pid = makeActionId(group.id, act.id);
      const state = processManager.getState(pid);
      return {
        actionId: act.id,
        processId: pid,
        status: state.status || 'idle',
        lastExitCode: state.lastExitCode,
        lastFinishedAt: state.lastFinishedAt,
        startedAt: state.startedAt,
      };
    });

    // Aggregate group color: worst over running commands
    let groupColor: TrayColor = 'stopped';
    for (const cs of commandStates) {
      if (cs.status === 'running') {
        if (cs.color === 'error') {
          groupColor = 'error';
          break;
        }
        if (cs.color === 'warn') groupColor = 'warn';
        else if (cs.color === 'running' && groupColor === 'stopped')
          groupColor = 'running';
      }
    }
    // Check lastError on running commands too
    if (groupColor === 'stopped') {
      const anyErr = commandStates.some((cs) => cs.lastError);
      if (anyErr) groupColor = 'error';
    }

    return {
      groupId: group.id,
      group,
      currentBranch: null, // populated async by renderer via git:currentBranch
      color: groupColor,
      commands: commandStates,
      actions: actionStates,
      lastError: groupErrors.get(group.id) || null,
    };
  });
}

/**
 * Runtime state of the ONE global pre-script pipeline (D2/D7). Computed once
 * per broadcast rather than once per group, now that the pipeline itself is
 * global — this is the successor to the "Pre-scripts runtime fields" block
 * that used to live inside `snapshotGroupStates`'s per-group loop.
 */
function snapshotPipelineState(): PipelineState {
  const runState = preScriptRunner.getRunState();
  const recentResult = preScriptRunner.getRecentResult();
  const status = runState
    ? runState.status
    : recentResult
      ? recentResult.status
      : 'idle';
  const currentStep = runState ? runState.currentStep : null;
  const totalSteps = runState
    ? runState.totalSteps
    : configStore.getPreSteps().length;
  const lastError =
    recentResult && recentResult.status === 'error' ? recentResult.error : null;
  // The live run id (running / within the recent-result TTL). Persisted
  // beyond both so the tray's "ver logs del pipeline" button survives after
  // the status badge clears — the aggregator log buffer itself outlives it.
  const liveRunId = runState
    ? String(runState.runId)
    : recentResult
      ? String(recentResult.runId)
      : null;
  if (liveRunId) lastPipelineRunId = liveRunId;
  return {
    status,
    currentStep,
    totalSteps,
    lastError,
    lastRunId: liveRunId || lastPipelineRunId,
    startedAt: runState ? runState.startedAt : null,
  };
}

function broadcast() {
  const payload = snapshotGroupStates();
  for (const wc of rendererTargets()) wc.send('groups:update', payload);
  const pipelinePayload = snapshotPipelineState();
  for (const wc of rendererTargets())
    wc.send('pipeline:update', pipelinePayload);
  updateTrayTitle(payload);
}

function broadcastLog(payload: { id: string; entry: LogEntry }): void {
  const detached = logsWindows.get(payload.id);
  if (detached && !detached.isDestroyed()) {
    detached.webContents.send('logs:line', payload);
  }
  const main = logsWindows.get(MAIN_LOGS_KEY);
  const parsed = parseProcessId(payload.id);
  // Same membership rule the snapshot uses, so the view cannot list a buffer
  // it then never receives lines from.
  const inScope =
    mainLogsScope !== null &&
    belongsToMergedScope(parsed, mainLogsScope.groupId);
  if (
    main &&
    !main.isDestroyed() &&
    (mainLogsWatching === payload.id || inScope)
  ) {
    main.webContents.send('logs:line', payload);
  }
}

function broadcastToast(kind: string, message: string): void {
  for (const wc of rendererTargets()) {
    wc.send('groups:toast', { kind, message });
  }
}

// ── In-app completion banner ────────────────────────────────────────────
// The fallback for when macOS refuses a native notification — chiefly an
// unpackaged dev run, whose bundle keeps Electron's own identity. Duration is
// fixed here rather than configurable: on the path users actually see, macOS
// owns it through the app's notification style (Banners auto-dismiss, Alerts
// stay), and a setting that governs only the fallback would be claiming more
// than it does.
// ponytail: single-slot — a new banner replaces the current one; no stacking.
const BANNER_AUTOCLOSE_SECS = 5;
let notificationWindow: BrowserWindow | null = null;
let notificationTimer: NodeJS.Timeout | null = null;

function closeNotificationWindow() {
  if (notificationTimer) {
    clearTimeout(notificationTimer);
    notificationTimer = null;
  }
  const win = notificationWindow;
  notificationWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

/**
 * Display the user is actually looking at: the focused window's screen, else
 * the screen under the cursor. Using the PRIMARY display made banners always
 * pop on the built-in screen and, worse, yanked the active Space away from a
 * config window living on a second display.
 */
function activeDisplay() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    return screen.getDisplayMatching(focused.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/**
 * A CTA from either notification path (native click or banner button).
 */
function runNotificationAction(action: string): void {
  if (action === 'open-about') ensureConfigWindow({ goto: 'about' });
  else if (action === 'open-changelog')
    ensureConfigWindow({ goto: 'about-changelog' });
  else if (action === 'install-update') void applyUpdate();
}

/**
 * Prefer the real macOS notification, fall back to our own banner.
 *
 * Two things have to hold, and both are free — no Apple Developer account:
 *  - every bundle ad-hoc signed as ITSELF (scripts/package-electron.ts), and
 *  - a bundle id macOS has not already recorded a "deny" against.
 *
 * The second one is the trap. Authorisation is stored per bundle id and the
 * system asks exactly once; a rejected early build poisons the id forever
 * after, and from then on every notification is accepted and none is drawn —
 * silently, since `failed` does not fire on a drop and `show` only means the
 * payload was accepted, never that anything appeared.
 *
 * Unpackaged dev runs keep Electron's own identity, so `failed` fires there and
 * the banner takes over. Native notifications obey Do Not Disturb; the banner
 * never did.
 */
function showBannerNotification(
  title: string,
  body: string,
  options: { cta?: { label: string; action: string } } = {},
): void {
  if (!Notification.isSupported()) {
    console.log('[notify] sistema no soportado → banner propio');
    return showCustomBanner(title, body, options);
  }
  let delivered = false;
  const notification = new Notification({ title, body });
  const action = options.cta && options.cta.action;
  if (action) notification.on('click', () => runNotificationAction(action));
  notification.on('show', () => {
    delivered = true;
    console.log('[notify] aceptada por el sistema');
  });
  notification.on('failed', (_event, error) => {
    console.warn(`[notify] el sistema la rechazó (${error}) → banner propio`);
    if (!delivered) showCustomBanner(title, body, options);
  });
  notification.show();
}

function showCustomBanner(
  title: string,
  body: string,
  { cta }: { cta?: { label: string; action: string } } = {},
): void {
  closeNotificationWindow(); // replace any visible banner
  const secs = BANNER_AUTOCLOSE_SECS;
  const width = 360;
  const height = 76;
  const margin = 12;
  const wa = activeDisplay().workArea;
  const win = new BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - margin,
    y: wa.y + margin,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const query: Record<string, string> = { title, body, secs: String(secs) };
  if (cta && cta.label && cta.action) {
    query.cta = cta.label;
    query.action = cta.action;
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'notification.html'), {
    query,
  });
  win.once('ready-to-show', () => win.showInactive()); // never steal focus
  win.on('closed', () => {
    if (notificationWindow === win) notificationWindow = null;
  });
  notificationWindow = win;

  // Main owns the authoritative close timer; the renderer bar is cosmetic.
  if (secs > 0)
    notificationTimer = setTimeout(closeNotificationWindow, secs * 1000);
}

/**
 * Completion banner for pre-scripts and scheduled actions, gated by the global
 * `notifySuccess` toggle.
 */
function showCompletionNotification(title: string, body: string): void {
  if (!configStore.getGlobalSettings().notifySuccess) return;
  showBannerNotification(title, body);
}

function rendererTargets() {
  const targets = [];
  if (mb && mb.window && !mb.window.isDestroyed())
    targets.push(mb.window.webContents);
  if (configWindow && !configWindow.isDestroyed())
    targets.push(configWindow.webContents);
  for (const win of logsWindows.values()) {
    if (win && !win.isDestroyed()) targets.push(win.webContents);
  }
  for (const win of silencedWindows.values()) {
    if (win && !win.isDestroyed()) targets.push(win.webContents);
  }
  return targets;
}

function updateDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const anyOpen =
    logsWindows.size > 0 ||
    silencedWindows.size > 0 ||
    prescriptConfirmWindows.size > 0 ||
    (configWindow && !configWindow.isDestroyed());
  if (anyOpen) {
    if (!app.dock.isVisible()) app.dock.show();
  } else {
    if (app.dock.isVisible()) app.dock.hide();
  }
}

function buildTrayContextMenu() {
  const items: MenuItemConstructorOptions[] = [];
  if (availableUpdate) {
    const ready =
      stagedUpdate && stagedUpdate.version === availableUpdate.version;
    items.push({
      label: ready
        ? `⬆︎ Reiniciar e instalar v${availableUpdate.version}`
        : `⬆︎ Actualizar a v${availableUpdate.version}…`,
      click: () => applyUpdate(),
    });
    items.push({ type: 'separator' });
  }
  if (logsWindows.size > 0) {
    const submenu: MenuItemConstructorOptions[] = [];
    for (const [processId, win] of logsWindows.entries()) {
      if (win && !win.isDestroyed()) {
        const title = win.getTitle() || `Logs — ${processId}`;
        submenu.push({
          label: title,
          click: () => {
            if (!win.isDestroyed()) {
              win.show();
              win.focus();
            }
          },
        });
      }
    }
    if (submenu.length > 0) {
      items.push({ label: 'Ventanas de logs', submenu });
      items.push({ type: 'separator' });
    }
  }
  items.push({ label: 'Configuración…', click: () => ensureConfigWindow() });
  items.push({ type: 'separator' });
  items.push({ label: 'Salir', role: 'quit' });
  return Menu.buildFromTemplate(items);
}

function broadcastUpdateStatus() {
  // Same shape as the `updates:status` handler. `UpdateStatus` declares
  // currentVersion as required, so omitting it here typed it as `string` in the
  // renderer while arriving `undefined`.
  const payload = {
    available: availableUpdate,
    staged: stagedUpdate,
    lastCheckAt: lastUpdateCheckAt,
    currentVersion: app.getVersion(),
  };
  for (const wc of rendererTargets()) wc.send('updates:status', payload);
}

/**
 * Check GitHub for a newer release. Kept NON-insistent: at most one notice per
 * launch from the automatic loop, or on a manual check, and never while the
 * config window is focused — a manual check surfaces its result inline in
 * config instead.
 */
async function runUpdateCheck({ manual = false } = {}) {
  const found = await checkForUpdate({
    ...UPDATE_REPO,
    currentVersion: app.getVersion(),
  });
  lastUpdateCheckAt = new Date().toISOString();
  // A simulated update owns the slot until the dev panel releases it.
  if (!devUpdateSimulated) availableUpdate = found || null;
  refreshTrayIcon();
  if (found && !devUpdateSimulated) {
    // When this install shape supports an in-place update, stay quiet until
    // the download is on disk — one notice ("reinicia") beats two
    // ("hay una" / "ya está"). Otherwise the assisted download flow.
    if (stageableAsset(found, installedAppPath())) void stageUpdate(found);
    else notifyUpdateAvailable(found, manual);
  }
  broadcastUpdateStatus();
  return {
    available: availableUpdate,
    staged: stagedUpdate,
    lastCheckAt: lastUpdateCheckAt,
  };
}

/** Non-insistent notice for the manual (DMG) route. */
function notifyUpdateAvailable(update: AvailableUpdate, manual: boolean): void {
  const configFocused =
    configWindow && !configWindow.isDestroyed() && configWindow.isFocused();
  if ((!manual && updateNotifiedThisLaunch) || configFocused) return;
  updateNotifiedThisLaunch = true;
  showBannerNotification(
    'DevBar — actualización',
    `v${update.version} disponible.`,
    { cta: { label: 'Ver', action: 'open-about' } },
  );
}

/**
 * This build's CFBundleIdentifier, read from the bundle it is running out of.
 * Null in a dev run, which has no bundle of ours. Reading it beats repeating
 * the literal from scripts/package-electron.ts, which could then disagree with
 * what was packaged.
 */
function installedBundleId(): string | null {
  const bundle = installedAppPath();
  if (!bundle || !isMac) return null;
  try {
    const plist = fs.readFileSync(
      path.join(bundle, 'Contents', 'Info.plist'),
      'utf8',
    );
    const match =
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Download the platform's update artifact in the background and stage it next
 * to our config, so applying the update later is just a swap-and-relaunch. Any
 * failure falls back to the assisted "download it yourself" notice rather than
 * going silent.
 */
async function stageUpdate(update: AvailableUpdate): Promise<void> {
  if (stagedUpdate && stagedUpdate.version === update.version) return;
  if (stagingVersion === update.version) return;
  // The check loop runs every 5 minutes; without this, a version that fails to
  // download would re-pull ~100 MB on every tick.
  if (stagingFailedVersions.has(update.version)) return;
  const plan = stageableAsset(update, installedAppPath());
  if (!plan) return;
  stagingVersion = update.version;
  const updatesDir = path.join(appHome(), 'updates');
  const filePath = path.join(updatesDir, plan.fileName);
  try {
    fs.mkdirSync(updatesDir, { recursive: true });
    await downloadFile(plan.url, filePath);
    // Integrity seal: the release's SHA256SUMS.txt, required on every
    // platform — the ad-hoc signature carries no publisher identity, so
    // a missing manifest leaves no trust anchor anywhere. (macOS adds a
    // codesign verification on top when the bundle is unpacked.)
    const manifest = await fetchReleaseSha256(
      UPDATE_REPO.owner,
      UPDATE_REPO.repo,
      update.version,
    );
    if (manifest) {
      const verified = await verifySha256(
        filePath,
        manifest.get(plan.fileName),
      );
      if (!verified)
        throw new Error(
          'el hash de la descarga no coincide con SHA256SUMS.txt',
        );
    } else {
      // Fail closed on every platform: the ad-hoc signature carries no
      // publisher identity, so a missing manifest leaves macOS with no
      // trust anchor either. Releases always publish SHA256SUMS.txt
      // (it is part of the 14-artifact contract); when it cannot be
      // fetched, abort staging instead of installing an unverified file.
      throw new Error('no se pudo obtener SHA256SUMS.txt');
    }
    stagedUpdate = await stageDownloadedArtifact({
      filePath,
      destDir: path.join(updatesDir, update.version),
      version: update.version,
      kind: plan.kind,
    });
    console.log(`[updates] v${update.version} descargada, lista para instalar`);
    broadcastUpdateStatus();
    refreshTrayIcon();
    showBannerNotification(
      'DevBar — actualización',
      `v${update.version} lista. Reinicia para instalarla.`,
      { cta: { label: 'Reiniciar', action: 'install-update' } },
    );
  } catch (err) {
    stagingFailedVersions.add(update.version);
    console.warn(
      `[updates] no se pudo preparar v${update.version}: ${errorMessage(err)}`,
    );
    notifyUpdateAvailable(update, false);
  } finally {
    fs.rmSync(filePath, { force: true });
    stagingVersion = null;
    // Housekeeping, deliberately outside the try: a prune that trips over a
    // dangling entry must not mark a perfectly good download as failed and
    // swallow the "restart to install" notice for the rest of the session.
    if (stagedUpdate) pruneStagedUpdates(updatesDir, stagedUpdate.version);
  }
}

/**
 * Everything staging does once the bytes are on disk: verify the seal, unpack,
 * and tell the app there is a version waiting. Kept apart from the download so
 * the dev simulation can exercise this half for real with a locally built zip
 * — the half where a bad bundle or a failed swap would actually bite.
 */
async function stageFromZip(zipPath: string, version: string): Promise<void> {
  const updatesDir = path.join(appHome(), 'updates');
  stagedUpdate = await extractUpdate({
    zipPath,
    destDir: path.join(updatesDir, version),
    version,
  });
  console.log(`[updates] v${version} descargada, lista para instalar`);
  broadcastUpdateStatus();
  refreshTrayIcon();
  showBannerNotification(
    'DevBar — actualización',
    `v${version} lista. Reinicia para instalarla.`,
    { cta: { label: 'Reiniciar', action: 'install-update' } },
  );
}

/** Drop previously staged versions — each one is a full copy of the app. */
function pruneStagedUpdates(updatesDir: string, keep: string): void {
  try {
    for (const entry of fs.readdirSync(updatesDir)) {
      if (entry === keep) continue;
      const candidate = path.join(updatesDir, entry);
      if (!fs.statSync(candidate).isDirectory()) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[updates] no se pudo limpiar: ${errorMessage(err)}`);
  }
}

/** Stream a URL to `dest`, following GitHub's asset redirects. */
function downloadFile(
  url: string,
  dest: string,
  redirects = 5,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'DevBar-Updater' } },
      (res) => {
        const { statusCode, headers } = res;
        if (
          statusCode !== undefined &&
          [301, 302, 303, 307, 308].includes(statusCode) &&
          typeof headers.location === 'string'
        ) {
          res.resume();
          if (redirects <= 0) return reject(new Error('too many redirects'));
          return resolve(downloadFile(headers.location, dest, redirects - 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

/**
 * Install the already-downloaded update: confirm → hand the swap to a detached
 * process → quit. macOS/Linux run a swap script that waits for us to exit,
 * replaces the app and relaunches it; Windows runs the new installer (or a
 * folder-swap bat for portable installs), which does the same. The user never
 * touches the Finder/Explorer. Only the confirmation is asked of them, once.
 */
async function installStagedUpdate(staged: StagedUpdate, target: string) {
  const owner =
    configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
  let res;
  try {
    res = await showMessageBox(owner, {
      type: 'question',
      buttons: ['Ahora no', 'Reiniciar e instalar'],
      defaultId: 1,
      cancelId: 0,
      message: `DevBar v${staged.version} está lista`,
      detail:
        'Ya está descargada. DevBar se cerrará, se sustituirá por la nueva versión y volverá a abrirse sola.',
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (res.response !== 1) return { ok: false, cancelled: true };

  try {
    spawnSwap({
      staged,
      target,
      scriptDir: path.join(appHome(), 'updates'),
      pid: process.pid,
    });
  } catch (err) {
    broadcastToast('error', `No se pudo instalar: ${errorMessage(err)}`);
    return { ok: false, error: errorMessage(err) };
  }
  // The script polls for our exit, so a short delay is enough to let this IPC
  // reply reach the renderer before we go. The exit is an UPDATE (not a
  // user quit): the relaunched version may resume the running services.
  markUpdateExit();
  setTimeout(() => app.quit(), 200);
  return { ok: true, quitting: true, inPlace: true };
}

/**
 * Assisted update — reached when an in-place update is not possible for this
 * install shape (or before a staged download exists). Per platform:
 *
 * - macOS:  download the .dmg to Downloads, open the Finder volume, QUIT so
 *           the drag-into-Applications isn't blocked by the running app.
 * - Windows: download the NSIS installer to Downloads, run it (it upgrades the
 *           install and relaunches), QUIT so the locked exe can be replaced.
 * - Linux:  download the .deb (or AppImage) to Downloads and point the user at
 *           it — system installs need the package manager, which needs the
 *           user's own terminal/elevation.
 */
async function applyUpdate() {
  if (!availableUpdate) return { ok: false, error: 'no_update' };
  const { version, dmgUrl, setupUrl, debUrl, appImageUrl, url } =
    availableUpdate;
  const staged = stagedUpdate;
  const target = installedAppPath();
  if (staged && staged.version === version && canInstallInPlace(target))
    return installStagedUpdate(staged, target);
  const owner =
    configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();

  let downloadUrl: string | null = null;
  let destName = '';
  let detail =
    'Se abrirá la página de la release para descargar la nueva versión.';
  let buttons = ['Cancelar', 'Descargar'];
  if (isMac && dmgUrl) {
    downloadUrl = dmgUrl;
    destName = `DevBar-${version}-macos-${process.arch}.dmg`;
    buttons = ['Cancelar', 'Descargar y cerrar'];
    detail =
      'Se descargará el instalador y DevBar se CERRARÁ para que puedas sustituirla (macOS no deja reemplazar la app mientras está abierta).\n\nSe abrirá una ventana del Finder: arrastra DevBar a Aplicaciones y vuelve a abrirla.';
  } else if (!isMac && setupUrl) {
    downloadUrl = setupUrl;
    destName = `DevBar-${version}-win-${process.arch}-setup.exe`;
    buttons = ['Cancelar', 'Descargar y cerrar'];
    detail =
      'Se descargará el instalador, DevBar se CERRARÁ y el instalador actualizará la aplicación en su sitio.';
  } else if (!isMac && debUrl) {
    downloadUrl = debUrl;
    // Must match the release asset naming (linux-armv7.*), otherwise the
    // SHA256 manifest lookup for this file name would miss on 32-bit ARM.
    destName = `DevBar-${version}-linux-${normalizeArch(process.platform, process.arch)}.deb`;
  } else if (!isMac && appImageUrl) {
    downloadUrl = appImageUrl;
    destName = `DevBar-${version}-linux-${normalizeArch(process.platform, process.arch)}.AppImage`;
    detail =
      'Se descargará la AppImage a Descargas. Cierra DevBar y ejecútala desde ahí (o cópiala a ~/Applications).';
  }

  let res;
  try {
    res = await showMessageBox(owner, {
      type: 'question',
      buttons,
      defaultId: 1,
      cancelId: 0,
      message: `Actualizar a DevBar v${version}`,
      detail,
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (res.response !== 1) return { ok: false, cancelled: true };

  if (!downloadUrl) {
    shell.openExternal(url);
    return { ok: true, opened: 'page' };
  }

  const dest = path.join(app.getPath('downloads'), destName);
  showBannerNotification('DevBar — actualización', `Descargando v${version}…`);
  try {
    await downloadFile(downloadUrl, dest);
  } catch (err) {
    broadcastToast('error', `Descarga falló: ${errorMessage(err)}`);
    shell.openExternal(url); // fall back to the release page
    return { ok: false, error: errorMessage(err), fellBack: true };
  }

  // Integrity seal for the ASSISTED flow (CWE-494): the file is opened
  // straight from Downloads — mounted, installed or executed by the OS —
  // so, unlike the in-place flow (which verifies during staging), the
  // verification must happen here, before anything opens the artifact.
  // The release pipeline always publishes SHA256SUMS.txt (it is part of
  // the 14-artifact contract); a missing manifest or a digest mismatch
  // falls back to the release page instead of handing an unverified file
  // to the OS.
  try {
    const manifest = await fetchReleaseSha256(
      UPDATE_REPO.owner,
      UPDATE_REPO.repo,
      version,
    );
    if (!manifest) throw new Error('no se pudo obtener SHA256SUMS.txt');
    const verified = await verifySha256(dest, manifest.get(destName));
    if (!verified)
      throw new Error('el hash de la descarga no coincide con SHA256SUMS.txt');
  } catch (err) {
    broadcastToast(
      'error',
      `Integridad de la descarga no verificada: ${errorMessage(err)}`,
    );
    fs.rmSync(dest, { force: true });
    shell.openExternal(url); // fall back to the release page
    return { ok: false, error: errorMessage(err), fellBack: true };
  }

  if (isMac) {
    const openErr = await shell.openPath(dest); // mount the dmg → Finder
    if (openErr) {
      // Mount failed — don't quit and strand the user; open the release page.
      broadcastToast('error', `No se pudo abrir el instalador: ${openErr}`);
      shell.openExternal(url);
      return { ok: false, error: openErr, fellBack: true };
    }
    // Quit so the .app can be replaced. The DMG mount is an OS-owned Finder
    // volume that outlives us; the single-instance lock means this is the
    // only instance. Small delay lets the Finder window surface first.
    // ponytail: fixed 1.2s delay, not a mount-completion watch.
    markUpdateExit();
    setTimeout(() => app.quit(), 1200);
    return { ok: true, path: dest, quitting: true };
  }

  if (!isMac && setupUrl) {
    // Launch the installer (upgrades in place, relaunches DevBar), then quit
    // so the locked exe/DLLs can be replaced.
    const openErr = await shell.openPath(dest);
    if (openErr) {
      broadcastToast('error', `No se pudo abrir el instalador: ${openErr}`);
      return { ok: false, error: openErr, fellBack: true };
    }
    // The installer relaunches DevBar: mark the exit as an update so the
    // new version may resume the running services.
    markUpdateExit();
    setTimeout(() => app.quit(), 1200);
    return { ok: true, path: dest, quitting: true };
  }

  // Linux package/AppImage: the user installs it with the package manager or
  // a double-click — no quit needed from us. Record the exit as an UPDATE
  // handoff: the user is told to close DevBar to install, and that
  // deliberate close would otherwise flush the snapshot with reason
  // `quit` (which never resumes), silently dropping every running
  // service after the reinstall. Same rationale as the macOS/Windows
  // assisted branches, which markUpdateExit() right before quitting.
  markUpdateExit();
  broadcastToast(
    'ok',
    `v${version} descargada a ${dest}. Cierra DevBar e instálala/éjecútala.`,
  );
  return { ok: true, path: dest };
}

/**
 * Open the shared logs window straight onto a merged scope. A live window is
 * told to switch; a cold one carries the scope in its query string so it opens
 * already showing it, with no single-service flash in between.
 */
function ensureLogsScopeWindow(
  scope: 'all' | 'group',
  groupId: string | null,
  level: 'warn' | 'error' | null,
): BrowserWindow {
  const existing = logsWindows.get(MAIN_LOGS_KEY);
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('logs:select', { scope, groupId, level });
    existing.show();
    existing.focus();
    return existing;
  }
  const query: Record<string, string> = { scope };
  if (groupId) query.groupId = groupId;
  if (level) query.level = level;
  const win = buildLogsWindow({
    title: scope === 'all' ? 'DevBar — Telemetría' : 'DevBar — Logs',
    detached: false,
    processId: '',
    query,
  });
  logsWindows.set(MAIN_LOGS_KEY, win);
  win.on('closed', () => {
    logsWindows.delete(MAIN_LOGS_KEY);
    mainLogsWatching = null;
    mainLogsScope = null;
    updateDockVisibility();
  });
  logger.attachWindowConsole(win, `logs:${scope}`);
  updateDockVisibility();
  return win;
}

/** The BrowserWindow itself, shared by the single-log and merged entry points. */
function buildLogsWindow({
  title,
  detached,
  processId,
  query,
}: {
  title: string;
  detached: boolean;
  processId: string;
  query: Record<string, string>;
}): BrowserWindow {
  const size = adaptiveSize(detached ? 960 : 1180, 640);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: size.x,
    y: size.y,
    minWidth: detached ? 480 : 720,
    minHeight: 320,
    title,
    // hiddenInset + traffic lights are macOS chrome; elsewhere the native
    // titlebar is the least-surprising option.
    icon: appWindowIcon(),
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 14 },
          backgroundColor: themeWindowBackground(),
        }
      : { backgroundColor: themeWindowBackground() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--process-id=${processId}`],
    },
  });
  win.setMenuBarVisibility(false);
  // NOT visible-on-all-workspaces: on a secondary display that made macOS
  // minimize the other windows there (accessory-app + join-all-spaces quirk).
  win.loadFile(path.join(__dirname, '..', 'renderer', 'logs.html'), { query });
  return win;
}

function ensureSilencedWindow(
  groupId: string,
  commandId: string,
): BrowserWindow | null {
  const key = `${groupId}:${commandId}`;
  const existing = silencedWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const group = configStore.getGroup(groupId);
  const command =
    group && group.commands && group.commands.find((c) => c.id === commandId);
  if (!command) return null;
  const win = new BrowserWindow({
    width: 480,
    height: 520,
    minWidth: 360,
    minHeight: 320,
    title: `Silenciados — ${command.name}`,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 14 },
          backgroundColor: '#1e1e1e',
        }
      : { backgroundColor: '#1e1e1e' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // NOT visible-on-all-workspaces (see logs/config): avoids the secondary-display
  // minimize-everything quirk for accessory-app windows.
  win.loadFile(path.join(__dirname, '..', 'renderer', 'silenced.html'), {
    query: { groupId, commandId, platform: platformLabel() },
  });
  win.on('closed', () => {
    silencedWindows.delete(key);
    updateDockVisibility();
  });
  silencedWindows.set(key, win);
  logger.attachWindowConsole(win, `silenced:${key}`);
  updateDockVisibility();
  return win;
}

function broadcastBranchesChanged(repoPath: string): void {
  for (const wc of rendererTargets()) {
    wc.send('branches:changed', { path: repoPath });
  }
}

function syncRepoWatchers() {
  const groups = configStore.listGroups();
  const paths = [
    ...new Set(groups.map((g) => expandTilde(g.path)).filter(Boolean)),
  ];
  repoWatcher.sync(paths);
}

let lastTrayColor: TrayColor = 'stopped'; // remembered so a theme flip can re-render
// Errors/warnings badge drawn into the tray icon on win/linux (tray titles
// only render on macOS). Remembered so a theme flip re-renders it too.
let lastTrayCount = 0;

// Dev-only overrides, driven by the simulation panel (src/dev, excluded from
// packaged builds). Both stay null in a real run.
let devTrayColor: TrayColor | null = null;
let devUpdateSimulated = false;
// Dev-panel override for the tray count, so the badge can be exercised
// without real errors. null = follow the real aggregated state.
let devTrayCount: number | null = null;

/**
 * Repaint the menubar mark for the current state. The mark carries a small red
 * badge while an update is pending — the same "there is something new" cue the
 * version chips show in the popover and in config.
 */
function refreshTrayIcon(): void {
  if (!mb || !mb.tray) return;
  try {
    // macOS carries the count as tray title text; win/linux don't render
    // titles, so the count is drawn into the icon itself. The dev panel
    // can force it (devTrayCount) without real errors.
    mb.tray.setImage(
      trayIcon.loadIcon(
        devTrayColor ?? lastTrayColor,
        !!availableUpdate,
        isMac ? 0 : (devTrayCount ?? lastTrayCount),
      ),
    );
  } catch (err) {
    console.error('setImage failed:', err);
  }
}

function updateTrayTitle(payload: GroupState[]): void {
  if (!mb || !mb.tray) return;
  // Pass per-group color objects to aggregateColor
  const colorStubs = payload.map((gs) => ({ color: gs.color }));
  const overall = aggregateColor(colorStubs);
  lastTrayColor = overall;
  // Count non-silenced warns/errors across all command states
  let warns = 0;
  let errs = 0;
  for (const gs of payload) {
    for (const cs of gs.commands || []) {
      if (cs.status !== 'running') continue;
      if (!cs.muteWarn) warns += cs.warnCount;
      if (!cs.muteErr) errs += cs.errorCount;
    }
  }
  const count = devTrayCount ?? trayIcon.badgeCount(errs, warns);
  // macOS: count as text next to the icon. win/linux don't render tray
  // titles, so the count is drawn into the icon instead. The dev panel's
  // override (devTrayCount) wins over the real aggregated state.
  if (isMac) {
    mb.tray.setTitle(count ? ` ${count}` : '');
  } else {
    lastTrayCount = count;
  }
  // Hover affordance where the count can't be displayed next to the icon:
  // the tray tooltip carries it too. The noun follows the count's source:
  // badgeCount falls back to warns when there are no errors, so a
  // warning-only badge labelled "errores" would misreport the state. The
  // dev-panel override keeps "error" — that is what the panel forces.
  const fromErrors = devTrayCount != null || errs > 0;
  mb.tray.setToolTip(
    count
      ? `DevBar — ${
          count === 1
            ? fromErrors
              ? '1 error'
              : '1 aviso'
            : fromErrors
              ? `${count} errores`
              : `${count} avisos`
        }`
      : 'DevBar',
  );
  refreshTrayIcon();
}

function adaptiveSize(maxW: number, maxH: number, marginW = 60, marginH = 100) {
  // Size AND place on the active display (focused window's / cursor's screen),
  // not the primary one — otherwise opening a window (e.g. a log viewer) from a
  // config window living on a second display makes macOS jump Spaces and the
  // config window seems to vanish.
  const wa = activeDisplay().workArea;
  const width = Math.max(420, Math.min(maxW, wa.width - marginW));
  const height = Math.max(360, Math.min(maxH, wa.height - marginH));
  return {
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
  };
}

function ensureLogsWindow(
  processId: string,
  {
    filter,
    detached,
    level,
  }: { filter?: string; detached?: boolean; level?: 'warn' | 'error' } = {},
): BrowserWindow {
  const key = detached ? processId : MAIN_LOGS_KEY;
  const existing = logsWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    // Re-selecting the log already on screen would clear and refetch it for
    // nothing; only tell the renderer when something actually changes.
    if (detached || processId !== mainLogsWatching || filter || level) {
      existing.webContents.send('logs:select', { processId, filter, level });
    }
    if (!detached) mainLogsWatching = processId;
    existing.show();
    existing.focus();
    return existing;
  }
  // Resolve target name for window title
  const resolved = processManager.resolveTarget(processId);
  const titleName = resolved
    ? resolved.kind === 'command'
      ? resolved.target.name
      : resolved.target.name
    : processId;
  const query: Record<string, string> = { id: processId };
  if (filter) query.filter = filter;
  if (level) query.level = level;
  if (detached) query.detached = '1';
  else mainLogsWatching = processId;
  const win = buildLogsWindow({
    title: `Logs — ${titleName}`,
    detached: Boolean(detached),
    processId,
    query,
  });
  win.on('closed', () => {
    logsWindows.delete(key);
    if (!detached) mainLogsWatching = null;
    updateDockVisibility();
  });
  logsWindows.set(key, win);
  logger.attachWindowConsole(win, `logs:${processId}`);
  updateDockVisibility();
  return win;
}

function ensurePrescriptConfirmWindow(token: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 300, // fixed for v1; CSS ellipsis/wrap handles long commands
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false, // show on ready-to-show to avoid a white flash
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(
    path.join(__dirname, '..', 'renderer', 'prescript-confirm.html'),
    {
      query: { token },
    },
  );
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    // OS-level / force close without a decision => implicit cancel (Risk R4)
    if (pendingConfirms.has(token)) resolvePrescriptConfirm(token, 'cancel');
    prescriptConfirmWindows.delete(token);
    updateDockVisibility();
  });
  prescriptConfirmWindows.set(token, win);
  logger.attachWindowConsole(win, `prescript-confirm:${token}`);
  updateDockVisibility();
  return win;
}

function ensureConfigWindow({ goto }: { goto?: string } = {}): void {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.show();
    configWindow.focus();
    if (goto) configWindow.webContents.send('config:goto', goto);
    return;
  }
  const size = adaptiveSize(820, 640);
  forceCloseConfig = false;
  configWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: size.x,
    y: size.y,
    minWidth: 460,
    minHeight: 380,
    title: 'DevBar — Configuración',
    icon: appWindowIcon(),
    // macOS: frameless-ish hiddenInset with vibrancy. Elsewhere: a normal
    // titled window (vibrancy/traffic-light positions don't exist).
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 16 },
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: themeWindowBackground() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configWindow.setMenuBarVisibility(false);
  // NOTE: deliberately NOT setVisibleOnAllWorkspaces — as an accessory (menubar)
  // app, a can-join-all-spaces window shown on a SECONDARY display makes macOS
  // minimize the other windows there. Regular per-space behaviour avoids it.
  configWindow.loadFile(path.join(__dirname, '..', 'renderer', 'config.html'));
  // A fresh window can't receive the deep-link until its renderer has loaded.
  // Without this, the very first open (or any open after the window was closed)
  // never navigates — only reused windows did. Fires once per creation.
  if (goto) {
    configWindow.webContents.once('did-finish-load', () => {
      if (configWindow && !configWindow.isDestroyed()) {
        configWindow.webContents.send('config:goto', goto);
      }
    });
  }
  const win = configWindow;
  win.on('close', (event) => {
    if (forceCloseConfig) return;
    event.preventDefault();
    win.webContents.send('config:closeRequested');
  });
  configWindow.on('closed', () => {
    forceCloseConfig = false;
    configWindow = null;
    updateDockVisibility();
  });
  logger.attachWindowConsole(configWindow, 'config');
  updateDockVisibility();
}

/**
 * Apply the "open at login" setting to the OS. Dev runs are a no-op: the
 * entry would point at Electron's own binary and boot a bare shell.
 */
function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) return;
  try {
    if (isMac) {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        openAsHidden: true,
      });
    } else if (isWin) {
      // The --login argument is the boot signal on Windows (see autostart.ts).
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        args: enabled ? [LOGIN_ARG] : [],
      });
    } else {
      setLinuxAutostart(process.execPath, !!enabled);
    }
  } catch (err) {
    console.error('Failed to set login item:', err);
  }
}

/** Per-platform "was this launch the OS login one" (pre-script gate). */
function wasOpenedAtLogin(): boolean {
  if (isMac)
    return !!(
      app.getLoginItemSettings && app.getLoginItemSettings().wasOpenedAtLogin
    );
  return wasOpenedAtLoginFromArgv();
}

// ─────────────────────── IPC handlers ────────────────────────────────

function registerIpc() {
  // ── Groups ──────────────────────────────────────────────────────────
  ipcMain.handle('groups:list', () => configStore.listGroups());
  ipcMain.handle('groups:states', () => snapshotGroupStates());

  ipcMain.handle(
    'groups:save',
    (_e: IpcMainInvokeEvent, groupData: unknown) => {
      const saved = configStore.saveGroup(groupData);
      syncRepoWatchers();
      broadcast();
      return saved;
    },
  );

  ipcMain.handle(
    'groups:delete',
    async (_e: IpcMainInvokeEvent, rawGroupId: unknown) => {
      const groupId = ipcString(rawGroupId, 'groupId');
      const group = configStore.getGroup(groupId);
      if (group) {
        // Stop all running commands in the group
        for (const cmd of group.commands || []) {
          const pid = makeCommandId(groupId, cmd.id);
          await processManager.stop(pid);
          processManager.removeState(pid);
        }
        for (const act of group.actions || []) {
          const pid = makeActionId(groupId, act.id);
          await processManager.stop(pid);
          processManager.removeState(pid);
        }
      }
      configStore.deleteGroup(groupId);
      groupErrors.delete(groupId);
      syncRepoWatchers();
      broadcast();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'groups:reorder',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupIds =
        Array.isArray(payload) &&
        payload.every((item: unknown) => typeof item === 'string')
          ? payload
          : null;
      if (!groupIds) throw new TypeError('Invalid IPC groupIds');
      configStore.reorderGroups(groupIds);
      broadcast();
      return { ok: true };
    },
  );

  // ── Commands ─────────────────────────────────────────────────────────
  ipcMain.handle(
    'commands:save',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const groupId = ipcString(raw.groupId, 'groupId');
      const saved = configStore.saveCommand(groupId, raw.commandData);
      broadcast();
      return saved;
    },
  );

  ipcMain.handle(
    'commands:delete',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const pid = makeCommandId(groupId, commandId);
      await processManager.stop(pid);
      processManager.removeState(pid);
      configStore.deleteCommand(groupId, commandId);
      broadcast();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'commands:reorder',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandIds = ipcStringArrayField(payload, 'commandIds');
      configStore.reorderCommands(groupId, commandIds);
      broadcast();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'commands:setAutoStart',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const enabled = ipcBooleanField(payload, 'enabled');
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'group not found' };
      const cmd = (group.commands || []).find((c) => c.id === commandId);
      if (!cmd) return { ok: false, error: 'command not found' };

      let nextCommands = group.commands.map((c) =>
        c.id === commandId ? { ...c, autoStart: !!enabled } : c,
      );

      // In single mode, enabling one command's autoStart clears all others
      // (radio semantics). Disabling does nothing extra.
      if (enabled && group.mode === 'single') {
        nextCommands = nextCommands.map((c) =>
          c.id === commandId ? c : { ...c, autoStart: false },
        );
      }

      configStore.saveGroup({ ...group, commands: nextCommands });
      broadcast();
      return { ok: true };
    },
  );

  // ── Actions ──────────────────────────────────────────────────────────
  ipcMain.handle('actions:save', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const groupId = ipcString(raw.groupId, 'groupId');
    const saved = configStore.saveAction(groupId, raw.actionData);
    broadcast();
    return saved;
  });

  ipcMain.handle(
    'actions:delete',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const actionId = ipcStringField(payload, 'actionId');
      configStore.deleteAction(groupId, actionId);
      broadcast();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'actions:reorder',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const actionIds = ipcStringArrayField(payload, 'actionIds');
      configStore.reorderActions(groupId, actionIds);
      broadcast();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'actions:run',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const actionId = ipcStringField(payload, 'actionId');
      const pid = makeActionId(groupId, actionId);
      const group = configStore.getGroup(groupId);
      const action =
        group && (group.actions || []).find((a) => a.id === actionId);
      if (!(await confirmIfNeeded(action, group, groupId))) {
        return { ok: false, cancelled: true, processId: pid };
      }
      const res = processManager.start(pid);
      broadcast();
      return { ok: res.ok, processId: pid, error: res.error };
    },
  );

  // ── Pre-scripts ───────────────────────────────────────────────────────
  // One global pipeline now: run/cancel take no groupId (D2/D7).
  ipcMain.handle('prescripts:run', () => preScriptRunner.run());
  ipcMain.handle('prescripts:cancel', () => preScriptRunner.cancel());

  // Pipeline CONFIG (the ordered steps) — mirrors the groups:list/groups:save
  // split; runtime state is broadcast separately on pipeline:update.
  ipcMain.handle('pipeline:list', () => configStore.getPreSteps());
  ipcMain.handle('pipeline:state', () => snapshotPipelineState());

  ipcMain.handle(
    'preSteps:save',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const result = configStore.savePreStep(raw.data);
      broadcast();
      return result;
    },
  );
  ipcMain.handle(
    'preSteps:delete',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const stepId = ipcStringField(payload, 'stepId');
      configStore.deletePreStep(stepId);
      broadcast();
      return { ok: true };
    },
  );
  ipcMain.handle(
    'preSteps:reorder',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const orderedIds = ipcStringArrayField(payload, 'orderedIds');
      configStore.reorderPreSteps(orderedIds);
      broadcast();
      return { ok: true };
    },
  );
  ipcMain.handle(
    'preSteps:assignScript',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const stepId = ipcString(raw.stepId, 'stepId');
      const groupId = ipcString(raw.groupId, 'groupId');
      const scriptId = ipcString(raw.scriptId, 'scriptId');
      const position =
        raw.position === undefined
          ? undefined
          : ipcNumber(raw.position, 'position');
      const result = configStore.assignScriptToStep(
        stepId,
        groupId,
        scriptId,
        position,
      );
      broadcast();
      return result;
    },
  );
  ipcMain.handle(
    'preSteps:unassignScript',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const stepId = ipcString(raw.stepId, 'stepId');
      const groupId = ipcString(raw.groupId, 'groupId');
      const scriptId = ipcString(raw.scriptId, 'scriptId');
      const result = configStore.unassignScriptFromStep(
        stepId,
        groupId,
        scriptId,
      );
      broadcast();
      return result;
    },
  );
  ipcMain.handle(
    'preScripts:save',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const groupId = ipcString(raw.groupId, 'groupId');
      const result = configStore.savePreScript(groupId, raw.data);
      broadcast();
      return result;
    },
  );
  ipcMain.handle(
    'preScripts:delete',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const scriptId = ipcStringField(payload, 'scriptId');
      configStore.deletePreScript(groupId, scriptId);
      broadcast();
      return { ok: true };
    },
  );
  ipcMain.handle(
    'preScripts:reorder',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const orderedIds = ipcStringArrayField(payload, 'orderedIds');
      configStore.reorderPreScripts(groupId, orderedIds);
      broadcast();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'prescriptConfirm:getContext',
    (_e: IpcMainInvokeEvent, rawToken: unknown) => {
      const token = ipcString(rawToken, 'token');
      const entry = pendingConfirms.get(token);
      return entry ? entry.context : null; // { name, command, secs, onTimeout, logo, groupName }
    },
  );
  ipcMain.handle(
    'prescriptConfirm:resolve',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const token = ipcString(raw.token, 'token');
      const decision = ipcConfirmDecision(raw.decision);
      resolvePrescriptConfirm(token, decision);
      return { ok: true };
    },
  );

  // ── Process start/stop ────────────────────────────────────────────────
  ipcMain.handle(
    'process:start',
    async (_e: IpcMainInvokeEvent, rawProcessId: unknown) => {
      const processId = ipcString(rawProcessId, 'processId');
      const parsed = parseProcessId(processId);
      if (parsed.kind === 'unknown')
        return { ok: false, error: 'Invalid process id' };

      // Optional confirmation gate (commands only here; actions go via actions:run).
      if (parsed.kind === 'command') {
        const grp = configStore.getGroup(parsed.groupId);
        const cmd =
          grp && (grp.commands || []).find((c) => c.id === parsed.commandId);
        if (!(await confirmIfNeeded(cmd, grp, parsed.groupId))) {
          return { ok: false, cancelled: true };
        }
      }

      // Single-mode: stop other running commands in the same group first
      if (parsed.kind === 'command') {
        const group = configStore.getGroup(parsed.groupId);
        if (group && group.mode === 'single') {
          const running = (group.commands || [])
            .map((c) => makeCommandId(group.id, c.id))
            .filter(
              (pid) =>
                pid !== processId &&
                processManager.getState(pid).status === 'running',
            );
          for (const pid of running) {
            await processManager.stop(pid);
          }
        }
      }

      const res = processManager.start(processId);
      broadcast();
      return res;
    },
  );

  ipcMain.handle(
    'process:stop',
    async (_e: IpcMainInvokeEvent, rawProcessId: unknown) => {
      const processId = ipcString(rawProcessId, 'processId');
      const res = await processManager.stop(processId);
      broadcast();
      return res;
    },
  );

  // ── Git group-level ────────────────────────────────────────────────────
  ipcMain.handle(
    'git:listBranches',
    async (_e: IpcMainInvokeEvent, rawGroupId: unknown) => {
      const groupId = ipcString(rawGroupId, 'groupId');
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };
      return gitManager.listBranches(group.path);
    },
  );

  ipcMain.handle(
    'git:currentBranch',
    async (_e: IpcMainInvokeEvent, rawGroupId: unknown) => {
      const groupId = ipcString(rawGroupId, 'groupId');
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };
      return gitManager.currentBranch(group.path);
    },
  );

  ipcMain.handle(
    'git:switchBranch',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const branch = ipcStringField(payload, 'branch');
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'Group not found' };

      // Collect all currently running command pids in this group
      const runningPids = (group.commands || [])
        .map((c) => makeCommandId(group.id, c.id))
        .filter((pid) => processManager.getState(pid).status === 'running');

      // Stop all running commands and await each exit
      await Promise.all(runningPids.map((pid) => processManager.stop(pid)));

      const result = await gitManager.switchBranch(group.path, branch);
      if (!result.ok) {
        groupErrors.set(groupId, result.error ?? 'Unknown git error');
        broadcast();
        return result;
      }
      groupErrors.set(groupId, null);

      // Restart commands that were running
      for (const pid of runningPids) {
        processManager.start(pid);
      }
      broadcast();
      return { ok: true };
    },
  );

  // ── Silence ──────────────────────────────────────────────────────────
  ipcMain.handle('silence:add', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const groupId = ipcString(raw.groupId, 'groupId');
    const commandId = ipcString(raw.commandId, 'commandId');
    const level = ipcSilenceLevel(raw.level);
    const pattern = ipcString(raw.pattern, 'pattern');
    const cmd = configStore.addSilencedPattern(
      groupId,
      commandId,
      level,
      pattern,
    );
    if (cmd) {
      const pid = makeCommandId(groupId, commandId);
      processManager.recount(pid);
      broadcast();
    }
    return { ok: !!cmd, command: cmd };
  });

  ipcMain.handle(
    'silence:remove',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const groupId = ipcString(raw.groupId, 'groupId');
      const commandId = ipcString(raw.commandId, 'commandId');
      const level = ipcSilenceLevel(raw.level);
      const pattern = ipcString(raw.pattern, 'pattern');
      const cmd = configStore.removeSilencedPattern(
        groupId,
        commandId,
        level,
        pattern,
      );
      if (cmd) {
        const pid = makeCommandId(groupId, commandId);
        processManager.recount(pid);
        broadcast();
      }
      return { ok: !!cmd, command: cmd };
    },
  );

  ipcMain.handle(
    'silence:setCommand',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const groupId = ipcString(raw.groupId, 'groupId');
      const commandId = ipcString(raw.commandId, 'commandId');
      const level = ipcSilenceLevel(raw.level);
      const enabled = ipcBooleanField(payload, 'enabled');
      const cmd = configStore.setCommandSilence(
        groupId,
        commandId,
        level,
        enabled,
      );
      if (cmd) broadcast();
      return { ok: !!cmd, command: cmd };
    },
  );

  ipcMain.handle(
    'silence:setGroup',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const groupId = ipcString(raw.groupId, 'groupId');
      const level = ipcSilenceLevel(raw.level);
      const enabled = ipcBooleanField(payload, 'enabled');
      const grp = configStore.setGroupSilence(groupId, level, enabled);
      if (grp) broadcast();
      return { ok: !!grp, group: grp };
    },
  );

  // ── Logs ─────────────────────────────────────────────────────────────
  ipcMain.handle(
    'logs:get',
    (event: IpcMainInvokeEvent, rawProcessId: unknown) => {
      const processId = ipcString(rawProcessId, 'processId');
      // Reading the buffer and subscribing to it happen in the same tick, so a
      // line emitted mid-switch cannot land in both the snapshot and the live
      // stream (which would render it twice).
      const main = logsWindows.get(MAIN_LOGS_KEY);
      if (main && !main.isDestroyed() && main.webContents === event.sender) {
        mainLogsWatching = processId;
        mainLogsScope = null; // leaving the merged view
      }
      const resolved = processManager.resolveTarget(processId);
      const cmdState = processManager.getState(processId);
      return {
        target: resolved || {
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
    },
  );

  /**
   * Every retained line of every service in one group, merged into a single
   * chronological stream and tagged with its source — the shape telemetry
   * tools use, where the row itself tells you who emitted it. Subscribing and
   * snapshotting happen in the same tick so no line is both replayed and
   * streamed.
   */
  /**
   * Sources of a merged scope: null groupId means every group;
   * `PIPELINE_LOG_GROUP_ID` means the pipeline's own top-level bucket. The
   * pipeline aggregator log is a sibling of group buckets — it surfaces in
   * the "every group" view and in its own scope, but never inside a real
   * group's merged view (it belongs to no single group).
   *
   * The pipeline's own scope is a genuine cross-group merge, not a
   * single-group one: every pre-script only ever runs through the pipeline
   * (there is no other way to mint a `pre:groupId:scriptId` buffer), so its
   * merged view must include every one of them, each tagged with its OWN
   * real group and script name — never the pipeline's sentinel — exactly
   * like a normal group's commands/actions. The aggregator itself carries
   * only the pipeline's own narration; it never holds a copy of a script's
   * output (see `pre-script-runner.ts`'s `runOne`), so without this, a
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
    // Pre-scripts only exist once they have run, so they come from the
    // retained buffers rather than from config — the same way `logs:list`
    // finds them for the sidebar.
    const wanted = new Map(groups.map((group) => [group.id, group.name]));
    for (const { id } of processManager.listLogBuffers()) {
      const parsed = parseProcessId(id);
      // Membership is the SHARED rule — the very same call `broadcastLog`
      // makes — so this view can never list a buffer the live stream then
      // withholds, which is exactly how the two drifted before. Only NAMING
      // a source differs by kind below.
      if (!belongsToMergedScope(parsed, groupId)) continue;
      if (parsed.kind === 'prescript') {
        // Always the script's OWN real group, in the pipeline's cross-group
        // view and inside its own group's view alike.
        const resolved = processManager.resolveTarget(id);
        if (resolved) {
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
        sources.push({
          id,
          name: id,
          groupId: parsed.groupId,
          groupName,
        });
      } else if (parsed.kind === 'preAggregator') {
        sources.push({
          // Every run lands in the same bucket, so the start time is what
          // tells two of them apart; the bucket keeps the constant name.
          id,
          name: formatPipelineRunName(Number(parsed.runId)),
          groupId: PIPELINE_LOG_GROUP_ID,
          groupName: PIPELINE_LOG_NAME,
        });
      }
    }
    return sources;
  };

  // Just the sources, for a merged view that saw a line from a service it did
  // not know about — a pre-script running for the first time since it opened.
  ipcMain.handle(
    'logs:getMergedSources',
    (_e: IpcMainInvokeEvent, rawGroupId: unknown) =>
      collectMergedSources(
        rawGroupId === null || rawGroupId === undefined
          ? null
          : ipcString(rawGroupId, 'groupId'),
      ),
  );

  ipcMain.handle(
    'logs:getMerged',
    (event: IpcMainInvokeEvent, rawGroupId: unknown) => {
      // null → every group (the generic telemetry view); otherwise one group.
      const groupId =
        rawGroupId === null || rawGroupId === undefined
          ? null
          : ipcString(rawGroupId, 'groupId');
      const sources = collectMergedSources(groupId);

      const main = logsWindows.get(MAIN_LOGS_KEY);
      if (main && !main.isDestroyed() && main.webContents === event.sender) {
        mainLogsWatching = null;
        mainLogsScope = { groupId };
      }

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
  ipcMain.handle(
    'logs:clear',
    (_e: IpcMainInvokeEvent, rawProcessId: unknown) => {
      const processId = ipcString(rawProcessId, 'processId');
      processManager.clearLogs(processId);
      return { ok: true };
    },
  );

  // Every retained log buffer since app start, grouped by group → type, for the
  // Logs browser. Each item opens in the normal logs window via its processId.
  ipcMain.handle('logs:list', (): LogListGroup[] => {
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
    // group bucket, never nested under one (Aggregator Log Placement).
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
      for (const command of group.commands) {
        entry.items.push(
          item(
            makeCommandId(group.id, command.id),
            'command',
            command.name,
            command.icon,
          ),
        );
      }
      for (const action of group.actions) {
        entry.items.push(
          item(
            makeActionId(group.id, action.id),
            'action',
            action.name,
            action.icon,
          ),
        );
      }
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

  // ── Window management ─────────────────────────────────────────────────
  ipcMain.handle('window:openConfig', () => {
    ensureConfigWindow();
    if (mb && mb.window && mb.window.isVisible()) mb.hideWindow();
    return { ok: true };
  });

  // Tray version chip: open config on "Acerca de" with the changelog modal.
  ipcMain.handle('window:openConfigChangelog', () => {
    ensureConfigWindow({ goto: 'about-changelog' });
    if (mb && mb.window && mb.window.isVisible()) mb.hideWindow();
    return { ok: true };
  });

  ipcMain.handle('window:hideTray', () => {
    if (mb) mb.hideWindow();
    return { ok: true };
  });

  // Renderer measures its natural scrollHeight after every render and
  // sends it here so the popover grows / shrinks to fit. We clamp against
  // the available work-area so an extremely tall list doesn't push past
  // the screen edge.
  ipcMain.handle(
    'tray:setHeight',
    (_e: IpcMainInvokeEvent, rawContentHeight: unknown) => {
      const contentHeight = ipcNumber(rawContentHeight, 'contentHeight');
      if (!mb || !mb.window || mb.window.isDestroyed()) return { ok: false };
      const bounds = mb.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const maxH = Math.max(280, display.workAreaSize.height - 80);
      const desired = Math.max(
        160,
        Math.min(Math.ceil(contentHeight) + 4, maxH),
      );
      if (desired !== bounds.height) {
        mb.window.setSize(bounds.width, desired, false);
      }
      return { ok: true, applied: desired };
    },
  );

  ipcMain.handle(
    'window:openLogs',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      // Scope form: open the shared window on a merged view instead of one
      // service. Used by the tray's telemetry button and its alert totals.
      const record = typeof payload === 'string' ? {} : ipcRecord(payload);
      if (typeof record.scope === 'string') {
        const scope = record.scope === 'group' ? 'group' : 'all';
        const groupId =
          scope === 'group' ? ipcStringField(payload, 'groupId') : null;
        const level =
          record.level === 'warn' || record.level === 'error'
            ? record.level
            : null;
        ensureLogsScopeWindow(scope, groupId, level);
        if (mb && mb.window && mb.window.isVisible()) mb.hideWindow();
        return { ok: true };
      }
      const processId =
        typeof payload === 'string'
          ? payload
          : ipcStringField(payload, 'processId');
      const rawFilter =
        typeof payload === 'string' ? undefined : ipcRecord(payload).filter;
      const filter =
        rawFilter === undefined ? undefined : ipcString(rawFilter, 'filter');
      const detached =
        typeof payload === 'string'
          ? false
          : ipcRecord(payload).detached === true;
      const rawLevel =
        typeof payload === 'string' ? undefined : ipcRecord(payload).level;
      const level =
        rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : undefined;
      ensureLogsWindow(processId, {
        ...(filter === undefined ? {} : { filter }),
        ...(detached ? { detached: true } : {}),
        ...(level === undefined ? {} : { level }),
      });
      if (mb && mb.window && mb.window.isVisible()) mb.hideWindow();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'window:openSilenced',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const win = ensureSilencedWindow(groupId, commandId);
      return win ? { ok: true } : { ok: false, error: 'command not found' };
    },
  );

  ipcMain.handle(
    'silenced:getForCommand',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const group = configStore.getGroup(groupId);
      const command =
        group &&
        group.commands &&
        group.commands.find((c) => c.id === commandId);
      if (!group || !command) return { ok: false, error: 'command not found' };
      return {
        ok: true,
        group: { id: group.id, name: group.name },
        command: {
          id: command.id,
          name: command.name,
          silencedPatterns: command.silencedPatterns || { warn: [], error: [] },
        },
      };
    },
  );

  // ── Settings ──────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => configStore.getGlobalSettings());
  ipcMain.handle(
    'settings:save',
    (_e: IpcMainInvokeEvent, rawPatch: unknown) => {
      const next = configStore.saveGlobalSettings(
        ipcGlobalSettingsPatch(rawPatch),
      );
      applyAutostart(next.autostart);
      if (next.theme !== undefined) refreshWindowBackgrounds();
      broadcast();
      return next;
    },
  );

  // Show a test banner (ungated by notifySuccess — it's an explicit test).
  ipcMain.handle('notifications:test', () => {
    showBannerNotification('DevBar', 'Notificación de prueba ✅');
    return { ok: true };
  });

  // Dismiss the current completion banner (clicked in the banner renderer).
  ipcMain.handle('notification:dismiss', () => {
    closeNotificationWindow();
    return { ok: true };
  });

  // A banner CTA was clicked → run the mapped action, then dismiss.
  ipcMain.handle(
    'notification:action',
    (_e: IpcMainInvokeEvent, rawAction: unknown) => {
      runNotificationAction(ipcString(rawAction, 'notification action'));
      closeNotificationWindow();
      return { ok: true };
    },
  );

  // ── Updates ────────────────────────────────────────────────────────────
  ipcMain.handle('updates:status', () => ({
    available: availableUpdate,
    staged: stagedUpdate,
    lastCheckAt: lastUpdateCheckAt,
    currentVersion: app.getVersion(),
  }));
  ipcMain.handle('updates:check', () => runUpdateCheck({ manual: true }));
  ipcMain.handle('updates:apply', () => applyUpdate());

  // ── Config Export / Import ────────────────────────────────────────────

  ipcMain.handle('config:export', async () => {
    const owner =
      configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
    const stamp = new Date().toISOString().slice(0, 10);
    let res;
    try {
      res = await showSaveDialog(owner, {
        title: 'Exportar configuración DevBar',
        defaultPath: `devbar-config-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const data = configStore.exportConfig();
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('config:import', async () => {
    const owner =
      configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
    let res;
    try {
      res = await showOpenDialog(owner, {
        title: 'Importar configuración DevBar',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    let raw;
    try {
      raw = fs.readFileSync(res.filePaths[0], 'utf8');
    } catch (err) {
      return {
        ok: false,
        error: `No se pudo leer el archivo: ${errorMessage(err)}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (_err) {
      return { ok: false, error: 'Archivo no es JSON válido' };
    }
    const v = validateImportedConfig(parsed);
    if (!v.ok) return { ok: false, error: v.error };

    const token = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    pendingImports.set(token, v.payload);
    // Clear stale tokens after 5 minutes
    setTimeout(() => pendingImports.delete(token), 5 * 60 * 1000);

    return {
      ok: true,
      token,
      preview: summarizeImport(v.payload),
      path: res.filePaths[0],
    };
  });

  ipcMain.handle(
    'config:confirmImport',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const preview = ipcImportPreview(ipcRecord(payload).preview);
      const owner =
        configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
      const detail =
        `Esto sobreescribirá TODA tu configuración actual:\n\n` +
        `· ${preview.groupsCount} grupos\n` +
        `· ${preview.commandsCount} comandos\n` +
        `· ${preview.actionsCount} acciones\n` +
        `${preview.hasGlobalSettings ? '· ajustes globales\n' : ''}` +
        `\nSe guardará una copia en pre-import-backup.json antes de aplicar.`;
      let res;
      try {
        res = await showMessageBox(owner, {
          type: 'warning',
          buttons: ['Cancelar', 'Importar'],
          defaultId: 0,
          cancelId: 0,
          message: 'Importar configuración',
          detail,
        });
      } catch (err) {
        return { confirmed: false };
      }
      return { confirmed: res.response === 1 };
    },
  );

  ipcMain.handle(
    'config:applyImport',
    async (_e: IpcMainInvokeEvent, rawPayload: unknown) => {
      const token = ipcStringField(rawPayload, 'token');
      const payload = pendingImports.get(token);
      if (!payload) {
        return {
          ok: false,
          error: 'La importación expiró — vuelve a seleccionar el archivo',
        };
      }
      pendingImports.delete(token);
      try {
        const backupPath = configStore.writeImportBackup();
        const stopped = await processManager.stopAll();
        if (!stopped.ok) {
          // Half-stopped fleet: replacing the config now would leave the
          // still-running services on the OLD config. Refuse the import.
          return {
            ok: false,
            error: `No se pudieron detener todos los servicios (${stopped.failed.join(', ')}) — la importación se canceló. Detén los servicios e inténtalo de nuevo.`,
          };
        }
        // stopAll wiped the log buffers of every confirmed-stopped service…
        lastPipelineRunId = null; // …so a stale run id must not linger
        configStore.replaceConfig(payload);
        syncRepoWatchers();
        applyAutostart(configStore.getGlobalSettings().autostart);
        broadcast();
        return { ok: true, backupPath };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  );

  // ── Icons ────────────────────────────────────────────────────────────
  ipcMain.handle('icons:get', () => {
    return ICON_BATTERY;
  });

  // ── Folder picker ─────────────────────────────────────────────────────
  ipcMain.handle(
    'dialog:pickFolder',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const rawDefaultPath = ipcRecord(payload).defaultPath;
      const defaultPath =
        rawDefaultPath === undefined
          ? undefined
          : ipcString(rawDefaultPath, 'defaultPath');
      const expanded = defaultPath ? expandTilde(defaultPath) : undefined;
      const focused = BrowserWindow.getFocusedWindow();
      let res;
      try {
        const options: OpenDialogOptions = {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Selecciona una carpeta',
        };
        if (expanded) options.defaultPath = expanded;
        res = await showOpenDialog(focused, options);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
      if (res.canceled || !res.filePaths.length)
        return { ok: false, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    },
  );

  // Lets the renderer decide whether to load the dev-only simulation panel.
  ipcMain.handle('app:isDev', () => devPanelAvailable);

  // ── Dev simulation panel ──────────────────────────────────────────────
  // Presence of the files IS the switch, rather than `!app.isPackaged`. A
  // normal build strips src/dev and renderer/dev, so this is off; a build made
  // with DEVBAR_DEV_PANEL=1 keeps them, which is how the panel can be exercised
  // inside a REAL installed bundle — the only place notifications and the
  // updater behave for real.
  if (devPanelAvailable) {
    void import('./dev/dev-ipc.js')
      .then(({ registerDevIpc }) => {
        registerDevIpc({
          currentVersion: () => app.getVersion(),
          setSimulatedUpdate: (update) => {
            devUpdateSimulated = update !== null;
            availableUpdate = update;
            refreshTrayIcon();
            broadcastUpdateStatus();
          },
          setSimulatedTrayColor: (color) => {
            devTrayColor = color;
            refreshTrayIcon();
          },
          setSimulatedTrayCount: (count) => {
            devTrayCount = count;
            // macOS renders the count as title text; set it immediately so
            // the simulation is visible before the next state tick.
            if (isMac && mb && mb.tray) {
              mb.tray.setTitle(count ? ` ${count}` : '');
            }
            refreshTrayIcon();
          },
          showBanner: (title, body, options) =>
            showBannerNotification(title, body, options),
          showFallbackBanner: (title, body, options) =>
            showCustomBanner(title, body, options),
          showCompletionNotification: (title, body) =>
            showCompletionNotification(title, body),
          openPrescriptConfirm: (name, command) => {
            // Dev-only manual trigger, unrelated to the real pipeline: a
            // pipeline cancel must never close this simulated dialog. No
            // real group backs this simulated trigger, hence `null`.
            void showConfirmModal(
              {
                name,
                command,
                args: [],
                confirmSecs: null,
                confirmOnTimeout: 'cancel',
              },
              'interactive',
              null,
            );
          },
          toast: (kind, message) => broadcastToast(kind, message),
          // Not process.execPath: unpackaged that resolves to Electron's own
          // bundle, which passes the guard and then fails deep inside the copy.
          installedBundle: () => installedAppPath(),
          updatesDir: () => {
            const dir = path.join(appHome(), 'updates');
            fs.mkdirSync(dir, { recursive: true });
            return dir;
          },
          stageLocalUpdate: async (zipPath, version) => {
            try {
              await stageFromZip(zipPath, version);
            } finally {
              fs.rmSync(zipPath, { force: true });
              // Prune by what IS staged, not by what we wanted to stage: on a
              // failure the latter deletes the update already waiting, and
              // `stagedUpdate` would still point into that directory.
              if (stagedUpdate)
                pruneStagedUpdates(
                  path.join(appHome(), 'updates'),
                  stagedUpdate.version,
                );
            }
          },
        });
      })
      .catch(() => {
        /* dev panel absent (packaged build) — nothing to register */
      });
  }

  // ── App ───────────────────────────────────────────────────────────────
  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // Last 5 releases from GitHub for the changelog modal, plus the repo's
  // releases page for the "Ver en GitHub" button.
  ipcMain.handle('updates:changelog', async () => ({
    releases: await fetchReleases({ ...UPDATE_REPO, limit: 5 }),
    repoUrl: `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`,
  }));

  /**
   * Open the OS notification settings for this app. Separate from
   * `app:openExternal`, which is deliberately https-only so a renderer bug
   * cannot fire arbitrary schemes — these URLs are constants built in main
   * and never come from the renderer.
   *
   * macOS deep-links to this app's own Notifications row (the bundle id is
   * read back from the running bundle rather than repeated here, so it cannot
   * drift from what was packaged). Windows opens the notifications settings
   * page. Linux has no universal URI, so we open the distro's best-effort
   * control center and let the user find the pane.
   */
  ipcMain.handle('app:openNotificationSettings', async () => {
    try {
      if (isMac) {
        const pane =
          'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
        const bundleId = installedBundleId();
        await shell.openExternal(bundleId ? `${pane}?id=${bundleId}` : pane);
      } else if (process.platform === 'win32') {
        await shell.openExternal('ms-settings:notifications');
      } else {
        // Linux: no universal URI. xdg-settings maps "notifications" to the
        // right pane on GNOME/KDE; if it is absent the command just fails
        // quietly and the user navigates manually (the in-app hint names the
        // pane for each desktop).
        const { spawn } = await import('node:child_process');
        const child = spawn('xdg-settings', ['open', 'notifications'], {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', () => {
          /* no xdg-settings — best effort only */
        });
        child.unref();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  // Open an external https URL in the default browser. https-only guard so a
  // renderer bug can't fire arbitrary schemes (file:, javascript:, …).
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  // ── Config dirty-close helpers ─────────────────────────────────────────
  ipcMain.handle('config:confirmDirty', async (e, { context }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const message = 'Tienes cambios sin guardar.';
    const detail =
      context === 'window-close'
        ? '¿Quieres guardarlos antes de cerrar la ventana?'
        : '¿Quieres guardarlos antes de cambiar de grupo?';
    let res;
    try {
      res = await showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancelar', 'Descartar', 'Guardar'],
        cancelId: 0,
        defaultId: 2,
        message,
        detail,
      });
    } catch (err) {
      return { choice: 'cancel' };
    }
    return { choice: ['cancel', 'discard', 'save'][res.response] };
  });

  ipcMain.handle('window:confirmCloseConfig', () => {
    if (!configWindow || configWindow.isDestroyed()) return { ok: true };
    forceCloseConfig = true;
    configWindow.close();
    return { ok: true };
  });
}

// ─────────────────────── Auto-start at boot ──────────────────────────

/**
 * Spawn all commands flagged with autoStart:true.
 * Called once per app launch, after the tray is ready and renderers have painted.
 *
 * - Actions are NOT eligible (running `pnpm install` at every boot would be wrong).
 * - Single-mode groups: only spawn the first flagged command even if somehow more
 *   than one has autoStart:true (enforceSingleModeAutoStart should prevent that,
 *   but this is a belt-and-suspenders guard).
 * - Errors per command are logged and swallowed so the remaining commands still start.
 * - The ONE global pipeline runs first, gated by `wasOpenedAtLogin` and the
 *   global `preScriptsAutoRun` setting (Login Gate Unchanged) — independent
 *   of whether any group has an autoStart command, since the pipeline has
 *   value on its own (a VPN tunnel, a `make setup` step). A group with no
 *   scripts anywhere in the pipeline starts immediately. An eligible group
 *   WITH scripts releases according to its own `Group.waitForPipeline`
 *   (default `true`): waiting releases only after the WHOLE pipeline
 *   finishes successfully; opting out releases as soon as the LAST step
 *   referencing one of its scripts completes (D2/D7 staged release), same
 *   as before this per-group toggle existed. Waiting is the default because
 *   a later, unrelated group's step (e.g. a second `make setup` restarting
 *   Docker) can otherwise break an already-started group silently.
 *   On a genuine failure OR a declined confirmation, every group still
 *   withheld at that point never starts — one release rule for both causes
 *   (the Decided Override) — and is reported via the aggregator log plus a
 *   toast/notification.
 */
async function autoStartAllMarkedCommands(): Promise<void> {
  // Only run pre-scripts when DevBar was launched by the OS at login —
  // i.e. on system boot — not on every manual app restart. This protects
  // the user from re-running expensive `make setup` style scripts every
  // time they quit and reopen DevBar. The signal is per-platform: native on
  // macOS, the --login flag the autostart entries pass on Windows/Linux.
  // DEVBAR_FORCE_LOGIN=1 forces the "opened at login" path — for testing the
  // boot auto-run flow without rebooting.
  const openedAtLogin =
    process.env.DEVBAR_FORCE_LOGIN === '1' || wasOpenedAtLogin();

  const steps = configStore.getPreSteps();
  const shouldRunPipeline = shouldAutoRunPipeline({
    wasOpenedAtLogin: openedAtLogin,
    preScriptsAutoRun:
      configStore.getGlobalSettings().preScriptsAutoRun === true,
    stepCount: steps.length,
  });

  // Deliberately computed AFTER the pipeline decision above, and NOT used to
  // gate it: a pipeline with real steps must run at login even when no group
  // has an autoStart command at all (sdd-verify W2). Command release below
  // still only ever concerns groups in THIS list.
  const eligibleGroups = filterAutoStartEligibleGroups(
    configStore.listGroups(),
  );

  if (!shouldRunPipeline) {
    for (const group of eligibleGroups) startGroupAutoStartCommands(group);
    return;
  }

  const groupsById = new Map(eligibleGroups.map((group) => [group.id, group]));
  const plan = planAutoStartRelease({
    steps,
    eligibleGroupIds: eligibleGroups.map((group) => group.id),
    // Group.waitForPipeline (default true): a group whose own last step
    // already succeeded can still get broken by a LATER, unrelated group's
    // step (e.g. a second `make setup` restarting Docker) — so by default
    // every eligible group waits for the whole pipeline instead of
    // releasing early. Opting out per group stays available for genuinely
    // independent groups.
    waitingGroupIds: eligibleGroups
      .filter((group) => group.waitForPipeline)
      .map((group) => group.id),
  });
  for (const groupId of plan.immediate) {
    const group = groupsById.get(groupId);
    if (group) startGroupAutoStartCommands(group);
  }

  const release = { plan, groupsById, fired: new Set<number>() };
  activeAutoStartRelease = release;
  try {
    // Capture the in-flight run BEFORE awaiting. `run()` returns its promise
    // synchronously, so nothing can settle between these two statements; read
    // `current()` after the await instead and a manual run that finished in
    // that window is already gone, leaving the synthetic `already_running`
    // result — which reports a cancellation as a failure and loses the real
    // run's `aggregatorId`, so the withheld notice never reaches its log.
    const attempt = preScriptRunner.run();
    const inFlight = preScriptRunner.current();
    let res = await attempt;
    if (!res.ok && res.error === 'already_running' && inFlight) {
      // A manual run (e.g. the tray ▶▶) was already in flight when boot
      // auto-start fired. Adopt ITS result instead of reporting a spurious
      // failure: `activeAutoStartRelease` stays set for the whole wait, so
      // that run's `onStepComplete` still releases this boot plan's groups as
      // its own steps clear — clearing early starved every group whose
      // release step had not fired yet.
      res = await inFlight;
    }
    if (!res.ok) {
      const withheld = withheldGroupIds(plan, release.fired);
      reportWithheldGroups(
        withheld,
        groupsById,
        res.aggregatorId ?? null,
        res.cancelled ? 'cancelled' : 'failure',
      );
    }
  } finally {
    activeAutoStartRelease = null;
  }
}

function startGroupAutoStartCommands(group: Group): void {
  const eligible = (group.commands || []).filter(
    (cmd) => cmd.autoStart === true,
  );
  const toStart = group.mode === 'single' ? eligible.slice(0, 1) : eligible;
  for (const cmd of toStart) {
    const pid = makeCommandId(group.id, cmd.id);
    try {
      processManager.start(pid);
    } catch (err) {
      console.error(`autoStart failed for ${group.name}/${cmd.name}:`, err);
    }
  }
}

/**
 * Names every group withheld by a pipeline failure or a declined
 * confirmation. Same computation, same reporting machinery for both causes
 * (the Decided Override: one release rule) — the wording/severity split is
 * `describeWithheldGroups`'s job (pure, unit-tested); this function is only
 * the IO side effect (aggregator log, toast, notification).
 */
function reportWithheldGroups(
  withheldIds: readonly string[],
  groupsById: ReadonlyMap<string, Group>,
  aggregatorId: string | null,
  cause: 'failure' | 'cancelled',
): void {
  const report = describeWithheldGroups({ withheldIds, groupsById, cause });
  if (!report) return;
  if (aggregatorId) {
    processManager.pushLog(aggregatorId, {
      ts: Date.now(),
      stream: 'sys',
      level: report.aggregatorLevel,
      line: report.aggregatorLine,
    });
  }
  broadcastToast(report.toastKind, report.message);
  showCompletionNotification('DevBar — pre-scripts', report.message);
}

// ─────────────────────── Scheduled auto-run ──────────────────────────

/**
 * Anacron-style scheduler. Runs on a 60s tick, on power resume, and shortly
 * after startup. For each command with an enabled schedule:
 *   - first time we ever see it → seed lastRun=now (never fire retroactively for
 *     an occurrence that predates the user enabling the schedule).
 *   - otherwise, if a scheduled occurrence has elapsed since lastRun → start it.
 *
 * The lastRun bookkeeping (config-store.scheduleState) survives sleep AND app
 * restarts, so a machine asleep at 09:00 that wakes at 09:30 still catches up.
 * Unlike boot auto-start, scheduled runs do NOT execute pre-scripts.
 */
/**
 * Evaluate one schedulable target (command or action) at `now`.
 * Seeds lastRun on first sight (no retroactive fire), otherwise fires `startFn`
 * when a scheduled occurrence has elapsed since lastRun and it is not already
 * running. `startFn` must swallow its own errors. Returns true if it started.
 */
async function evaluateSchedule(
  pid: string,
  sched: Schedule | null | undefined,
  now: Date,
  startFn: () => Promise<boolean>,
): Promise<boolean> {
  if (!sched || !sched.enabled) return false;
  const last = configStore.getScheduleLastRun(pid);
  if (last == null) {
    configStore.setScheduleLastRun(pid, now.toISOString()); // seed only
    return false;
  }
  if (!isDue(sched, last, now)) return false;
  let didStart = false;
  if (processManager.getState(pid).status !== 'running') {
    didStart = (await startFn()) === true;
  }
  // Advance the marker even on a declined confirmation, so we don't re-prompt
  // for the same occurrence on every tick.
  configStore.setScheduleLastRun(pid, now.toISOString());
  return didStart;
}

let _schedulesInFlight = false;

// Re-entrancy guard: a scheduled start may await an indefinite confirmation
// modal, so a tick/resume mid-run must not re-evaluate the still-due target and
// queue another modal (or double-start it). One run at a time.
async function checkSchedules(now: Date): Promise<void> {
  if (_schedulesInFlight) return;
  _schedulesInFlight = true;
  try {
    await runSchedulesOnce(now);
  } finally {
    _schedulesInFlight = false;
  }
}

async function runSchedulesOnce(now: Date): Promise<void> {
  const groups = configStore.listGroups();
  let started = false;
  for (const group of groups) {
    for (const cmd of group.commands || []) {
      const pid = makeCommandId(group.id, cmd.id);
      const ran = await evaluateSchedule(pid, cmd.schedule, now, async () => {
        if (!(await confirmIfNeeded(cmd, group, group.id))) return false;
        // Single-mode groups: stop other running commands first (radio).
        if (group.mode === 'single') {
          const others = (group.commands || [])
            .map((c) => makeCommandId(group.id, c.id))
            .filter(
              (p) =>
                p !== pid && processManager.getState(p).status === 'running',
            );
          for (const p of others) await processManager.stop(p);
        }
        try {
          processManager.start(pid);
          return true;
        } catch (err) {
          console.error(`schedule start ${group.name}/${cmd.name}:`, err);
          return false;
        }
      });
      started = started || ran;
    }
    for (const act of group.actions || []) {
      const pid = makeActionId(group.id, act.id);
      const ran = await evaluateSchedule(pid, act.schedule, now, async () => {
        if (!(await confirmIfNeeded(act, group, group.id))) return false;
        try {
          processManager.start(pid);
          scheduledActionPids.add(pid); // notify on its action:done
          return true;
        } catch (err) {
          console.error(`schedule start ${group.name}/${act.name}:`, err);
          return false;
        }
      });
      started = started || ran;
    }
  }
  if (started) broadcast();
}

/**
 * Run checkSchedules aligned to the wall-clock minute. A plain
 * setInterval(60s) fires at an arbitrary phase (ready+1s, +61s, …), so a
 * 13:02 schedule could fire anywhere up to 13:02:59. We wait until the next
 * :00 second, then tick every 60s from there.
 */
function startScheduleLoop() {
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    checkSchedules(new Date());
    setInterval(() => checkSchedules(new Date()), 60 * 1000);
  }, msToNextMinute);
}

// ─────────────────────── App lifecycle ───────────────────────────────

/**
 * Window icon for dev mode: `electron .` runs on the Electron shell, so the
 * taskbar/titlebar would otherwise show Electron's default icon. Setting it
 * explicitly gives the app its own identity in dev (packaged Windows builds
 * already pick it up from the .exe icon — same design, so it's consistent).
 */
function appWindowIcon(): Electron.NativeImage {
  try {
    const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const p = path.join(__dirname, '..', 'assets', name);
    if (!fs.existsSync(p)) return nativeImage.createEmpty();
    const image = nativeImage.createFromPath(p);
    return image.isEmpty() ? nativeImage.createEmpty() : image;
  } catch {
    return nativeImage.createEmpty();
  }
}

/** Resolved theme (user preference, falling back to the OS in auto mode). */
function resolvedThemeIsDark(): boolean {
  const t = configStore.getGlobalSettings().theme;
  if (t === 'light') return false;
  if (t === 'dark') return true;
  return nativeTheme.shouldUseDarkColors;
}

function themeWindowBackground(): string {
  return resolvedThemeIsDark() ? '#1e1e1e' : '#f5f5f7';
}

// Apply the theme-appropriate opaque background to every visible app window
// (macOS vibrancy windows keep their translucent background). Called after a
// theme change so open windows follow the new setting.
function refreshWindowBackgrounds(): void {
  const bg = themeWindowBackground();
  // menubar exposes the popover as `.window` (there is no browserWindow
  // property — reading it silently skipped the popover from theme updates).
  const menuBarWindow = (mb as { window?: BrowserWindow } | undefined)?.window;
  for (const win of [configWindow, menuBarWindow, ...logsWindows.values()]) {
    if (win && !win.isDestroyed()) win.setBackgroundColor(bg);
  }
}

// Single-instance lock. DevBar is a menubar app backed by one electron-store
// file; a second launch (e.g. login item + manual open) would spawn a duelling
// tray icon writing the same store. The second instance focuses config on the
// primary and exits. `isPrimary` also guards the ready handlers, since a
// second instance may still emit 'ready' before app.quit() takes effect.
/**
 * CI smoke mode (`--devbar-smoke` or DEVBAR_SMOKE=1). Proves the PACKAGED
 * binary boots on its target OS and owns a system tray, then self-terminates
 * with a DEVBAR_SMOKE_OK marker the build jobs grep for. Skips windows,
 * commands, schedules and update checks.
 */
const SMOKE_MODE =
  process.argv.includes('--devbar-smoke') || process.env.DEVBAR_SMOKE === '1';

/**
 * Smoke result marker. Some launchers (notably the Windows portable exe,
 * whose NSIS wrapper runs the real app as a child process without
 * redirecting stdio) never deliver the app's stdout to the caller, so CI
 * jobs also check for this file: removed at smoke start, written on
 * success — a missing marker means the packaged binary did not complete
 * its smoke.
 */
const SMOKE_MARKER_PATH = path.join(os.tmpdir(), 'devbar-smoke-ok');

const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit();
} else {
  app.on('second-instance', () => ensureConfigWindow());
}

app.on('ready', () => {
  if (!isPrimary) return;
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
    updateDockVisibility();
  }
});

app.whenReady().then(() => {
  if (!isPrimary) return;
  registerIpc();
  // Smoke mode must not touch the user's auto-start registration on a CI host.
  if (!SMOKE_MODE) applyAutostart(configStore.getGlobalSettings().autostart);
  processManager.on('change', () => {
    broadcast();
    // Session resume: keep the snapshot's running set current (debounced,
    // and a no-op when the set is unchanged).
    if (!SMOKE_MODE && sessionResume) sessionResume.track(runningCommandIds());
  });
  processManager.on('log', (payload) => broadcastLog(payload));
  processManager.on('action:done', ({ processId, code, group, target }) => {
    // Pre-script exits are handled by pre-script-runner (pipeline aggregator).
    // Do not toast for individual pre-script script exits — the pipeline runner
    // handles success/failure toasting at the pipeline level.
    const parsed = parseProcessId(processId);
    if (parsed.kind === 'prescript') {
      broadcast();
      return;
    }
    const kind = code === 0 ? 'ok' : 'error';
    const message = `${group ? group.name : '?'} · ${target ? target.name : '?'} exited ${code}`;
    broadcastToast(kind, message);
    // Scheduled actions run unattended — notify natively when they finish.
    if (scheduledActionPids.has(processId)) {
      scheduledActionPids.delete(processId);
      const name = `${group ? group.name : '?'} · ${target ? target.name : '?'}`;
      showCompletionNotification(
        'DevBar — acción programada',
        code === 0 ? `${name}: completada` : `${name}: falló (código ${code})`,
      );
    }
    broadcast();
  });
  repoWatcher.on('change', (repoPath) => broadcastBranchesChanged(repoPath));
  syncRepoWatchers();

  if (!SMOKE_MODE) {
    sessionResume = new SessionResumeTracker(appHome());
    resumeSavedServices();
  }

  trayIcon.preload();

  if (SMOKE_MODE) {
    // Two CI shapes on top of the plain proof of life:
    //  - HOLD (--devbar-smoke-hold / DEVBAR_SMOKE_HOLD=1): stay resident so a
    //    following `pnpm install-local` has a real running process to kill —
    //    the "reinstall while running" test.
    //  - UPDATE (DEVBAR_SMOKE_UPDATE=1): run the REAL staging + swap handoff
    //    with a locally built artifact (DEVBAR_SMOKE_ARTIFACT + _SHA +
    //    _VERSION), then exit. The swap script relaunches the app with
    //    --devbar-smoke, so the new version proves itself through the same
    //    marker — end-to-end "automatic update" coverage in CI.
    const smokeHold =
      process.argv.includes('--devbar-smoke-hold') ||
      process.env.DEVBAR_SMOKE_HOLD === '1';
    const smokeUpdate = process.env.DEVBAR_SMOKE_UPDATE === '1';

    // Headless-friendly proof of life: create only the platform tray (no
    // BrowserWindow, no menubar chrome, no commands). Owning a tray is the
    // platform-specific part worth proving — menu bar on macOS,
    // StatusNotifier/XEmbed on Linux, notification area on Windows. The
    // update phase swaps the app and exits, so it skips the tray.
    try {
      fs.rmSync(SMOKE_MARKER_PATH, { force: true });
      if (!smokeUpdate) void new Tray(trayIcon.defaultIcon());
    } catch (error) {
      console.error('DEVBAR_SMOKE_TRAY_FAILED:', error);
      app.exit(1);
    }

    if (smokeUpdate) {
      const artifact = process.env.DEVBAR_SMOKE_ARTIFACT;
      const sha = process.env.DEVBAR_SMOKE_SHA;
      const version = process.env.DEVBAR_SMOKE_VERSION;
      const target = installedAppPath();
      const fail = (reason: string): void => {
        console.error(`DEVBAR_SMOKE_UPDATE_FAILED ${reason}`);
        app.exit(1);
      };
      if (!artifact || !sha || !version)
        return fail('missing DEVBAR_SMOKE_ARTIFACT/_SHA/_VERSION');
      if (!target) return fail('not running from an installed location');
      void (async () => {
        try {
          // The production staging path, byte for byte: hash seal, artifact
          // magic checks, copy into the per-version staging dir.
          const verified = await verifySha256(artifact, sha);
          if (!verified) throw new Error('el hash del artefacto no coincide');
          const updatesDir = path.join(appHome(), 'updates');
          const kind = isMac
            ? 'macBundle'
            : isLinux
              ? 'appImage'
              : windowsUpdateMode(target) === 'nsis'
                ? 'winInstaller'
                : 'winPortable';
          const staged = await stageDownloadedArtifact({
            filePath: artifact,
            destDir: path.join(updatesDir, version),
            version,
            kind,
          });
          // The swap waits for this pid to die, replaces the app and
          // relaunches it with --devbar-smoke, so the new version writes the
          // marker CI is about to wait for. On Windows the install bat plays
          // the swap's role (installer = swap), relaunching with the same
          // args once the installer exits 0.
          spawnSwap({
            staged,
            target,
            scriptDir: updatesDir,
            pid: process.pid,
            relaunchArgs: ['--devbar-smoke'],
            markerPath: path.join(updatesDir, 'swap-ok'),
          });
          console.log(`DEVBAR_SMOKE_UPDATE_HANDOFF ${version}`);
          app.exit(0);
        } catch (error) {
          fail(errorMessage(error));
        }
      })();
      return;
    }

    setTimeout(() => {
      try {
        fs.writeFileSync(
          SMOKE_MARKER_PATH,
          `DEVBAR_SMOKE_OK ${process.platform} ${app.getVersion()}\n`,
        );
      } catch {
        // Marker is a CI convenience; the stdout marker below is primary.
      }
      console.log('DEVBAR_SMOKE_OK');
      if (smokeHold) {
        // Resident proof of life: CI checks this pid, then expects the next
        // install-local to kill exactly this process.
        console.log(`DEVBAR_SMOKE_HOLDING ${process.pid}`);
        return;
      }
      app.exit(0);
    }, 1500);
    return;
  }

  /**
   * Which edge of the display the taskbar/panel sits on, from the tray
   * icon's bounds: the work area is the screen minus the taskbar, so the
   * offset between workArea and display bounds reveals the taskbar side.
   * Same idea as menubar's internal taskbarLocation, but based on the
   * display that actually contains the icon (multi-monitor friendly).
   */
  function taskbarSideOf(
    trayPos: Rectangle,
  ): 'top' | 'bottom' | 'left' | 'right' {
    const display = screen.getDisplayMatching(trayPos);
    const offX = display.workArea.x - display.bounds.x;
    const offY = display.workArea.y - display.bounds.y;
    if (offX > 0) return 'left';
    if (offY > 0) return 'top';
    if (display.workArea.width < display.bounds.width) return 'right';
    return 'bottom';
  }

  /**
   * Tray-relative electron-positioner position for each taskbar side: top
   * bar → the panel hangs from the bar, centered on the icon (exactly what
   * macOS gets with menubar's default 'trayCenter'); bottom bar → right
   * above the bar, centered; left/right bar → next to the bar edge.
   */
  function trayPositionForTaskbarSide(
    side: 'top' | 'bottom' | 'left' | 'right',
  ): 'trayCenter' | 'trayBottomCenter' | 'trayLeft' | 'trayRight' {
    switch (side) {
      case 'top':
        return 'trayCenter';
      case 'bottom':
        return 'trayBottomCenter';
      case 'left':
        return 'trayLeft';
      case 'right':
        return 'trayRight';
    }
  }

  /**
   * Keep the panel fully inside the work area (electron-positioner only
   * guards the right edge; a tray icon near the left edge would push the
   * panel off-screen otherwise).
   */
  function clampXToWorkArea(
    x: number,
    width: number,
    trayPos: Rectangle,
  ): number {
    const wa = screen.getDisplayMatching(trayPos).workArea;
    return Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  }

  const menuBar = menubar({
    index: `file://${path.join(__dirname, '..', 'renderer', 'tray.html')}`,
    icon: trayIcon.defaultIcon(),
    tooltip: 'DevBar',
    preloadWindow: true,
    browserWindow: {
      width: 410,
      height: 500,
      transparent: false,
      resizable: false,
      // The tray popover is a utility surface, not a window: it must not
      // claim a taskbar entry on win/linux. Real windows (config, logs)
      // are separate BrowserWindows and keep their entries.
      skipTaskbar: true,
      icon: appWindowIcon(),
      backgroundColor: themeWindowBackground(),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });
  mb = menuBar;

  menuBar.on('ready', () => {
    menuBar.tray.setImage(trayIcon.defaultIcon());
    if (isMac) menuBar.tray.setTitle('');

    // menubar v9 deliberately does NOT place the Linux panel next to the
    // tray icon: it overwrites the position with a screen-corner fallback
    // (its own taskbarLocation), so the panel opens in a corner — or
    // wherever the compositor decides — instead of "justo donde está el
    // icono" like macOS. When Electron reports the icon's real bounds
    // (X11), redirect the calculation to a tray-relative position. On
    // Wayland the bounds are (0,0) and the compositor owns window
    // placement, so menubar's behavior is kept there.
    if (isLinux) {
      type Calc = (
        position: string,
        trayBounds?: Rectangle,
      ) => { x: number; y: number };
      const positioner = menuBar.positioner as unknown as { calculate: Calc };
      const originalCalculate = positioner.calculate.bind(positioner);
      let logged = false;
      positioner.calculate = (
        position: string,
        trayPos?: Rectangle,
      ): { x: number; y: number } => {
        // Valid X11 bounds may sit at x=0 (left panel), y=0 (top panel)
        // or at negative coordinates (secondary displays) — so only the
        // dimensions distinguish real bounds from Wayland's empty
        // rectangle, not the position.
        if (trayPos && trayPos.width > 0 && trayPos.height > 0) {
          const win = menuBar.window;
          if (!win) return originalCalculate(position, trayPos);
          const result = originalCalculate(
            trayPositionForTaskbarSide(taskbarSideOf(trayPos)),
            trayPos,
          );
          const [w = 0] = win.getSize();
          if (!logged) {
            logged = true;
            console.log(
              `[tray] icono en (${trayPos.x},${trayPos.y} ${trayPos.width}x${trayPos.height}, ` +
                `sesión ${process.env.XDG_SESSION_TYPE ?? 'desconocida'}) → panel junto al icono`,
            );
          }
          return { x: clampXToWorkArea(result.x, w, trayPos), y: result.y };
        }
        if (!logged) {
          logged = true;
          console.log(
            `[tray] sin bounds del icono (sesión ${process.env.XDG_SESSION_TYPE ?? 'desconocida'}) → ` +
              'posición por defecto de menubar',
          );
        }
        return originalCalculate(position, trayPos);
      };
    }

    menuBar.tray.on('right-click', () => {
      menuBar.tray.popUpContextMenu(buildTrayContextMenu());
    });
    broadcast();

    // Auto-start commands marked with autoStart:true.
    // Delay 300 ms so the renderer can paint its initial empty state first.
    // Only commands are eligible — actions are one-shots and must not run at boot.
    setTimeout(() => autoStartAllMarkedCommands(), 300);

    // Scheduled auto-run: seed/evaluate shortly after boot, then on every
    // minute boundary (aligned so a 13:02 schedule fires at ~13:02:00, not up
    // to 59s late), plus immediately on wake so a missed slot catches up.
    setTimeout(() => checkSchedules(new Date()), 1000);
    startScheduleLoop();
    powerMonitor.on('resume', () => checkSchedules(new Date()));

    // Check GitHub for a newer release now and every 5 minutes after.
    runUpdateCheck();
    setInterval(runUpdateCheck, 5 * 60 * 1000);

    // Light/dark appearance flip → rebuild the tray dot with a contrasting
    // ring so it stays visible on the new menubar background.
    nativeTheme.on('updated', () => {
      trayIcon.invalidateCache();
      refreshTrayIcon();
    });
  });

  menuBar.on('after-create-window', () => {
    // Capture renderer console for the tray popover.
    if (menuBar.window) logger.attachWindowConsole(menuBar.window, 'tray');
    broadcast();
  });
});

app.on('window-all-closed', () => {
  // Keep the menubar app alive; Electron only quits automatically when no
  // listener is registered for this event.
});

// ── Shutdown: never orphan a service ────────────────────────────────────
// A service that outlives DevBar keeps its port and breaks the next start
// ("address already in use"), so EVERY exit path funnels into one cleanup:
//
//   * `before-quit` — tray "Salir", `app:quit`, the update swap. Electron
//     does not await an async before-quit handler: the old code signaled
//     only the first service and the event loop moved on to will-quit,
//     orphaning the rest. `preventDefault` + cleanup + `app.quit()` is the
//     supported "quit when ready" pattern.
//   * SIGINT / SIGTERM — Ctrl+C in the `pnpm start` terminal, or
//     `kill <pid>`. Node's default is to exit instantly, leaving every
//     service tree alive (on Linux the services are detached into their
//     own process groups precisely so a stop kills them as a unit — a
//     bare kill of the app never reached them).
//
// A hard kill (SIGKILL, `taskkill` without /T) runs none of this code;
// that remains the only way a service can outlive DevBar. (Modern Windows
// Task Manager "End task" kills the tree itself.)
let shutdownPhase: 'idle' | 'cleaning' | 'done' = 'idle';

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`cleanup still not done after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// The in-flight cleanup, shared by every caller that arrives while it is
// running: resolving them immediately would let that caller quit the
// process the moment ITS (instant) promise settles — mid-stopAll.
let activeCleanup: Promise<void> | null = null;
async function shutdownCleanup(): Promise<void> {
  if (shutdownPhase === 'done') return;
  if (shutdownPhase === 'cleaning' && activeCleanup) return activeCleanup;
  shutdownPhase = 'cleaning';
  const run = performShutdownCleanup();
  activeCleanup = run;
  try {
    await run;
  } finally {
    if (activeCleanup === run) activeCleanup = null;
  }
}

async function performShutdownCleanup(): Promise<void> {
  try {
    // The config window vetoes its own `close` to ask about unsaved
    // changes. During a quit that veto silently ABORTS the whole shutdown,
    // so drop it before the windows go.
    forceCloseConfig = true;
    repoWatcher.closeAll();
    // Cancel the pre-script pipeline run, if any — one global pipeline
    // now, not one per group.
    if (preScriptRunner.isRunning()) {
      try {
        preScriptRunner.cancel();
      } catch (_) {}
    }
    // Session resume: capture the running set BEFORE the services are
    // stopped (after stopAll there is nothing left to hand over), with the
    // exit reason that decides whether the next launch may resume it.
    // Smoke mode runs on CI hosts without user services — skip it.
    if (!SMOKE_MODE && sessionResume) {
      sessionResume.flush(pendingExitReason, runningCommandIds());
    }
    // Every running service — commands, actions AND pre-scripts: stopAll
    // walks the manager's own state, not just the configured commands.
    // Each stop escalates to SIGKILL / taskkill /F after 5 s; the overall
    // deadline keeps one wedged service from holding the quit hostage.
    const stopped = await withDeadline(processManager.stopAll(), 8000);
    if (!stopped.ok) {
      // Best effort: the quit still proceeds, but log WHAT survived — a
      // wedged child left running after quit is an "address in use" bomb.
      console.error(
        `shutdown cleanup: ${stopped.failed.length} service(s) still running after forced stop: ${stopped.failed.join(', ')}`,
      );
    }
  } catch (err) {
    // Cleanup is best-effort; the quit itself must always proceed.
    console.error(`shutdown cleanup failed: ${errorMessage(err)}`);
  } finally {
    shutdownPhase = 'done';
  }
}

// Exactly one follow-up quit per cleanup. Re-queueing on every prevented
// before-quit would spin a microtask storm (each app.quit() re-fires
// before-quit while the cleanup is still running) and starve the very
// cleanup it is supposed to wait for.
let quitFollowUpScheduled = false;
function scheduleQuitAfterCleanup(): void {
  if (quitFollowUpScheduled) return;
  quitFollowUpScheduled = true;
  void shutdownCleanup().then(() => {
    quitFollowUpScheduled = false;
    app.quit();
  });
}

app.on('before-quit', (event) => {
  // A second instance quit must be INSTANT: it runs no services and must
  // not touch the primary's session-resume snapshot (an empty flush would
  // delete it).
  if (!isPrimary) return;
  if (shutdownPhase === 'done') return; // cleanup finished — let it die
  event.preventDefault(); // still cleaning (or not started) — hold the quit
  scheduleQuitAfterCleanup();
});

let terminalSignals = 0;
function onTerminalSignal(): void {
  terminalSignals += 1;
  if (!isPrimary) {
    process.exit(0);
    return;
  }
  // install-local / `kill` / Ctrl+C: the next launch may resume the
  // services (reason recorded when the snapshot is flushed on cleanup).
  pendingExitReason = 'kill';
  if (terminalSignals > 1) {
    // Second Ctrl+C / kill: the user wants out NOW.
    process.exit(0);
  }
  if (shutdownPhase === 'idle') {
    void shutdownCleanup().then(() => {
      // app.quit (not app.exit): a bare exit skips Electron's own shutdown
      // sequence, which is what tears down its child processes (GPU /
      // renderer / utility helpers). A helper that outlives the main
      // process still holds the inherited single-instance socket, and the
      // next launch then dies as a silent second instance. The safety net
      // covers a quit that gets stuck.
      app.quit();
      setTimeout(() => process.exit(0), 4000);
    });
  } else if (shutdownPhase === 'done') {
    process.exit(0); // already clean
  }
  // 'cleaning': a cleanup is already running and will terminate the
  // process (the before-quit follow-up or the first signal's exit).
}
process.on('SIGINT', onTerminalSignal);
process.on('SIGTERM', onTerminalSignal);
