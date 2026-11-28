import path from 'node:path';
import { errorMessage } from './ipc-validators.js';
import {
  installedBundleIdOf,
  shouldNotifyUpdate,
  shouldStageUpdate,
} from './update-plan.js';
import {
  runAssistedUpdate,
  type ApplyUpdateResult,
  type AssistedUpdateDeps,
} from './assisted-update.js';
import { createLinuxUpdateFlow, type LinuxUpdateDeps } from './linux-update.js';
import { pruneStagedVersions } from './update-prune.js';
import { downloadVerified } from './update-download.js';
import { installStagedUpdate } from './install-staged-update.js';
import {
  applyAndReport,
  copyPhaseCommand,
  noticeReady,
  showPhaseFile,
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
import { UnsupportedSystemError } from '../self-update-macos.js';
import type { Updater } from './updater-api.js';

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
  /** The «Actualizar automáticamente» switch, read on every automatic check. */
  autoUpdate: () => boolean;
  /** The «Reiniciar e instalar» modal (see install-staged-update.ts). */
  confirmInstall: (version: string) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
  showItemInFolder: (target: string) => void;
}

const BANNER_TITLE = 'DevBar — actualización';
/**
 * Why the dev simulations leave the update alone while the install modal
 * waits: it owns the staged copy, and the release it asks about must stay the
 * one a phone can install too.
 */
const MODAL_OWNS_UPDATE = 'aviso de instalación abierto o descarga en curso';
const OPEN_UPDATES = { cta: { label: 'Ver', action: 'open-about' } };

