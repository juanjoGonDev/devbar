import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Build an update that is real in every way that matters: a genuine copy of the
 * bundle we are running, with its version bumped and its seal remade, so the
 * production staging path verifies it, unpacks it and swaps it in exactly as it
 * would a GitHub release. Only the transfer is simulated — everything that can
 * actually go wrong on a user's machine still runs.
 *
 * Lives under src/dev, which packaged builds drop, so none of this ships.
 */
export async function buildSimulatedUpdate({
  bundlePath,
  workDir,
  version,
}: {
  bundlePath: string;
  workDir: string;
  version: string;
}): Promise<string> {
  const stage = path.join(workDir, `sim-${version}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const appPath = path.join(stage, path.basename(bundlePath));
  try {
    await exec('/usr/bin/ditto', [bundlePath, appPath]);
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion'])
      await exec('/usr/libexec/PlistBuddy', [
        '-c',
        `Set :${key} ${version}`,
        plist,
      ]);

    // Editing Info.plist breaks the bundle's seal, and staging refuses an
    // unverifiable download. Re-sign the OUTER bundle only: --deep would
    // restamp every nested helper with the parent's identifier, and macOS keys
    // notification permission on exactly that identifier — the swapped app
    // would come back mute.
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);

    const zipPath = path.join(workDir, `DevBar-${version}-sim.zip`);
    fs.rmSync(zipPath, { force: true });
    await exec('/usr/bin/ditto', [
      '-c',
      '-k',
      '--keepParent',
      appPath,
      zipPath,
    ]);
    return zipPath;
  } finally {
    // The zip is what staging consumes; the loose copy is 200 MB of nothing.
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
