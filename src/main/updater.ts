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
import type { AvailableUpdate, StagedUpdate } from '../domain-types.js';
import type { UpdateStatus } from '../ipc-contract.js';

/**
 * The update lifecycle around the assisted flow: check GitHub, stage the
 * artifact in the background so applying it later is just a swap-and-relaunch,
 * and install it. Every decision lives in `update-plan.ts`; what is left here
 * is the IO ORDER, which is what makes an update unsafe when it is wrong (an
 * unverified artifact handed to the OS, a prune that deletes the download that
 * just succeeded).
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

export interface UpdaterDeps extends AssistedUpdateDeps {
  appVersion: () => string;
  isMac: boolean;
  pid: number;
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
  sendUpdateStatus: (payload: UpdateStatus) => void;
  refreshTrayIcon: () => void;
  configFocused: () => boolean;
}

export interface Updater {
  status: () => UpdateStatus;
  broadcastStatus: () => void;
  runUpdateCheck: (options?: { manual?: boolean }) => Promise<{
    available: AvailableUpdate | null;
    staged: StagedUpdate | null;
    lastCheckAt: string | null;
  }>;
  applyUpdate: () => Promise<ApplyUpdateResult>;
  /** Dev simulation: stage a locally built zip through the real code path. */
  stageFromZip: (zipPath: string, version: string) => Promise<void>;
  pruneStagedUpdates: (keep: string) => void;
  installedBundleId: () => string | null;
  available: () => AvailableUpdate | null;
  staged: () => StagedUpdate | null;
  setSimulatedUpdate: (update: AvailableUpdate | null) => void;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  let availableUpdate: AvailableUpdate | null = null;
  let lastUpdateCheckAt: string | null = null; // ISO of the last completed check
  let updateNotifiedThisLaunch = false; // banner shown at most once per launch
  let stagedUpdate: StagedUpdate | null = null; // downloaded, waiting for restart
  let stagingVersion: string | null = null; // download in flight, avoid duplicates
  const stagingFailedVersions = new Set<string>(); // don't retry a bad download
  let devUpdateSimulated = false;

  function status(): UpdateStatus {
    return {
      available: availableUpdate,
      staged: stagedUpdate,
      lastCheckAt: lastUpdateCheckAt,
      currentVersion: deps.appVersion(),
    };
  }

  function broadcastStatus(): void {
    deps.sendUpdateStatus(status());
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
      'DevBar — actualización',
      `v${update.version} disponible.`,
      { cta: { label: 'Ver', action: 'open-about' } },
    );
  }

  function announceStaged(version: string): void {
    console.log(`[updates] v${version} descargada, lista para instalar`);
    broadcastStatus();
    deps.refreshTrayIcon();
    deps.showBannerNotification(
      'DevBar — actualización',
      `v${version} lista. Reinicia para instalarla.`,
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
   * Download the platform's update artifact in the background and stage it next
   * to our config. Any failure falls back to the assisted "download it
   * yourself" notice rather than going silent.
   */
  async function stageUpdate(update: AvailableUpdate): Promise<void> {
    if (
      !shouldStageUpdate({
        version: update.version,
        stagedVersion: stagedUpdate?.version ?? null,
        stagingVersion,
        failedVersions: stagingFailedVersions,
      })
    )
      return;
    const plan = deps.stageableAsset(update, deps.installedAppPath());
    if (!plan) return;
    stagingVersion = update.version;
    const updatesDir = deps.updatesDir();
    const filePath = path.join(updatesDir, plan.fileName);
    try {
      deps.updaterFs.mkdirSync(updatesDir);
      await deps.downloadFile(plan.url, filePath);
      // Integrity seal: the release's SHA256SUMS.txt, required on every
      // platform — the ad-hoc signature carries no publisher identity, so a
      // missing manifest leaves no trust anchor anywhere. Fail closed: releases
      // always publish it (part of the artifact contract), so when it cannot be
      // fetched, abort staging instead of installing an unverified file.
      const manifest = await deps.fetchReleaseSha256(
        deps.repo.owner,
        deps.repo.repo,
        update.version,
      );
      if (!manifest) throw new Error('no se pudo obtener SHA256SUMS.txt');
      const verified = await deps.verifySha256(
        filePath,
        manifest.get(plan.fileName),
      );
      if (!verified)
        throw new Error(
          'el hash de la descarga no coincide con SHA256SUMS.txt',
        );
      stagedUpdate = await deps.stageDownloadedArtifact({
        filePath,
        destDir: path.join(updatesDir, update.version),
        version: update.version,
        kind: plan.kind,
      });
      announceStaged(update.version);
    } catch (err) {
      stagingFailedVersions.add(update.version);
      console.warn(
        `[updates] no se pudo preparar v${update.version}: ${errorMessage(err)}`,
      );
      notifyUpdateAvailable(update, false);
    } finally {
      deps.updaterFs.rmSync(filePath, { force: true });
      stagingVersion = null;
      // Housekeeping, deliberately outside the try: a prune that trips over a
      // dangling entry must not mark a perfectly good download as failed and
      // swallow the "restart to install" notice for the rest of the session.
      if (stagedUpdate) pruneStagedUpdates(stagedUpdate.version);
    }
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
    let res;
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
      deps.toast('error', `No se pudo instalar: ${errorMessage(err)}`);
      return { ok: false, error: errorMessage(err) };
    }
    // The script polls for our exit, so a short delay is enough to let this IPC
    // reply reach the renderer before we go.
    deps.markUpdateExit();
    deps.quitAfter(200);
    return { ok: true, quitting: true, inPlace: true };
  }

  return {
    status,
    broadcastStatus,
    pruneStagedUpdates,
    available: () => availableUpdate,
    staged: () => stagedUpdate,

    applyUpdate(): Promise<ApplyUpdateResult> {
      if (!availableUpdate)
        return Promise.resolve({ ok: false, error: 'no_update' });
      const update = availableUpdate;
      const staged = stagedUpdate;
      const target = deps.installedAppPath();
      if (
        staged &&
        staged.version === update.version &&
        deps.canInstallInPlace(target)
      )
        return installStagedUpdate(staged, target);
      return runAssistedUpdate(deps, update);
    },

    /**
     * Check GitHub for a newer release. Kept NON-insistent: at most one notice
     * per launch from the automatic loop, or on a manual check.
     */
    async runUpdateCheck({ manual = false } = {}) {
      const found = await deps.checkForUpdate({
        ...deps.repo,
        currentVersion: deps.appVersion(),
      });
      lastUpdateCheckAt = new Date().toISOString();
      // A simulated update owns the slot until the dev panel releases it.
      if (!devUpdateSimulated) availableUpdate = found || null;
      deps.refreshTrayIcon();
      if (found && !devUpdateSimulated) {
        // When this install shape supports an in-place update, stay quiet until
        // the download is on disk — one notice ("reinicia") beats two.
        if (deps.stageableAsset(found, deps.installedAppPath()))
          void stageUpdate(found);
        else notifyUpdateAvailable(found, manual);
      }
      broadcastStatus();
      return {
        available: availableUpdate,
        staged: stagedUpdate,
        lastCheckAt: lastUpdateCheckAt,
      };
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
      announceStaged(version);
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