export function createUpdater(deps: UpdaterDeps): Updater {
  let availableUpdate: AvailableUpdate | null = null;
  let lastUpdateCheckAt: string | null = null; // ISO of the last completed check
  let updateNotifiedThisLaunch = false; // banner shown at most once per launch
  let stagedUpdate: StagedUpdate | null = null; // downloaded, waiting for restart
  let stagingVersion: string | null = null; // download in flight, avoid duplicates
  let asking = false; // the install modal is waiting for an answer
  // A newer release a check found while another downloaded, and whether that
  // check was asked for: it gets the slot when the download ends.
  let pendingStage: { update: AvailableUpdate; manual: boolean } | null = null;
  // The automatic loop must not re-pull ~100 MB every 5 minutes after a
  // failure; an explicit retry from the user clears the entry.
  const stagingFailedVersions = new Set<string>();
  // Versions this Mac cannot launch, with the reason. Unlike a failed
  // download, retrying cannot help, and the assisted .dmg route never runs
  // the check: a retry must answer the reason instead of taking that route.
  const unsupportedVersions = new Map<string, string>();
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
    // A newer release turned up while this one downloaded: this copy is no
    // longer the update, so it is neither announced nor offered (the newer
    // one waits in `pendingStage` for the slot).
    if (availableUpdate && availableUpdate.version !== staged.version) {
      phase.set({ state: 'available', version: availableUpdate.version });
      broadcastStatus();
      return;
    }
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
    noticeReady(deps.showBannerNotification, BANNER_TITLE, staged.version);
    // Asks with the install modal and waits for the answer: installing
    // restarts DevBar (and the services it runs), so it never happens alone.
    // Only about this copy: a newer release found meanwhile is the next
    // check's to stage and ask about, never an unrequested assisted download.
    // `swappable`: the staged copy is still the release and still fits the
    // install folder; otherwise there is nothing to ask about here.
    if (swappable()) void applyUpdateAndReport();
  }

  /** Drop the other staged versions, never the one being unpacked now. */
  const pruneStagedUpdates = (keep: string): void =>
    pruneStagedVersions(deps.updaterFs, deps.updatesDir(), [
      keep,
      stagingVersion,
    ]);

  /**
   * Download the platform's update artifact in the background and stage it
   * next to our config. Resolves the failure reason, or null. A failure stays
   * visible (phase + banner) and can be retried from the Updates pane.
   */
  // Resolves the failure reason, or null.
  async function stageUpdate(update: AvailableUpdate, manual = false) {
    const { version } = update;
    if (stagingVersion !== null && stagingVersion !== version) {
      // One download at a time. A later automatic check for the same release
      // must not undo a manual request for it.
      const asked =
        pendingStage?.update.version === version && pendingStage.manual;
      pendingStage = { update, manual: manual || asked };
      return null;
    }
    // Once a swap is under way, a new staging would prune the copy it uses.
    if (isBusyPhase(phase.get())) return null;
    if (
      !shouldStageUpdate({
        version,
        stagedVersion: stagedUpdate?.version ?? null,
        stagingVersion,
        failedVersions: stagingFailedVersions,
      })
    )
      return null;
    // The open install modal is about the staged copy: staging a newer one
    // would prune it from under the answer. The next check stages it.
    if (asking) return null;
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
      if (err instanceof UnsupportedSystemError)
        unsupportedVersions.set(version, err.message);
      phase.set({ state: 'download-failed', version, reason: failure });
    } finally {
      stagingVersion = null; // first: a failed removal must not keep the slot
      try {
        deps.updaterFs.rmSync(filePath, { force: true });
      } catch (err) {
        console.warn(`[updates] no se pudo borrar: ${errorMessage(err)}`);
      }
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
    // Its turn now, success or not, if its check was asked for or automatic
    // updates are still on.
    const next = pendingStage;
    pendingStage = null;
    if (next && (next.manual || deps.autoUpdate()))
      void stageUpdate(next.update, next.manual);
    return failure;
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
    const unsupported = unsupportedVersions.get(update.version);
    if (unsupported) return { ok: false, error: unsupported };
    const current = phase.get();
    // `asking`: the install modal is already up; a second one would queue.
    if (isBusyPhase(current) || stagingVersion !== null || asking)
      return { ok: false, busy: true };
    const staged = stagedUpdate;
    const target = deps.installedAppPath();
    let res: ApplyUpdateResult;
    if (
      staged &&
      staged.version === update.version &&
      deps.canInstallInPlace(target)
    ) {
      asking = true;
      res = await installStagedUpdate(deps, phase, staged, target).finally(
        () => (asking = false),
      );
    } else if (deps.platform === 'linux')
      res = await applyLinuxUpdate(update, current, target);
    else res = await runAssistedUpdate(deps, update, phase);
    // Failures that went through the phase store are logged there already.
    if (!res.ok && !res.cancelled && !isFailurePhase(phase.get()))
      console.error(
        `[updates] no se pudo actualizar a v${update.version}: ${res.error ?? 'desconocido'}`,
      );
    return res;
  }

  /**
   * applyUpdate for surfaces that cannot show the result themselves: failures
   * and "your turn" steps become a banner that opens the Updates pane.
   */
  const applyUpdateAndReport = (): Promise<void> =>
    applyAndReport(applyUpdate, phase.get, (report) =>
      deps.showBannerNotification(BANNER_TITLE, report, OPEN_UPDATES),
    );

  /** The staged update and where it goes, when a swap could start now. */
  const swappable = (): { staged: StagedUpdate; target: string } | null => {
    const staged = stagedUpdate;
    const target = deps.installedAppPath();
    if (
      !staged ||
      staged.version !== availableUpdate?.version ||
      isBusyPhase(phase.get()) ||
      stagingVersion !== null ||
      !deps.canInstallInPlace(target)
    )
      return null;
    return { staged, target };
  };

  return {
    status,
    broadcastStatus,
    pruneStagedUpdates,
    applyUpdate,
    canInstallStaged: () => swappable() !== null,
    installStagedHeadless: async () => {
      const ready = swappable();
      if (!ready) return { ok: false, error: 'not_staged' };
      return installStagedUpdate(deps, phase, ready.staged, ready.target, {
        ask: false,
      });
    },
    available: () => availableUpdate,
    staged: () => stagedUpdate,
    applyUpdateAndReport,
    copyInstallCommand: () => copyPhaseCommand(phase.get(), deps.copyText),
    showDownloadedFile: () => showPhaseFile(phase.get(), deps.showItemInFolder),

    /**
     * Check GitHub for a newer release. Kept NON-insistent: at most one notice
     * per launch from the automatic loop, or on a manual check. A failed check
     * is reported as such — never as "up to date".
     */
    async runUpdateCheck({ manual = false } = {}) {
      if (!manual && !deps.autoUpdate()) return status();
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
      // A simulated update owns the slot until the dev panel releases it, and
      // the install modal owns it while it waits (a phone installs that one);
      // a newer release is picked up by the next check.
      if (!devUpdateSimulated && !asking) availableUpdate = found || null;
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
        if (deps.stageableAsset(found, deps.installedAppPath())) {
          // The switch may have gone off while the check was in flight.
          if (manual || deps.autoUpdate()) void stageUpdate(found, manual);
        } else notifyUpdateAvailable(found, manual);
      }
      broadcastStatus();
      return status();
    },

    /**
     * Everything staging does once the bytes are on disk, kept apart from the
     * download so the dev simulation can exercise this half for real with a
     * locally built zip — the half where a bad bundle would actually bite.
     */
    async stageFromZip(zipPath, update): Promise<void> {
      // A real download finishing later would prune what this stages, even
      // with its modal open (the real paths never open one mid-download).
      if (asking || stagingVersion !== null) throw new Error(MODAL_OWNS_UPDATE);
      // Unpacking over the staged copy would wipe it before knowing it works.
      if (stagedUpdate?.version === update.version)
        throw new Error(`v${update.version} ya está preparada`);
      stagingVersion = update.version; // and no real download starts meanwhile
      const unpacking = deps.extractUpdate({
        zipPath,
        destDir: path.join(deps.updatesDir(), update.version),
        version: update.version,
      });
      const staged = await unpacking.finally(() => (stagingVersion = null));
      // Published only with its copy on disk: a failure leaves it as it was.
      unsupportedVersions.delete(update.version);
      devUpdateSimulated = true;
      availableUpdate = update;
      stagedUpdate = staged;
      announceStaged(staged);
    },

    installedBundleId: () => installedBundleIdOf(deps),

    setSimulatedUpdate(update): void {
      if (asking || stagingVersion !== null) throw new Error(MODAL_OWNS_UPDATE);
      devUpdateSimulated = update !== null;
      availableUpdate = update;
    },
  };
}
