import path from 'node:path';
import { errorMessage } from './ipc-validators.js';
import {
  installDebPackage,
  manualDebCommand,
  type LinuxInstallShape,
  type RunProcess,
} from './linux-package.js';
import { linuxUpdateArtifact } from './update-plan.js';
import {
  downloadVerified,
  type VerifiedDownloadDeps,
} from './update-download.js';
import type { ApplyUpdateResult } from './assisted-update.js';
import type { PhaseStore } from './update-phase.js';
import type { AvailableUpdate } from '../domain-types.js';

/**
 * The Linux update when the in-place AppImage swap is not available: a .deb
 * install, an AppImage in a read-only folder, or an unrecognised install.
 *
 * Two user steps, both driven from the Updates pane (no modal dialogs — on
 * some Linux window managers a parentless dialog opens behind everything):
 *  1. download: the artifact this install shape wants → ~/Downloads, with
 *     progress, then the SHA256 seal.
 *  2. install (.deb installs only): pkexec + apt-get, then relaunch. Anything
 *     that cannot be installed for the user ends in exact instructions.
 */

export interface LinuxUpdateDeps extends VerifiedDownloadDeps {
  arch: string;
  downloadsDir: () => string;
  linuxInstallShape: () => Promise<LinuxInstallShape>;
  makeExecutable: (target: string) => void;
  runProcess: RunProcess;
  pathExists: (target: string) => boolean;
  openExternal: (url: string) => void;
  markUpdateExit: () => void;
  relaunch: () => void;
  quitAfter: (ms: number) => void;
}

export interface LinuxUpdateFlow {
  download: (update: AvailableUpdate) => Promise<ApplyUpdateResult>;
  install: (version: string) => Promise<ApplyUpdateResult>;
  /** A verified .deb for `version` is waiting to be installed. */
  hasPackage: (version: string) => boolean;
}

export function createLinuxUpdateFlow(
  deps: LinuxUpdateDeps,
  phase: PhaseStore,
): LinuxUpdateFlow {
  // The digest is kept so the file is re-checked right before it is handed
  // to root: ~/Downloads is writable by anything running as this user.
  let pending: { version: string; path: string; digest: string } | null = null;

  async function download(update: AvailableUpdate): Promise<ApplyUpdateResult> {
    const { version } = update;
    const shape = await deps.linuxInstallShape();
    const artifact = linuxUpdateArtifact({
      version,
      update,
      shape,
      arch: deps.arch,
    });
    if (!artifact) {
      deps.openExternal(update.url);
      return { ok: true, opened: 'page' };
    }
    pending = null;
    const dest = path.join(deps.downloadsDir(), artifact.fileName);
    const res = await downloadVerified(deps, phase, {
      version,
      url: artifact.url,
      dest,
      fileName: artifact.fileName,
    });
    if (!res.ok) return { ok: false, error: res.reason };
    if (artifact.kind === 'appImage') {
      try {
        deps.makeExecutable(dest);
      } catch (err) {
        console.warn(
          `[updates] no se pudo marcar ${dest} como ejecutable: ${errorMessage(err)}`,
        );
      }
      phase.set({
        state: 'ready-to-install',
        version,
        path: dest,
        install: 'manual',
        command: null,
      });
      return { ok: true, path: dest };
    }
    if (shape === 'deb') pending = { version, path: dest, digest: res.digest };
    phase.set({
      state: 'ready-to-install',
      version,
      path: dest,
      install: shape === 'deb' ? 'package' : 'manual',
      command: manualDebCommand(dest),
    });
    return { ok: true, path: dest };
  }

  async function install(version: string): Promise<ApplyUpdateResult> {
    if (!pending || pending.version !== version)
      return { ok: false, error: 'no_package' };
    const { path: file, digest } = pending;
    const command = manualDebCommand(file);
    phase.set({ state: 'installing', version });
    const intact = await deps.verifySha256(file, digest).catch(() => false);
    if (!intact) {
      pending = null;
      const reason =
        'el paquete descargado ha cambiado o ya no está; vuelve a descargarlo';
      phase.set({ state: 'verify-failed', version, reason });
      return { ok: false, error: reason };
    }
    const res = await installDebPackage(file, {
      run: deps.runProcess,
      exists: deps.pathExists,
    });
    if (!res.ok) {
      phase.set({
        state: 'install-failed',
        version,
        reason: res.reason,
        path: file,
        command,
      });
      return { ok: false, error: res.reason };
    }
    console.log(`[updates] v${version} instalada con el gestor de paquetes`);
    phase.set({ state: 'restarting', version });
    // The package replaced the files on disk; relaunching starts the new
    // build. Marked as an update exit so the relaunch resumes the services.
    deps.markUpdateExit();
    deps.relaunch();
    deps.quitAfter(200);
    return { ok: true, quitting: true, inPlace: true };
  }

  return {
    download,
    install,
    hasPackage: (version) => pending?.version === version,
  };
}
