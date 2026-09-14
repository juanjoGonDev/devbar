import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLinux, isMac } from './platform.js';
import {
  bundlePathFromExecutable,
  canInstallInPlace as macCanInstallInPlace,
  extractUpdate,
  spawnSwap as macSpawnSwap,
} from './self-update-macos.js';
import {
  appImagePathFromExecutable,
  canInstallInPlace as linuxCanInstallInPlace,
  stageAppImage,
  spawnSwap as linuxSpawnSwap,
} from './self-update-linux.js';
import {
  isInstalledExe,
  stageWindowsArtifact,
  spawnSwapBat,
  spawnInstaller,
} from './self-update-windows.js';
import type { AvailableUpdate, StagedUpdate } from './domain-types.js';

/**
 * Platform facade for the in-app updater. Each platform has its own install
 * shape, so its own artifact and swap mechanism:
 *
 * - macOS:  release .zip → unpacked .app, swapped over the installed bundle.
 * - Linux:  .AppImage file renamed into place (.deb installs are NOT
 *           updatable in place — they use the assisted download flow).
 * - Windows: installed (NSIS per-user) → run the new installer after quit;
 *           portable (any folder) → folder swap; Program Files install →
 *           assisted flow only (needs elevation the app must not request).
 */

export {
  bundlePathFromExecutable,
  extractUpdate,
  buildSwapScript as buildMacSwapScript,
} from './self-update-macos.js';
export {
  appImagePathFromExecutable,
  buildSwapScript as buildLinuxSwapScript,
  looksLikeAppImage,
} from './self-update-linux.js';
export {
  buildSwapBat,
  isInstalledExe,
  looksLikeWindowsExe,
  looksLikeZip,
} from './self-update-windows.js';

export type StagedKind =
  'macBundle' | 'appImage' | 'winInstaller' | 'winPortable';

/**
 * The installed app we would replace, or null when that is not our shape.
 *
 * Reads `process.execPath` / `process.defaultApp` (the standard Electron
 * unpackaged detection) rather than `app`, so this module stays testable
 * without the electron binary.
 */
export function installedAppPath(): string | null {
  if (process.defaultApp) return null; // dev run out of node_modules/electron
  if (isMac) return bundlePathFromExecutable(process.execPath);
  if (isLinux) return appImagePathFromExecutable(process.execPath);
  return process.execPath;
}

export type WindowsUpdateMode = 'nsis' | 'portable' | 'assisted';

export function windowsUpdateMode(installed: string): WindowsUpdateMode {
  if (isInstalledExe(installed)) return 'nsis';
  const parent = path.win32
    .basename(path.win32.dirname(path.win32.dirname(installed)))
    .toLowerCase();
  if (parent === 'program files' || parent === 'program files (x86)')
    return 'assisted';
  return 'portable';
}

/** Whether an in-place update is possible for this installed path. */
export function canInstallInPlace(
  installed: string | null,
): installed is string {
  if (!installed) return false;
  if (isMac) return macCanInstallInPlace(installed);
  if (isLinux) return linuxCanInstallInPlace(installed);
  return windowsUpdateMode(installed) !== 'assisted';
}

function assetBasename(url: string): string {
  return path.posix.basename(new URL(url).pathname);
}

/**
 * The artifact an in-place update must download for this platform + install
 * shape, or null when only the assisted flow applies.
 */
export function stageableAsset(
  update: AvailableUpdate,
  installed: string | null,
): { url: string; fileName: string; kind: StagedKind } | null {
  if (!installed || !canInstallInPlace(installed)) return null;
  if (isMac) {
    if (!update.zipUrl) return null;
    return {
      url: update.zipUrl,
      fileName: assetBasename(update.zipUrl),
      kind: 'macBundle',
    };
  }
  if (isLinux) {
    if (!update.appImageUrl) return null;
    return {
      url: update.appImageUrl,
      fileName: assetBasename(update.appImageUrl),
      kind: 'appImage',
    };
  }
  const mode = windowsUpdateMode(installed);
  if (mode === 'nsis' && update.setupUrl)
    return {
      url: update.setupUrl,
      fileName: assetBasename(update.setupUrl),
      kind: 'winInstaller',
    };
  if (mode === 'portable' && update.zipUrl)
    return {
      url: update.zipUrl,
      fileName: assetBasename(update.zipUrl),
      kind: 'winPortable',
    };
  return null;
}

/**
 * Verify a downloaded file against the release's SHA256SUMS.txt entry — the
 * integrity seal for every unsigned-download path (macOS adds a codesign
 * check on top of this).
 */
export async function verifySha256(
  filePath: string,
  expectedHex: string | undefined,
): Promise<boolean> {
  if (!expectedHex) return false;
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex').toLowerCase() === expectedHex.toLowerCase();
}

/**
 * Place a downloaded (and hash-verified) artifact into the per-version
 * staging dir and hand back the staged update.
 */
export async function stageDownloadedArtifact({
  filePath,
  destDir,
  version,
  kind,
}: {
  filePath: string;
  destDir: string;
  version: string;
  kind: StagedKind;
}): Promise<StagedUpdate> {
  switch (kind) {
    case 'macBundle':
      return extractUpdate({ zipPath: filePath, destDir, version });
    case 'appImage':
      return {
        version,
        appPath: stageAppImage({
          filePath,
          destDir,
          fileName: path.basename(filePath),
        }),
      };
    case 'winInstaller':
      return {
        version,
        appPath: stageWindowsArtifact({
          filePath,
          destDir,
          fileName: path.basename(filePath),
        }),
      };
    case 'winPortable':
      return {
        version,
        appPath: stageWindowsArtifact({
          filePath,
          destDir,
          fileName: path.basename(filePath),
        }),
      };
  }
}

/**
 * Spawn the detached process that performs the swap/install. The caller quits
 * right after; the child waits for the pid to die before touching anything.
 */
export function spawnSwap({
  staged,
  target,
  scriptDir,
  pid,
}: {
  staged: StagedUpdate;
  target: string;
  scriptDir: string;
  pid: number;
}): void {
  fs.mkdirSync(scriptDir, { recursive: true });
  if (isMac) {
    macSpawnSwap({
      scriptPath: path.join(scriptDir, 'swap.sh'),
      pid,
      target,
      staged: staged.appPath,
    });
    return;
  }
  if (isLinux) {
    linuxSpawnSwap({
      scriptPath: path.join(scriptDir, 'swap.sh'),
      pid,
      target,
      staged: staged.appPath,
    });
    return;
  }
  const mode = windowsUpdateMode(target);
  if (mode === 'nsis') {
    spawnInstaller(staged.appPath);
  } else {
    // Portable = a single self-extracting exe: plain file swap.
    spawnSwapBat({
      scriptPath: path.join(scriptDir, 'swap.bat'),
      pid,
      target,
      staged: staged.appPath,
    });
  }
}
