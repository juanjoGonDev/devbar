import { normalizeArch } from '../update-check.js';
import type { AvailableUpdate } from '../domain-types.js';

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
   *  - `hand-off` (Linux): tell the user where the file is and keep running.
   */
  postDownload:
    'open-and-quit-with-page-fallback' | 'open-and-quit' | 'hand-off';
}

/**
 * Assisted update — reached when an in-place update is not possible for this
 * install shape (or before a staged download exists).
 *
 * - macOS:  the .dmg, then the Finder volume, then QUIT so the drag into
 *           Applications isn't blocked by the running app.
 * - Windows: the NSIS installer, which upgrades the install and relaunches;
 *           QUIT so the locked exe can be replaced.
 * - Linux:  the .deb (or AppImage) into Downloads, and the user takes it from
 *           there — system installs need the package manager.
 */
export function assistedUpdatePlan(input: {
  version: string;
  update: Pick<
    AvailableUpdate,
    'dmgUrl' | 'setupUrl' | 'debUrl' | 'appImageUrl'
  >;
  platform: NodeJS.Platform;
  arch: string;
}): AssistedUpdatePlan {
  const { version, update, platform, arch } = input;
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const isLinux = platform === 'linux';
  if (isMac && update.dmgUrl)
    return {
      downloadUrl: update.dmgUrl,
      destName: `DevBar-${version}-macos-${arch}.dmg`,
      buttons: ['Cancelar', 'Descargar y cerrar'],
      detail:
        'Se descargará el instalador y DevBar se CERRARÁ para que puedas sustituirla (macOS no deja reemplazar la app mientras está abierta).\n\nSe abrirá una ventana del Finder: arrastra DevBar a Aplicaciones y vuelve a abrirla.',
      postDownload: 'open-and-quit-with-page-fallback',
    };
  // The NSIS installer is Windows-only: a `!isMac` guard would make LINUX
  // download the .exe (it is published for every platform) and quit instead of
  // reaching the deb/AppImage branches below.
  if (isWin && update.setupUrl)
    return {
      downloadUrl: update.setupUrl,
      destName: `DevBar-${version}-win-${arch}-setup.exe`,
      buttons: ['Cancelar', 'Descargar y cerrar'],
      detail:
        'Se descargará el instalador, DevBar se CERRARÁ y el instalador actualizará la aplicación en su sitio.',
      postDownload: 'open-and-quit',
    };
  const defaults = {
    buttons: ['Cancelar', 'Descargar'],
    postDownload: 'hand-off' as const,
  };
  // `isLinux`, not `!isMac`: the .deb and the AppImage are Linux-only, exactly
  // as the setup.exe is Windows-only above. With `!isMac`, a release that
  // published no setup.exe handed a WINDOWS user a Debian package and told
  // them to install it.
  if (isLinux && update.debUrl)
    return {
      ...defaults,
      downloadUrl: update.debUrl,
      // Must match the release asset naming (linux-armv7.*), otherwise the
      // SHA256 manifest lookup for this file name would miss on 32-bit ARM.
      destName: `DevBar-${version}-linux-${normalizeArch(platform, arch)}.deb`,
      detail:
        'Se abrirá la página de la release para descargar la nueva versión.',
    };
  if (isLinux && update.appImageUrl)
    return {
      ...defaults,
      downloadUrl: update.appImageUrl,
      destName: `DevBar-${version}-linux-${normalizeArch(platform, arch)}.AppImage`,
      detail:
        'Se descargará la AppImage a Descargas. Cierra DevBar y ejecútala desde ahí (o cópiala a ~/Applications).',
    };
  return {
    ...defaults,
    downloadUrl: null,
    destName: '',
    detail:
      'Se abrirá la página de la release para descargar la nueva versión.',
  };
}
