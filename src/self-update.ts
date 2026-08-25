import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StagedUpdate } from './domain-types.js';

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], (err, stdout) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(stdout.trim());
    });
  });
}

/**
 * `/Applications/DevBar.app/Contents/MacOS/DevBar` → `/Applications/DevBar.app`.
 * Returns null when the executable isn't inside a bundle (dev runs from
 * `node_modules/electron`, where an in-place swap makes no sense).
 */
export function bundlePathFromExecutable(execPath: string): string | null {
  const bundle = path.resolve(execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * We replace the whole bundle, so the write permission that matters is on the
 * PARENT directory (`/Applications`), not on the bundle itself.
 */
export function canInstallInPlace(bundle: string | null): bundle is string {
  if (!bundle) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unpack a release .zip and hand back the `.app` it contains, once it looks
 * like the version we asked for. `ditto -x -k` is the same tool that built the
 * archive, so the ad-hoc signature and resource forks survive the round trip.
 */
export async function extractUpdate({
  zipPath,
  destDir,
  version,
}: {
  zipPath: string;
  destDir: string;
  version: string;
}): Promise<StagedUpdate> {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, destDir]);

  const entry = fs.readdirSync(destDir).find((name) => name.endsWith('.app'));
  if (!entry) throw new Error('el archivo no contiene ninguna .app');
  const appPath = path.join(destDir, entry);

  if (!fs.existsSync(path.join(appPath, 'Contents', 'Info.plist')))
    throw new Error('la .app descargada no tiene Info.plist');

  const found = await run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    path.join(appPath, 'Contents', 'Info.plist'),
  ]);
  if (found !== version)
    throw new Error(`la descarga dice v${found}, se esperaba v${version}`);

  return { version, appPath };
}

/**
 * Swap script: waits for us to die, moves the old bundle aside, copies the new
 * one in, and relaunches. Kept as a detached shell script because macOS won't
 * let a running app reliably re-exec itself out of a bundle it is replacing.
 * The old bundle is only deleted once the copy succeeded — a failed `ditto`
 * rolls back and reopens the version that was already working.
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
sleep 1 # let Electron's helper processes wind down before we move the bundle

rm -rf "$backup"
mv "$target" "$backup" || exit 1
if ! /usr/bin/ditto "$staged" "$target"; then
  rm -rf "$target"
  mv "$backup" "$target"
  open "$target"
  exit 1
fi
rm -rf "$backup"
# We downloaded this ourselves, so it carries no quarantine flag — strip it
# anyway in case a future path routes the archive through something that does.
xattr -dr com.apple.quarantine "$target" 2>/dev/null
open "$target"
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
