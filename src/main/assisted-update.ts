import path from 'node:path';
import { errorMessage } from './ipc-validators.js';
import { assistedUpdatePlan } from './update-plan.js';
import {
  downloadVerified,
  type VerifiedDownloadDeps,
} from './update-download.js';
import type { PhaseStore } from './update-phase.js';
import type { AvailableUpdate } from '../domain-types.js';

/**
 * The assisted update for macOS and Windows — reached when an in-place update
 * is not possible for this install shape (or before a staged download exists):
 * download the platform's artifact to the user's Downloads folder, verify its
 * seal, and hand it to the OS. Linux has its own flow (linux-update.ts).
 *
 * The seal has to be checked HERE rather than during staging, because the file
 * is opened straight from Downloads — mounted, installed or executed by the OS
 * (CWE-494). A missing manifest or a digest mismatch falls back to the release
 * page instead of handing an unverified file to the system.
 */

export interface ApplyUpdateResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  /** Another download/install is already running; nothing was started. */
  busy?: boolean;
  quitting?: boolean;
  inPlace?: boolean;
  fellBack?: boolean;
  opened?: string;
  path?: string | undefined;
}

export interface AssistedUpdateDeps extends VerifiedDownloadDeps {
  platform: NodeJS.Platform;
  arch: string;
  downloadsDir: () => string;
  messageBox: (options: {
    type: 'question' | 'warning';
    buttons: string[];
    defaultId: number;
    cancelId: number;
    message: string;
    detail: string;
  }) => Promise<{ response: number }>;
  openPath: (target: string) => Promise<string>;
  openExternal: (url: string) => void;
  showBannerNotification: (
    title: string,
    body: string,
    options?: { cta?: { label: string; action: string } },
  ) => void;
  toast: (kind: string, message: string) => void;
  /** Record this exit as an UPDATE so the relaunch may resume the services. */
  markUpdateExit: () => void;
  quitAfter: (ms: number) => void;
}

export async function runAssistedUpdate(
  deps: AssistedUpdateDeps,
  update: AvailableUpdate,
  phase: PhaseStore,
): Promise<ApplyUpdateResult> {
  const { version, url } = update;
  const plan = assistedUpdatePlan({
    version,
    update,
    platform: deps.platform,
    arch: deps.arch,
  });
  let res;
  try {
    res = await deps.messageBox({
      type: 'question',
      buttons: plan.buttons,
      defaultId: 1,
      cancelId: 0,
      message: `Actualizar a DevBar v${version}`,
      detail: plan.detail,
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (res.response !== 1) return { ok: false, cancelled: true };
  if (!plan.downloadUrl) {
    deps.openExternal(url);
    return { ok: true, opened: 'page' };
  }

  const dest = path.join(deps.downloadsDir(), plan.destName);
  deps.showBannerNotification(
    'DevBar — actualización',
    `Descargando v${version}…`,
  );
  const download = await downloadVerified(deps, phase, {
    version,
    url: plan.downloadUrl,
    dest,
    fileName: plan.destName,
  });
  if (!download.ok) {
    deps.toast(
      'error',
      download.step === 'download'
        ? `Descarga falló: ${download.reason}`
        : `Integridad de la descarga no verificada: ${download.reason}`,
    );
    deps.openExternal(url); // fall back to the release page
    return { ok: false, error: download.reason, fellBack: true };
  }

  const openErr = await deps.openPath(dest);
  if (openErr) {
    phase.set({
      state: 'install-failed',
      version,
      reason: openErr,
      path: dest,
      command: null,
    });
    deps.toast('error', `No se pudo abrir el instalador: ${openErr}`);
    // macOS: don't quit and strand the user; open the release page.
    if (plan.postDownload === 'open-and-quit-with-page-fallback')
      deps.openExternal(url);
    return { ok: false, error: openErr, fellBack: true };
  }
  // Quit so the artifact can replace us. The installer / DMG mount outlives
  // this process; the single-instance lock means this is the only instance.
  // A small delay lets the Finder window surface first.
  phase.set({ state: 'restarting', version });
  deps.markUpdateExit();
  deps.quitAfter(1200);
  return { ok: true, path: dest, quitting: true };
}
