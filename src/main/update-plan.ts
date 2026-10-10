import { normalizeArch } from '../update-check.js';
import type { AvailableUpdate } from '../domain-types.js';
import type { LinuxInstallShape } from './linux-package.js';

/**
 * Every decision the update flow makes before it touches the disk or the
 * network: whether a download is worth starting, whether the user should be
 * told, which artifact this platform actually wants, and which bundle id the
 * running app was packaged with. The IO around them stays in `main.ts`; the
 * platform matrix here is what a cross-platform updater gets wrong, and it is
 * the part a test can cover on any host.
 */

/**
 * This build's CFBundleIdentifier, read out of the bundle's Info.plist.
 * Reading it beats repeating the literal from scripts/package-electron.ts,
 * which could then disagree with what was packaged.
 */
export function parseBundleId(plist: string): string | null {
  const match =
    /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  return match?.[1] ?? null;
}

/**
 * Whether background staging should start for `version`. The check loop runs
 * every 5 minutes; without the failure memo a version that fails to download
 * would re-pull ~100 MB on every tick.
 */
export function shouldStageUpdate(input: {
  version: string;
  stagedVersion: string | null;
  stagingVersion: string | null;
  failedVersions: ReadonlySet<string>;
}): boolean {
  if (input.stagedVersion === input.version) return false;
  if (input.stagingVersion === input.version) return false;
  return !input.failedVersions.has(input.version);
}

/**
 * The manual (assisted) route stays non-insistent: at most one notice per
 * launch from the automatic loop, and never while the config window is focused
 * — a manual check surfaces its result inline in config instead.
 */
export function shouldNotifyUpdate(input: {
  manual: boolean;
  notifiedThisLaunch: boolean;
  configFocused: boolean;
}): boolean {
  if (input.configFocused) return false;
  return input.manual || !input.notifiedThisLaunch;
}

export interface AssistedUpdatePlan {
  /** Null → open the release page instead of downloading anything. */
  downloadUrl: string | null;
  /** File name under the user's Downloads folder; '' when there is no download. */
  destName: string;
  detail: string;
  buttons: string[];
  /**
   * What happens once the file is on disk:
   *  - `open-and-quit-with-page-fallback` (macOS): mount the dmg, and if the
   *    mount fails open the release page rather than stranding the user.
   *  - `open-and-quit` (Windows): run the installer; a failure to open is
   *    reported without opening the page, since the installer is the only
   *    supported route.
   */
  postDownload: 'open-and-quit-with-page-fallback' | 'open-and-quit';
}

/**
 * Assisted update for macOS and Windows — reached when an in-place update is
 * not possible for this install shape (or before a staged download exists).
 *
 * - macOS:  the .dmg, then the Finder volume, then QUIT so the drag into
 *           Applications isn't blocked by the running app.
 * - Windows: the NSIS installer, which upgrades the install and relaunches;
 *           QUIT so the locked exe can be replaced.
 *
 * Linux has its own flow (`linuxUpdateArtifact` + linux-update.ts): which
 * artifact it wants depends on how it was installed, not only on the release.
 */
export function assistedUpdatePlan(input: {
  version: string;
  update: Pick<AvailableUpdate, 'dmgUrl' | 'setupUrl'>;
  platform: NodeJS.Platform;
  arch: string;
}): AssistedUpdatePlan {
  const { version, update, platform, arch } = input;
  if (platform === 'darwin' && update.dmgUrl)
    return {
      downloadUrl: update.dmgUrl,
      destName: `DevBar-${version}-macos-${arch}.dmg`,
      buttons: ['Cancelar', 'Descargar y cerrar'],
      detail:
        'Se descargará el instalador y DevBar se CERRARÁ para que puedas sustituirla (macOS no deja reemplazar la app mientras está abierta).\n\nSe abrirá una ventana del Finder: arrastra DevBar a Aplicaciones y vuelve a abrirla.',
      postDownload: 'open-and-quit-with-page-fallback',
    };
  // The NSIS installer is Windows-only: it is published for every platform,
  // and handing it to anything else would download an .exe and quit.
  if (platform === 'win32' && update.setupUrl)
    return {
      downloadUrl: update.setupUrl,
      destName: `DevBar-${version}-win-${arch}-setup.exe`,
      buttons: ['Cancelar', 'Descargar y cerrar'],
      detail:
        'Se descargará el instalador, DevBar se CERRARÁ y el instalador actualizará la aplicación en su sitio.',
      postDownload: 'open-and-quit',
    };
  return {
    downloadUrl: null,
    destName: '',
    buttons: ['Cancelar', 'Descargar'],
    detail:
      'Se abrirá la página de la release para descargar la nueva versión.',
    postDownload: 'open-and-quit',
  };
}

export interface LinuxUpdateArtifact {
  url: string;
  /** Must match the release asset name: the SHA256 lookup keys on it. */
  fileName: string;
  kind: 'deb' | 'appImage';
}

/**
 * The artifact a Linux install downloads when it cannot swap in place. The
 * install shape decides: an AppImage user is NEVER handed the .deb (it would
 * install a second, system-wide copy next to the one they run), a .deb
 * install gets the package its package manager can upgrade, and anything
 * unrecognised gets the package first.
 */
export function linuxUpdateArtifact(input: {
  version: string;
  update: Pick<AvailableUpdate, 'debUrl' | 'appImageUrl'>;
  shape: LinuxInstallShape;
  arch: string;
}): LinuxUpdateArtifact | null {
  const { version, update, shape } = input;
  // linux-armv7.* — Node reports 32-bit ARM as `arm`.
  const arch = normalizeArch('linux', input.arch);
  const deb = update.debUrl
    ? {
        url: update.debUrl,
        fileName: `DevBar-${version}-linux-${arch}.deb`,
        kind: 'deb' as const,
      }
    : null;
  const appImage = update.appImageUrl
    ? {
        url: update.appImageUrl,
        fileName: `DevBar-${version}-linux-${arch}.AppImage`,
        kind: 'appImage' as const,
      }
    : null;
  if (shape === 'appImage') return appImage;
  return deb ?? appImage;
}
