import path from 'node:path';
import { errorMessage } from './ipc-validators.js';
import {
  parseBundleId,
  shouldNotifyUpdate,
  shouldStageUpdate,
} from './update-plan.js';
import {
  runAssistedUpdate,
  type ApplyUpdateResult,
  type AssistedUpdateDeps,
} from './assisted-update.js';
import { createLinuxUpdateFlow, type LinuxUpdateDeps } from './linux-update.js';
import { downloadVerified } from './update-download.js';
import {
  applyReport,
  copyPhaseCommand,
  showPhaseFile,
  type SimpleResult,
} from './update-actions.js';
import {
  createPhaseStore,
  isBusyPhase,
  isFailurePhase,
  isSettledPhase,
  phaseVersion,
} from './update-phase.js';
import type { AvailableUpdate, StagedUpdate } from '../domain-types.js';
import type { UpdatePhase, UpdateStatus } from '../ipc-contract.js';

/**
 * The update lifecycle around the assisted flow: check GitHub, stage the
 * artifact in the background so applying it later is just a swap-and-relaunch,
 * and install it. Every decision lives in `update-plan.ts`; what is left here
 * is the IO ORDER, which is what makes an update unsafe when it is wrong (an
 * unverified artifact handed to the OS, a prune that deletes the download that
 * just succeeded). Where the flow stands is one explicit state machine
 * (`UpdatePhase`, held by update-phase.ts) that every window renders.
 */

type StagedKind = 'macBundle' | 'appImage' | 'winInstaller' | 'winPortable';

interface UpdaterFs {
  mkdirSync: (dir: string) => void;
  rmSync: (
    target: string,
    options: { recursive?: boolean; force: boolean },
  ) => void;
  readdirSync: (dir: string) => string[];
  isDirectory: (target: string) => boolean;
  /** Text of the installed bundle's Info.plist, or null when unreadable. */
  readInstalledPlist: (bundle: string) => string | null;
}

export interface UpdaterDeps extends AssistedUpdateDeps, LinuxUpdateDeps {
  appVersion: () => string;
  isMac: boolean;
  pid: number;
  /** Null when nothing is newer; REJECTS when the check itself failed. */
  checkForUpdate: (input: {
    owner: string;
    repo: string;
    currentVersion: string;
  }) => Promise<AvailableUpdate | null>;
  stageableAsset: (
    update: AvailableUpdate,
    installed: string | null,
  ) => { url: string; fileName: string; kind: StagedKind } | null;
  stageDownloadedArtifact: (input: {
    filePath: string;
    destDir: string;
    version: string;
    kind: StagedKind;
  }) => Promise<StagedUpdate>;
  extractUpdate: (input: {
    zipPath: string;
    destDir: string;
    version: string;
  }) => Promise<StagedUpdate>;
  canInstallInPlace: (installed: string | null) => installed is string;
  installedAppPath: () => string | null;
  spawnSwap: (input: {
    staged: StagedUpdate;
    target: string;
    scriptDir: string;
    pid: number;
  }) => void;
  updatesDir: () => string;
  updaterFs: UpdaterFs;
  /** Push to every renderer: the full status, or a phase change. */
  send: (
    channel: 'updates:status' | 'updates:phase',
    payload: UpdateStatus | UpdatePhase,
  ) => void;
  refreshTrayIcon: () => void;
  configFocused: () => boolean;
  copyText: (text: string) => void;
  showItemInFolder: (target: string) => void;
}

export interface Updater {
  status: () => UpdateStatus;
  broadcastStatus: () => void;
  runUpdateCheck: (options?: { manual?: boolean }) => Promise<UpdateStatus>;
  applyUpdate: () => Promise<ApplyUpdateResult>;
  /**
   * applyUpdate for surfaces that cannot show the result themselves (tray
   * menu, banner button): failures and "your turn" steps become a banner
   * that opens the Updates pane. Never rejects.
   */
  applyUpdateAndReport: () => Promise<void>;
  copyInstallCommand: () => SimpleResult;
  showDownloadedFile: () => SimpleResult;
  /** Dev simulation: stage a locally built zip through the real code path. */
  stageFromZip: (zipPath: string, version: string) => Promise<void>;
  pruneStagedUpdates: (keep: string) => void;
  installedBundleId: () => string | null;
  available: () => AvailableUpdate | null;
  staged: () => StagedUpdate | null;
  setSimulatedUpdate: (update: AvailableUpdate | null) => void;
}

