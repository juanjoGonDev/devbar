import path from 'node:path';
import { errorMessage } from './ipc-validators.js';
import { assistedUpdatePlan } from './update-plan.js';
import type { AvailableUpdate } from '../domain-types.js';

/**
 * The assisted update — reached when an in-place update is not possible for
 * this install shape (or before a staged download exists): download the
 * platform's artifact to the user's Downloads folder, verify its seal, and
 * hand it to the OS.
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
  quitting?: boolean;
  inPlace?: boolean;
  fellBack?: boolean;
  opened?: string;
  path?: string | undefined;
}

export interface AssistedUpdateDeps {
  repo: { owner: string; repo: string };
  platform: NodeJS.Platform;
  arch: string;
  downloadsDir: () => string;
  downloadFile: (url: string, dest: string) => Promise<string>;
  fetchReleaseSha256: (
    owner: string,
    repo: string,
    version: string,
  ) => Promise<Map<string, string> | null>;
  verifySha256: (
    filePath: string,
    expected: string | undefined,
  ) => Promise<boolean>;
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
  removeFile: (target: string) => void;
}

export async function runAssistedUpdate(
  deps: AssistedUpdateDeps,
  update: AvailableUpdate,
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
  try {
    await deps.downloadFile(plan.downloadUrl, dest);
  } catch (err) {
    deps.toast('error', `Descarga falló: ${errorMessage(err)}`);
    deps.openExternal(url); // fall back to the release page
    return { ok: false, error: errorMessage(err), fellBack: true };
  }

  try {
    const manifest = await deps.fetchReleaseSha256(
      deps.repo.owner,
      deps.repo.repo,
      version,
    );
    if (!manifest) throw new Error('no se pudo obtener SHA256SUMS.txt');
    const verified = await deps.verifySha256(dest, manifest.get(plan.destName));
    if (!verified)
      throw new Error('el hash de la descarga no coincide con SHA256SUMS.txt');
  } catch (err) {
    deps.toast(
      'error',
      `Integridad de la descarga no verificada: ${errorMessage(err)}`,
    );
    deps.removeFile(dest);
    deps.openExternal(url); // fall back to the release page
    return { ok: false, error: errorMessage(err), fellBack: true };
  }

  if (plan.postDownload !== 'hand-off') {
    const openErr = await deps.openPath(dest);
    if (openErr) {
      deps.toast('error', `No se pudo abrir el instalador: ${openErr}`);
      // macOS: don't quit and strand the user; open the release page.
      if (plan.postDownload === 'open-and-quit-with-page-fallback')
        deps.openExternal(url);
      return { ok: false, error: openErr, fellBack: true };
    }
    // Quit so the artifact can replace us. The installer / DMG mount outlives
    // this process; the single-instance lock means this is the only instance.
    // A small delay lets the Finder window surface first.
    deps.markUpdateExit();
    deps.quitAfter(1200);
    return { ok: true, path: dest, quitting: true };
  }

  // Linux package/AppImage: the user installs it with the package manager or a
  // double-click — no quit needed from us. Deliberately NOT markUpdateExit:
  // unlike the macOS/Windows branches (which quit within a second of marking),
  // this path returns and the app keeps running for as long as the user wants.
  // The exit reason has no reset, so marking here would make EVERY later exit —
  // including a deliberate tray "Salir" hours afterwards — flush the snapshot
  // as `update` and resume the services the user just stopped.
  deps.toast(
    'ok',
    `v${version} descargada a ${dest}. Cierra DevBar e instálala/éjecútala.`,
  );
  return { ok: true, path: dest };
}
