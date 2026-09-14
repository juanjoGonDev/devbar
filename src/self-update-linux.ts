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

/** The running AppImage, or null when not one (dev run, .deb install). */
export function appImagePathFromExecutable(execPath: string): string | null {
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
 * AppImage v1.0 files carry the magic word `AppImage` at byte offset 8 — an
 * HTML error page or a truncated download cannot masquerade as one.
 */
export function looksLikeAppImage(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    if (fs.readSync(fd, buf, 0, 16, 0) < 16) return false;
    return buf.subarray(8, 16).toString('latin1') === 'AppImage';
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
 */
export function buildSwapScript({
  pid,
  target,
  staged,
}: {
  pid: number;
  target: string;
  staged: string;
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/bash
set -u
target=${quote(target)}
staged=${quote(staged)}
backup="$target.devbar-old"

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
    setsid "$backup" >/dev/null 2>&1 < /dev/null &
    exit 1
  fi
  chmod 755 "$target"
  rm -f "$backup"
fi
# Detached relaunch: the swap script is the last process that knows the path.
# No --login: an update relaunch is a manual launch, not a boot, so
# pre-scripts must NOT re-run (they gate on the login flag).
setsid "$target" >/dev/null 2>&1 < /dev/null &
`;
}

/** Write the swap script and launch it detached. The caller then quits. */
export function spawnSwap({
  scriptPath,
  pid,
  target,
  staged,
}: {
  scriptPath: string;
  pid: number;
  target: string;
  staged: string;
}): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, buildSwapScript({ pid, target, staged }), {
    mode: 0o755,
  });
  spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