const BANNER_TITLE = 'DevBar — actualización';
const OPEN_UPDATES = { cta: { label: 'Ver', action: 'open-about' } };

export function createUpdater(deps: UpdaterDeps): Updater {
  let availableUpdate: AvailableUpdate | null = null;
  let lastUpdateCheckAt: string | null = null; // ISO of the last completed check
  let updateNotifiedThisLaunch = false; // banner shown at most once per launch
  let stagedUpdate: StagedUpdate | null = null; // downloaded, waiting for restart
  let stagingVersion: string | null = null; // download in flight, avoid duplicates
  // The automatic loop must not re-pull ~100 MB every 5 minutes after a
  // failure; an explicit retry from the user clears the entry.
  const stagingFailedVersions = new Set<string>();
  let devUpdateSimulated = false;
  const phase = createPhaseStore((next) => deps.send('updates:phase', next));
  const linux = createLinuxUpdateFlow(deps, phase);

  function status(): UpdateStatus {
    return {
      available: availableUpdate,
      staged: stagedUpdate,
      lastCheckAt: lastUpdateCheckAt,
      currentVersion: deps.appVersion(),
      phase: phase.get(),
    };
  }

  function broadcastStatus(): void {
    deps.send('updates:status', status());
  }

  /** Non-insistent notice for the manual (assisted) route. */
  function notifyUpdateAvailable(
    update: AvailableUpdate,
    manual: boolean,
  ): void {
    if (
      !shouldNotifyUpdate({
        manual,
        notifiedThisLaunch: updateNotifiedThisLaunch,
        configFocused: deps.configFocused(),
      })
    )
      return;
    updateNotifiedThisLaunch = true;
    deps.showBannerNotification(
      BANNER_TITLE,
      `v${update.version} disponible.`,
      OPEN_UPDATES,
    );
  }

  function announceStaged(staged: StagedUpdate): void {
    console.log(`[updates] v${staged.version} descargada, lista para instalar`);
    phase.set({
      state: 'ready-to-install',
      version: staged.version,
      path: staged.appPath,
      install: 'restart',
      command: null,
    });
    broadcastStatus();
    deps.refreshTrayIcon();
    deps.showBannerNotification(
      BANNER_TITLE,
      `v${staged.version} lista. Reinicia para instalarla.`,
      { cta: { label: 'Reiniciar', action: 'install-update' } },
    );
  }

  /** Drop previously staged versions — each one is a full copy of the app. */
  function pruneStagedUpdates(keep: string): void {
    const updatesDir = deps.updatesDir();
    try {
      for (const entry of deps.updaterFs.readdirSync(updatesDir)) {
        if (entry === keep) continue;
        const candidate = path.join(updatesDir, entry);
        if (!deps.updaterFs.isDirectory(candidate)) continue;
        deps.updaterFs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[updates] no se pudo limpiar: ${errorMessage(err)}`);
    }
  }

  /**
   * Download the platform's update artifact in the background and stage it
   * next to our config. Resolves the failure reason, or null. A failure stays
   * visible (phase + banner) and can be retried from the Updates pane.
   */
  async function stageUpdate(update: AvailableUpdate): Promise<string | null> {
    const { version } = update;
    if (
      !shouldStageUpdate({
        version,
        stagedVersion: stagedUpdate?.version ?? null,
        stagingVersion,
        failedVersions: stagingFailedVersions,
      })
    )
      return null;
    const plan = deps.stageableAsset(update, deps.installedAppPath());
    if (!plan) return null;
    stagingVersion = version;
    const updatesDir = deps.updatesDir();
    const filePath = path.join(updatesDir, plan.fileName);
    let failure: string | null = null;
    try {
      deps.updaterFs.mkdirSync(updatesDir);
      const download = await downloadVerified(deps, phase, {
        version,
        url: plan.url,
        dest: filePath,
        fileName: plan.fileName,
      });
      if (download.ok)
        stagedUpdate = await deps.stageDownloadedArtifact({
          filePath,
          destDir: path.join(updatesDir, version),
          version,
          kind: plan.kind,
        });
      else failure = download.reason;
    } catch (err) {
      failure = `no se pudo preparar: ${errorMessage(err)}`;
      phase.set({ state: 'download-failed', version, reason: failure });
    } finally {
      deps.updaterFs.rmSync(filePath, { force: true });
      stagingVersion = null;
      // Housekeeping, deliberately outside the try: a prune that trips over a
      // dangling entry must not mark a perfectly good download as failed and
      // swallow the "restart to install" notice for the rest of the session.
      if (stagedUpdate) pruneStagedUpdates(stagedUpdate.version);
    }
    if (failure === null && stagedUpdate) announceStaged(stagedUpdate);
    if (failure !== null) {
      stagingFailedVersions.add(version);
      // Not the once-per-launch notice: a failure is news even after it.
      if (!deps.configFocused())
        deps.showBannerNotification(
          BANNER_TITLE,
          `No se pudo preparar v${version}: ${failure}`,
          OPEN_UPDATES,
        );
    }
    return failure;
  }

  /**
   * Install the already-downloaded update: confirm → hand the swap to a
   * detached process → quit. The user never touches the Finder/Explorer; only
   * the confirmation is asked of them, once.
   */
  async function installStagedUpdate(
    staged: StagedUpdate,
    target: string,
  ): Promise<ApplyUpdateResult> {
    // Linux asks nothing more: the click WAS the confirmation, and a modal
    // can open behind every window on some window managers / Wayland.
    let res = { response: 1 };
    if (deps.platform !== 'linux')
      try {
        res = await deps.messageBox({
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
      deps.spawnSwap({
        staged,
        target,
        scriptDir: deps.updatesDir(),
        pid: deps.pid,
      });
    } catch (err) {
      phase.set({
        state: 'install-failed',
        version: staged.version,
        reason: errorMessage(err),
        path: staged.appPath,
        command: null,
      });
      deps.toast('error', `No se pudo instalar: ${errorMessage(err)}`);
      return { ok: false, error: errorMessage(err) };
    }
    phase.set({ state: 'restarting', version: staged.version });
    // The script polls for our exit, so a short delay is enough to let this IPC
    // reply reach the renderer before we go.
    deps.markUpdateExit();
    deps.quitAfter(200);
    return { ok: true, quitting: true, inPlace: true };
  }

  /**
   * Linux, where the Updates pane drives each step: install a verified .deb,
   * keep pointing at a manual download, retry a failed in-place staging, or
   * download what this install shape wants.
   */
  async function applyLinuxUpdate(
    update: AvailableUpdate,
    current: UpdatePhase,
    target: string | null,
  ): Promise<ApplyUpdateResult> {
    const sameVersion = phaseVersion(current) === update.version;
    if (
      sameVersion &&
      linux.hasPackage(update.version) &&
      (current.state === 'ready-to-install' ||
        current.state === 'install-failed')
    )
      return linux.install(update.version);
    if (
      sameVersion &&
      current.state === 'ready-to-install' &&
      current.install === 'manual'
    )
      return { ok: true, path: current.path };
    if (deps.stageableAsset(update, target)) {
      stagingFailedVersions.delete(update.version); // the user asked to retry
      const failure = await stageUpdate(update);
      return failure === null ? { ok: true } : { ok: false, error: failure };
    }
    return linux.download(update);
  }

  async function applyUpdate(): Promise<ApplyUpdateResult> {
    if (!availableUpdate) return { ok: false, error: 'no_update' };
    const update = availableUpdate;
    const current = phase.get();
    if (isBusyPhase(current) || stagingVersion === update.version)
      return { ok: false, busy: true };
    const staged = stagedUpdate;
    const target = deps.installedAppPath();
    let res: ApplyUpdateResult;
    if (
      staged &&
      staged.version === update.version &&
      deps.canInstallInPlace(target)
    )
      res = await installStagedUpdate(staged, target);
    else if (deps.platform === 'linux')
      res = await applyLinuxUpdate(update, current, target);
    else res = await runAssistedUpdate(deps, update, phase);
    // Failures that went through the phase store are logged there already.
    if (!res.ok && !res.cancelled && !isFailurePhase(phase.get()))
      console.error(
        `[updates] no se pudo actualizar a v${update.version}: ${res.error ?? 'desconocido'}`,
      );
    return res;
  }

  return {
    status,
    broadcastStatus,
    pruneStagedUpdates,
    applyUpdate,
    available: () => availableUpdate,
    staged: () => stagedUpdate,

    async applyUpdateAndReport(): Promise<void> {
      let res: ApplyUpdateResult;
      try {
        res = await applyUpdate();
      } catch (err) {
        res = { ok: false, error: errorMessage(err) };
        console.error(`[updates] no se pudo actualizar: ${res.error}`);
      }
      const report = applyReport(res, phase.get());
      if (report)
        deps.showBannerNotification(BANNER_TITLE, report, OPEN_UPDATES);
    },
    copyInstallCommand: () => copyPhaseCommand(phase.get(), deps.copyText),
    showDownloadedFile: () => showPhaseFile(phase.get(), deps.showItemInFolder),

    /**
     * Check GitHub for a newer release. Kept NON-insistent: at most one notice
     * per launch from the automatic loop, or on a manual check. A failed check
     * is reported as such — never as "up to date".
     */
    async runUpdateCheck({ manual = false } = {}) {
      if (manual && isSettledPhase(phase.get()))
        phase.set({ state: 'checking' });
      let found: AvailableUpdate | null;
      try {
        found = await deps.checkForUpdate({
          ...deps.repo,
          currentVersion: deps.appVersion(),
        });
      } catch (err) {
        const reason = errorMessage(err);
        if (isSettledPhase(phase.get()))
          phase.set({ state: 'check-failed', reason });
        else console.error(`[updates] check-failed: ${reason}`);
        broadcastStatus();
        return status();
      }
      lastUpdateCheckAt = new Date().toISOString();
      // A simulated update owns the slot until the dev panel releases it.
      if (!devUpdateSimulated) availableUpdate = found || null;
      const current = phase.get();
      const known = phaseVersion(current);
      // A newer release than the one a failure is about replaces that failure.
      if (
        isSettledPhase(current) ||
        (!isBusyPhase(current) &&
          known !== null &&
          known !== availableUpdate?.version)
      )
        phase.set(
          availableUpdate
            ? { state: 'available', version: availableUpdate.version }
            : { state: 'idle' },
        );
      deps.refreshTrayIcon();
      if (found && !devUpdateSimulated) {
        // When this install shape supports an in-place update, stay quiet until
        // the download is on disk — one notice ("reinicia") beats two.
        if (deps.stageableAsset(found, deps.installedAppPath()))
          void stageUpdate(found);
        else notifyUpdateAvailable(found, manual);
      }
      broadcastStatus();
      return status();
    },

    /**
     * Everything staging does once the bytes are on disk, kept apart from the
     * download so the dev simulation can exercise this half for real with a
     * locally built zip — the half where a bad bundle would actually bite.
     */
    async stageFromZip(zipPath, version): Promise<void> {
      stagedUpdate = await deps.extractUpdate({
        zipPath,
        destDir: path.join(deps.updatesDir(), version),
        version,
      });
      announceStaged(stagedUpdate);
    },

    /**
     * This build's CFBundleIdentifier, read back from the bundle it is running
     * out of. Null in a dev run, which has no bundle of ours.
     */
    installedBundleId(): string | null {
      const bundle = deps.installedAppPath();
      if (!bundle || !deps.isMac) return null;
      const plist = deps.updaterFs.readInstalledPlist(bundle);
      return plist === null ? null : parseBundleId(plist);
    },

    setSimulatedUpdate(update): void {
      devUpdateSimulated = update !== null;
      availableUpdate = update;
    },
  };
}
