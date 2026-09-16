import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Linux in-place update for AppImage installs. An AppImage is a single
 * executable file, so the whole update is: wait for the old process, rename
 * it aside, put the new file in, relaunch. Same shape as the macOS bundle
 * swap — only the artifact and the relaunch command differ.
 *
 * .deb installs are NOT updatable in place (system directories); those users
 * get the assisted "download the .deb" flow instead.
 */

/**
 * The running AppImage, or null when not one (dev run, .deb install).
 * A running type 2 AppImage executes the payload from a MOUNTED squashfs,
 * so `process.execPath` is a path inside the tmp mount (e.g.
 * /tmp/.mount_DevBarXXX/devbar) — never the .AppImage file. The runtime
 * exposes the real file through $APPIMAGE ("shall be used every time the
 * full path of the AppImage is needed"), so that is the primary source;
 * the .AppImage execPath is the fallback for direct execution.
 *
 * Provenance: a DevBar running as a CHILD of some other AppImage
 * inherits that parent's $APPIMAGE. Targeting the inherited file would
 * let an update REPLACE THE PARENT APPLICATION — so the env value is
 * only accepted when it identifies THIS running image: the runtime
 * mounts a `<name>.AppImage` under `/tmp/.mount_<name><random>` and
 * execPath's directory is that mount point, so the mount dir must carry
 * the same stem as the env file's name. Anything else falls back to the
 * execPath check (directly executed image: the path IS the file).
 */
export function appImagePathFromExecutable(
  execPath: string,
  appImageEnv: string | undefined = process.env.APPIMAGE,
): string | null {
  const fromEnv = (appImageEnv ?? '').trim();
  if (fromEnv) {
    const mountDir = path.basename(path.dirname(execPath));
    const stem = path.basename(fromEnv).replace(/\.appimage$/iu, '');
    if (stem && mountDir.startsWith(`.mount_${stem}`)) {
      return path.resolve(fromEnv);
    }
  }
  if (!execPath.endsWith('.AppImage')) return null;
  return path.resolve(execPath);
}

/** The swap renames the file, so the permission that matters is on the parent dir. */
export function canInstallInPlace(appImage: string | null): appImage is string {
  if (!appImage) return false;
  try {
    fs.accessSync(path.dirname(appImage), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * AppImage magic per the AppImageSpec: an ELF file whose ident padding
 * carries "AI" + a type byte at offset 8 (0x01 type 1, 0x02 type 2 —
 * electron-builder emits type 2). The remaining padding is zeroes, so the
 * legacy "AppImage" string check rejects genuine images — and a random
 * 8-byte string could not masquerade as one either.
 */
export function looksLikeAppImage(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const elf = Buffer.alloc(4);
    if (fs.readSync(fd, elf, 0, 4, 0) < 4) return false;
    if (elf.toString('latin1') !== '\x7fELF') return false;
    const magic = Buffer.alloc(3);
    if (fs.readSync(fd, magic, 0, 3, 8) < 3) return false;
    return (
      magic[0] === 0x41 &&
      magic[1] === 0x49 &&
      (magic[2] === 0x01 || magic[2] === 0x02)
    );
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Place the verified download into the per-version staging dir.
 * Returns the staged path.
 */
export function stageAppImage({
  filePath,
  destDir,
  fileName,
}: {
  filePath: string;
  destDir: string;
  fileName: string;
}): string {
  if (!looksLikeAppImage(filePath))
    throw new Error('la descarga no parece un AppImage válido');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const staged = path.join(destDir, fileName);
  fs.copyFileSync(filePath, staged);
  fs.chmodSync(staged, 0o755);
  return staged;
}

/**
 * Swap script: wait for the old process, move it aside, copy the new
 * AppImage in, relaunch detached. Rollback re-runs the old file when the
 * copy fails, so a bad download can never strand the user without DevBar.
 *
 * `relaunchArgs` and `markerPath` are CI conveniences (both optional, and
 * null in production): the relaunch receives the given arguments (the
 * `--devbar-smoke` proof of life, for example), and a success marker is
 * written once the swap has completed, so a test can observe it from
 * outside the app.
 */
export function buildSwapScript({
  pid,
  target,
  staged,
  relaunchArgs,
  markerPath,
}: {
  pid: number;
  target: string;
  staged: string;
  relaunchArgs?: string[] | null | undefined;
  markerPath?: string | null | undefined;
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const args = (relaunchArgs ?? []).map(quote).join(' ');
  const relaunch = args ? `setsid "$target" ${args}` : 'setsid "$target"';
  const markerLine = markerPath
    ? `printf 'ok' > ${quote(markerPath)} 2>/dev/null || true\n`
    : '';
  return `#!/bin/bash
set -u
target=${quote(target)}
staged=${quote(staged)}
backup="$target.devbar-old"

# The relaunch must never re-enter a CI simulation: strip the
# update/hold env the app was run with. relaunchArgs (if any)
# re-enables plain smoke explicitly.
unset DEVBAR_SMOKE DEVBAR_SMOKE_HOLD DEVBAR_SMOKE_UPDATE \
  DEVBAR_SMOKE_ARTIFACT DEVBAR_SMOKE_SHA DEVBAR_SMOKE_VERSION

# Bounded wait: a stuck quit must not leave a swap script running forever.
for _ in $(seq 1 100); do
  kill -0 ${pid} 2>/dev/null || break
  sleep 0.2
done
if kill -0 ${pid} 2>/dev/null; then exit 1; fi
sleep 1 # let Electron's helper processes wind down

if [ ! -f "$target" ]; then
  # No previous install to protect — just put the new one in place.
  cp "$staged" "$target" || exit 1
  chmod 755 "$target"
else
  mv "$target" "$backup" || exit 1
  if ! cp "$staged" "$target"; then
    rm -f "$target"
    mv "$backup" "$target"
    # Relaunch the RESTORED target: after the mv, $backup no longer exists.
    setsid "$target" >/dev/null 2>&1 < /dev/null &
    exit 1
  fi
  chmod 755 "$target"
  rm -f "$backup"
fi
${markerLine}
# Detached relaunch: the swap script is the last process that knows the path.
# No --login: an update relaunch is a manual launch, not a boot, so
# pre-scripts must NOT re-run (they gate on the login flag).
${relaunch} >/dev/null 2>&1 < /dev/null &
`;
}

/** Write the swap script and launch it detached. The caller then quits. */
export function spawnSwap({
  scriptPath,
  pid,
  target,
  staged,
  relaunchArgs,
  markerPath,
}: {
  scriptPath: string;
  pid: number;
  target: string;
  staged: string;
  relaunchArgs?: string[] | null | undefined;
  markerPath?: string | null | undefined;
}): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    buildSwapScript({ pid, target, staged, relaunchArgs, markerPath }),
    { mode: 0o755 },
  );
  spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
