import { errorMessage } from './ipc-validators.js';
import type { DownloadOptions } from './download-file.js';
import type { PhaseStore } from './update-phase.js';

/**
 * Download an update artifact and check it against the release's
 * SHA256SUMS.txt, walking the phase machine as it goes (downloading with
 * progress → verifying, or the matching failure). Shared by background
 * staging and the assisted/Linux flows, so every route reports progress and
 * failures the same way.
 *
 * The integrity seal is required on every platform — the ad-hoc signature
 * carries no publisher identity, so a missing manifest leaves no trust anchor.
 * Fail closed: a file that is not verified is deleted and never handed on.
 */

export interface VerifiedDownloadDeps {
  repo: { owner: string; repo: string };
  downloadFile: (
    url: string,
    dest: string,
    options?: DownloadOptions,
  ) => Promise<string>;
  fetchReleaseSha256: (
    owner: string,
    repo: string,
    version: string,
  ) => Promise<Map<string, string> | null>;
  verifySha256: (
    filePath: string,
    expected: string | undefined,
  ) => Promise<boolean>;
  removeFile: (target: string) => void;
}

export type VerifiedDownload =
  | { ok: true; digest: string }
  | { ok: false; step: 'download' | 'verify'; reason: string };

export async function downloadVerified(
  deps: VerifiedDownloadDeps,
  phase: PhaseStore,
  input: { version: string; url: string; dest: string; fileName: string },
): Promise<VerifiedDownload> {
  const { version, url, dest, fileName } = input;
  phase.set({ state: 'downloading', version, received: 0, total: null });
  try {
    await deps.downloadFile(url, dest, {
      onProgress: ({ received, total }) =>
        phase.set({ state: 'downloading', version, received, total }),
    });
  } catch (err) {
    const reason = errorMessage(err);
    deps.removeFile(dest); // a partial file must not look like a download
    phase.set({ state: 'download-failed', version, reason });
    return { ok: false, step: 'download', reason };
  }
  phase.set({ state: 'verifying', version });
  try {
    const manifest = await deps.fetchReleaseSha256(
      deps.repo.owner,
      deps.repo.repo,
      version,
    );
    if (!manifest) throw new Error('no se pudo obtener SHA256SUMS.txt');
    const digest = manifest.get(fileName);
    if (!(await deps.verifySha256(dest, digest)) || !digest)
      throw new Error('el hash de la descarga no coincide con SHA256SUMS.txt');
    return { ok: true, digest };
  } catch (err) {
    const reason = errorMessage(err);
    deps.removeFile(dest);
    phase.set({ state: 'verify-failed', version, reason });
    return { ok: false, step: 'verify', reason };
  }
}
