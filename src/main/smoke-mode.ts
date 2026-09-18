import path from 'node:path';
import { windowsUpdateMode } from '../self-update.js';
import { errorMessage } from './ipc-validators.js';
import type { StagedUpdate } from '../domain-types.js';

/**
 * CI smoke mode (`--devbar-smoke` or DEVBAR_SMOKE=1). Proves the PACKAGED
 * binary boots on its target OS and owns a system tray, then self-terminates
 * with a DEVBAR_SMOKE_OK marker the build jobs grep for. Skips windows,
 * commands, schedules and update checks.
 *
 * Two CI shapes sit on top of the plain proof of life:
 *  - HOLD (`--devbar-smoke-hold` / DEVBAR_SMOKE_HOLD=1): stay resident so a
 *    following `pnpm install-local` has a real running process to kill — the
 *    "reinstall while running" test.
 *  - UPDATE (DEVBAR_SMOKE_UPDATE=1): run the REAL staging + swap handoff with
 *    a locally built artifact, then exit. The swap script relaunches the app
 *    with `--devbar-smoke`, so the new version proves itself through the same
 *    marker — end-to-end "automatic update" coverage in CI.
 */

type StagedKind = 'macBundle' | 'appImage' | 'winInstaller' | 'winPortable';

export function isSmokeMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  return argv.includes('--devbar-smoke') || env.DEVBAR_SMOKE === '1';
}

export function smokeFlags(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { hold: boolean; update: boolean } {
  return {
    hold: argv.includes('--devbar-smoke-hold') || env.DEVBAR_SMOKE_HOLD === '1',
    update: env.DEVBAR_SMOKE_UPDATE === '1',
  };
}

/** Which staging shape the local artifact takes on this host. */
export function smokeArtifactKind(
  platform: NodeJS.Platform,
  target: string,
): StagedKind {
  if (platform === 'darwin') return 'macBundle';
  if (platform === 'linux') return 'appImage';
  return windowsUpdateMode(target) === 'nsis' ? 'winInstaller' : 'winPortable';
}

interface SmokeTray {
  isDestroyed: () => boolean;
}

export interface SmokeModeDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  version: () => string;
  /** A stale marker would let CI read a PREVIOUS run's success. */
  removeMarker: () => void;
  writeMarker: (contents: string) => void;
  createTray: () => SmokeTray;
  installedAppPath: () => string | null;
  updatesDir: () => string;
  verifySha256: (filePath: string, expectedHex: string) => Promise<boolean>;
  stageDownloadedArtifact: (input: {
    filePath: string;
    destDir: string;
    version: string;
    kind: StagedKind;
  }) => Promise<StagedUpdate>;
  spawnSwap: (input: {
    staged: StagedUpdate;
    target: string;
    scriptDir: string;
    pid: number;
    relaunchArgs?: string[] | null | undefined;
    markerPath?: string | null | undefined;
  }) => void;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  holdMs?: number;
}

export function runSmokeMode(deps: SmokeModeDeps): void {
  const { hold, update } = smokeFlags(deps.argv, deps.env);

  try {
    deps.removeMarker();
  } catch (error) {
    // A stale marker left behind would let CI read a PREVIOUS run's success,
    // so this is fatal — and it is not a tray failure.
    console.error('DEVBAR_SMOKE_MARKER_CLEANUP_FAILED:', error);
    deps.exit(1);
    return;
  }

  // Held in a variable the success timer below closes over: an unreferenced
  // Tray is garbage-collected and its native icon destroyed, so dropping the
  // reference here could let the tray vanish before the run is a success.
  let smokeTray: SmokeTray | null = null;
  try {
    if (!update) smokeTray = deps.createTray();
  } catch (error) {
    console.error('DEVBAR_SMOKE_TRAY_FAILED:', error);
    deps.exit(1);
    return;
  }

  if (update) {
    runSmokeUpdate(deps);
    return;
  }

  deps.setTimer(() => {
    // What CI actually claims to prove is not "a tray was constructed" but "a
    // tray was still alive 1.5 s later" — assert that before writing a success
    // marker anyone will trust.
    if (!smokeTray || smokeTray.isDestroyed()) {
      console.error('DEVBAR_SMOKE_TRAY_GONE');
      deps.exit(1);
      return;
    }
    try {
      deps.writeMarker(`DEVBAR_SMOKE_OK ${deps.platform} ${deps.version()}\n`);
    } catch {
      // Marker is a CI convenience; the stdout marker below is primary.
    }
    console.log('DEVBAR_SMOKE_OK');
    if (hold) {
      // Resident proof of life: CI checks this pid, then expects the next
      // install-local to kill exactly this process.
      console.log(`DEVBAR_SMOKE_HOLDING ${deps.pid}`);
      return;
    }
    deps.exit(0);
  }, deps.holdMs ?? 1500);
}

function runSmokeUpdate(deps: SmokeModeDeps): void {
  const artifact = deps.env.DEVBAR_SMOKE_ARTIFACT;
  const sha = deps.env.DEVBAR_SMOKE_SHA;
  const version = deps.env.DEVBAR_SMOKE_VERSION;
  const target = deps.installedAppPath();
  const fail = (reason: string): void => {
    console.error(`DEVBAR_SMOKE_UPDATE_FAILED ${reason}`);
    deps.exit(1);
  };
  if (!artifact || !sha || !version)
    return fail('missing DEVBAR_SMOKE_ARTIFACT/_SHA/_VERSION');
  if (!target) return fail('not running from an installed location');
  void (async () => {
    try {
      // The production staging path, byte for byte: hash seal, artifact magic
      // checks, copy into the per-version staging dir.
      const verified = await deps.verifySha256(artifact, sha);
      if (!verified) throw new Error('el hash del artefacto no coincide');
      const updatesDir = deps.updatesDir();
      const staged = await deps.stageDownloadedArtifact({
        filePath: artifact,
        destDir: path.join(updatesDir, version),
        version,
        kind: smokeArtifactKind(deps.platform, target),
      });
      // The swap waits for this pid to die, replaces the app and relaunches it
      // with --devbar-smoke, so the new version writes the marker CI is about
      // to wait for. On Windows the install bat plays the swap's role
      // (installer = swap), relaunching with the same args once it exits 0.
      deps.spawnSwap({
        staged,
        target,
        scriptDir: updatesDir,
        pid: deps.pid,
        relaunchArgs: ['--devbar-smoke'],
        markerPath: path.join(updatesDir, 'swap-ok'),
      });
      console.log(`DEVBAR_SMOKE_UPDATE_HANDOFF ${version}`);
      deps.exit(0);
    } catch (error) {
      fail(errorMessage(error));
    }
  })();
}
