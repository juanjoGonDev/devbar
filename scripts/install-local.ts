/**
 * Local install for Windows and Linux — the counterpart of
 * scripts/install-local.sh (macOS, invoked by scripts/platform.ts).
 *
 * Same spirit as the macOS script: stop any running DevBar, pack for the
 * host, replace the per-user install location and relaunch. On Windows the
 * location is %LOCALAPPDATA%\Programs\DevBar — the very path the NSIS
 * per-user installer uses, so the in-app updater keeps recognising it. On
 * Linux it is ~/.local/share/DevBar with a launcher in ~/.local/bin when
 * that directory exists.
 *
 * Stopping is done in three waves, because a leftover process is exactly
 * how a reinstall (or an automatic update) half-resolves: the old instance
 * keeps its tray icon and the new one either fails to replace locked files
 * or both run side by side.
 *   1. kill: the packaged image name (Windows) or the exact install/dist/
 *      dev paths (Linux), including a `pnpm start` instance of THIS repo.
 *   2. verify: poll until nothing matched anymore.
 *   3. force: SIGKILL / taskkill /F whatever ignored the graceful stop. If
 *      something survives even that, abort instead of swapping files under
 *      a live process.
 *
 * The POSIX process-group walk lives in scripts/lib/kill-trees.ts and is
 * shared with install-local.sh (macOS) — it used to be duplicated here,
 * which is how the same defect ended up being fixed twice.
 *
 * Usage: node --experimental-strip-types scripts/install-local.ts
 *        [--dev] [--no-build]
 *
 * --no-build reuses an existing dist/electron-builder/<os>[-arch]-unpacked
 * output (CI builds it right before, so the kill+install+relaunch cycle can
 * run without a second full build).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ereEscape,
  isServiceGroupAlive,
  posixKillServiceGroups,
  posixTermServiceTrees,
  psLikeEscape,
  readProcessIdentity,
  windowsKillDevInstanceCommand,
  windowsKillImageTreeArgs,
  type KillTreeRun,
  type ServiceGroup,
} from './lib/kill-trees.ts';
import { unpackedDirName } from './package-win-linux.ts';
import { absoluteEnvDir, isEntrypoint } from './lib/script-runtime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const step = (message: string): void => console.log(`→ ${message}`);
const ok = (message: string): void => console.log(`✓ ${message}`);
const warn = (message: string): void => console.log(`! ${message}`);

// ── injectable seams ──────────────────────────────────────────────────
// Everything that touches the process table, the clock or a child process
// goes through one of these, so the install can be exercised end to end
// without signalling a real process or launching a real app.

/** What a process probe answers: its exit status and captured stdout, or
 *  null when the command could not be started at all (missing binary,
 *  EACCES…) — which is never evidence that something is running. */
export interface ProbeResult {
  status: number | null;
  stdout: string;
}

export type ProbeProcess = (
  cmd: string,
  args: readonly string[],
) => ProbeResult | null;

const defaultProbe: ProbeProcess = (cmd, args) => {
  // Nothing to stop — and no binary to stop it with — are both expected
  // outcomes, so a spawn that fails OR throws answers null rather than
  // ending the install.
  try {
    const result = spawnSync(cmd, [...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: ROOT,
      encoding: 'utf8',
    });
    return result.error
      ? null
      : { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return null;
  }
};

/** The fire-and-forget form kill-trees takes: nothing to stop is an
 *  expected outcome, so only stdout is of any interest. */
const quietRun =
  (probe: ProbeProcess): KillTreeRun =>
  (cmd, args) =>
    probe(cmd, args)?.stdout ?? null;

const defaultWait = (ms: number): void => {
  // A CLI script may block: no child process needed for a half-second.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A build/packaging step. Failure ends the install — a half-built app
 *  must never be copied over a working one. */
export type RunStep = (cmd: string, args: string[]) => void;

const defaultRunStep: RunStep = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

/**
 * A handle on the relaunched app. spawn() reports failure
 * ASYNCHRONOUSLY, so both outcomes arrive as events — which is why this
 * is a handle and not a boolean.
 */
export interface LaunchedApp {
  onError(listener: (error: Error) => void): void;
  onSpawn(listener: () => void): void;
  unref(): void;
}

export type LaunchApp = (
  appPath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => LaunchedApp;

const defaultLaunch: LaunchApp = (appPath, args, options) => {
  const child = spawn(appPath, [...args], {
    detached: true,
    stdio: 'ignore',
    cwd: options.cwd,
    env: options.env,
  });
  return {
    onError: (listener) => {
      child.on('error', listener);
    },
    onSpawn: (listener) => {
      child.on('spawn', listener);
    },
    unref: () => {
      child.unref();
    },
  };
};

// ── layout ────────────────────────────────────────────────────────────

export interface InstallLayout {
  unpackedDir: string;
  installDir: string;
  executable: string;
}

/**
 * Where the packed output is and where it goes, per OS. Null on an
 * unsupported platform — darwin has its own bash pipeline.
 *
 * `arch` is the CPU the pack step built for (the host's, since both
 * scripts derive it from process.arch). electron-builder only suffixes
 * the unpacked directory on non-x64 hosts, so the name must be derived
 * symmetrically: hardcoding `linux-unpacked` pointed at a directory that
 * does not exist on a Raspberry Pi (`linux-arm64-unpacked`) and failed
 * every install there.
 *
 * LOCALAPPDATA goes through absoluteEnvDir: an empty or relative value
 * would resolve against the process CWD, and the install would then wipe
 * and recreate a directory inside the checkout while reporting success.
 */
export function layout(
  platform: NodeJS.Platform,
  root: string,
  home: string,
  arch: string = process.arch,
): InstallLayout | null {
  if (platform === 'win32') {
    const localAppData = absoluteEnvDir(
      'LOCALAPPDATA',
      path.join(home, 'AppData', 'Local'),
    );
    return {
      unpackedDir: path.join(
        root,
        'dist',
        'electron-builder',
        unpackedDirName('win', arch),
      ),
      installDir: path.join(localAppData, 'Programs', 'DevBar'),
      executable: 'DevBar.exe',
    };
  }
  if (platform === 'linux') {
    return {
      unpackedDir: path.join(
        root,
        'dist',
        'electron-builder',
        unpackedDirName('linux', arch),
      ),
      installDir: path.join(home, '.local', 'share', 'DevBar'),
      executable: 'devbar',
    };
  }
  return null;
}

// ── stopping ──────────────────────────────────────────────────────────

/** Everything the three stop waves need. */
export interface StopContext {
  platform: NodeJS.Platform;
  root: string;
  installDir: string;
  probe: ProbeProcess;
  wait: (ms: number) => void;
  processIdentity: (pid: string) => string | null;
  groupAlive: (leaderPid: string) => boolean;
  /** Abort the install (process.exit in production). */
  fail: (code: number) => never;
}

/**
 * POSIX patterns that identify a running DevBar: the installed copy, a
 * dist/ run, and a dev run from this checkout — no assumptions about the
 * repo folder name.
 *
 * ONE list on purpose. The kill wave, the liveness verification and the
 * forced escalation must target exactly the same set: a surviving instance
 * the verification cannot see would pass verification, and the install
 * would then swap files under a live process.
 */
export function killPatterns(root: string, installDir: string): string[] {
  return [
    path.join(installDir),
    path.join(root, 'dist', 'electron-builder'),
    path.join(root, 'node_modules', 'electron'),
  ].map(ereEscape);
}

/** True while a dev-mode electron.exe from this checkout is alive. The
 *  probe answers through its EXIT STATUS (1 = found), so a probe that
 *  could not run at all never reads as "alive". */
export function windowsDevInstanceAlive(
  root: string,
  probe: ProbeProcess,
): boolean {
  const escaped = psLikeEscape(root);
  const result = probe('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `if (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${escaped}*' }) { exit 1 }; exit 0`,
  ]);
  return result?.status === 1;
}

/**
 * True while any process the kill wave targets still matches. The
 * verification must check the SAME set as the kill, or a surviving
 * instance the other checks cannot see (a dev electron.exe on Windows,
 * a dist/- or node_modules-rooted instance on Linux) would pass
 * verification and the install would swap files under it.
 */
export function isAnyDevBarAlive(context: StopContext): boolean {
  const { platform, root, installDir, probe } = context;
  if (platform === 'win32') {
    const list = probe('tasklist', ['/FI', 'IMAGENAME eq DevBar.exe']);
    if (list && /DevBar\.exe/i.test(list.stdout)) return true;
    // The image-name check cannot see a dev-mode electron.exe from this
    // checkout.
    return windowsDevInstanceAlive(root, probe);
  }
  for (const pattern of killPatterns(root, installDir)) {
    const pids = probe('pgrep', ['-f', pattern]);
    if (pids === null) continue;
    // Defense in depth: never count the install's own process chain (a
    // shell or editor whose command line mentions the electron path) as a
    // running app instance.
    const real = pids.stdout
      .split(/\s+/)
      .filter(
        (pid) =>
          pid && Number(pid) !== process.pid && Number(pid) !== process.ppid,
      );
    if (real.length > 0) return true;
  }
  return false;
}

/** Wave 2 budget: how long the graceful stop is given before wave 3. */
export const VERIFY_POLLS = 20;
export const VERIFY_POLL_MS = 500;
/** Wave 3 budget: how long the FORCED stop is given to take effect. */
export const FORCE_POLLS = 10;
export const FORCE_POLL_MS = 300;

/**
 * Wave 1 — kill. Windows: the packaged image name, plus electron.exe
 * processes started from THIS repo (`pnpm start` runs electron, not
 * DevBar.exe, so the image-name kill alone would leave a dev instance
 * alive). Linux: the service trees first (they outlive a bare pkill of the
 * app), then the instances themselves — TERM, so a current build can also
 * run its own graceful shutdown.
 *
 * Every kill is TREE-aware (taskkill /T, and the POSIX service-group walk
 * for the detached service processes): the running instance's commands —
 * the user's dev servers — must die with it, or the reinstall leaves them
 * holding their ports.
 *
 * Returns the service groups wave 3 has to escalate: a service whose
 * command line matches none of the app's kill patterns is invisible to the
 * instance pkill waves, so its group is SIGKILL'd there if it outlives the
 * graceful stop.
 */
export function killRunningInstances(context: StopContext): ServiceGroup[] {
  step('Stopping any running DevBar…');
  const run = quietRun(context.probe);
  if (context.platform === 'win32') {
    run('taskkill', windowsKillImageTreeArgs('DevBar.exe'));
    // Dev mode: electron.exe whose command line references this checkout.
    // (Killing every electron.exe on the machine would be too aggressive.)
    run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsKillDevInstanceCommand(context.root),
    ]);
    return [];
  }
  const patterns = killPatterns(context.root, context.installDir);
  const groups = posixTermServiceTrees(patterns, {
    run,
    processIdentity: context.processIdentity,
  });
  for (const pattern of patterns) run('pkill', ['-f', pattern]);
  return groups;
}

/**
 * Wave 2 — verify. Poll until the kill patterns match nothing; if a process
 * survives, warn instead of swapping files under a live process.
 */
export function verifyStopped(context: StopContext): void {
  for (let i = 0; i < VERIFY_POLLS; i++) {
    if (!isAnyDevBarAlive(context)) return;
    context.wait(VERIFY_POLL_MS);
  }
  if (isAnyDevBarAlive(context))
    warn(
      'A DevBar process is still running after the kill — if the next step ' +
        'fails to replace files, close it manually and re-run.',
    );
}

/**
 * Wave 3 — force-kill whatever survived the graceful stop. TERM is a
 * request; a process that outlives the app still holds the inherited
 * single-instance socket and turns the next launch into a silent second
 * instance. The reinstall must not leave a lock holder behind.
 */
export function killLeftovers(
  context: StopContext,
  groups: readonly ServiceGroup[],
): void {
  // A service group survives on its own even when every app instance is
  // gone — it matches none of the liveness patterns, so it needs its own
  // entry condition.
  if (!isAnyDevBarAlive(context) && groups.length === 0) return;
  warn('A DevBar process ignored the graceful stop — forcing it.');
  const run = quietRun(context.probe);
  if (context.platform === 'win32') {
    run('taskkill', windowsKillImageTreeArgs('DevBar.exe'));
    run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsKillDevInstanceCommand(context.root),
    ]);
  } else {
    for (const pattern of killPatterns(context.root, context.installDir))
      run('pkill', ['-9', '-f', pattern]);
    // Escalation for the service groups from wave 1: SIGKILL any that
    // outlived the graceful stop (no-op for the ones that honored TERM),
    // then re-probe within the shared post-kill budget before calling
    // anything a survivor.
    const survivors = posixKillServiceGroups(groups, {
      run,
      wait: context.wait,
      groupAlive: context.groupAlive,
      processIdentity: context.processIdentity,
    });
    if (survivors.length > 0) {
      // SIGKILL cannot be caught: a group still here holds its port and
      // the reinstall must not proceed under a live service.
      console.error(
        `Service group(s) survived SIGKILL: ${survivors
          .map((group) => group.pid)
          .join(', ')} — aborting before install.`,
      );
      return context.fail(1);
    }
  }
  for (let i = 0; i < FORCE_POLLS; i++) {
    if (!isAnyDevBarAlive(context)) {
      ok('all previous instances stopped');
      return;
    }
    context.wait(FORCE_POLL_MS);
  }
  // A process that outlives SIGKILL/taskkill /F still holds the
  // single-instance socket: replacing the install under it would turn
  // the relaunch into a silent second instance. Fail loudly instead —
  // continuing "with a warning" is how a reinstall half-resolves.
  warn(
    'A DevBar process survived even the forced stop — it keeps the ' +
      'single-instance lock and this install cannot safely continue. ' +
      'Close it manually (check for a stuck Electron process) and re-run.',
  );
  return context.fail(1);
}

// ── install ───────────────────────────────────────────────────────────

export interface InstallContext extends StopContext, InstallLayout {
  dev: boolean;
  noBuild: boolean;
  launchArgs: readonly string[];
  env: NodeJS.ProcessEnv;
  home: string;
  runStep: RunStep;
  launch: LaunchApp;
}

/**
 * ~/.local/bin/devbar → the installed executable, when that directory
 * exists. Best effort: a launcher that cannot be created is a warning, not
 * a failed install. Returns the launcher path, or null when there is none.
 */
export function linkLauncher(context: InstallContext): string | null {
  const appPath = path.join(context.installDir, context.executable);
  const binDir = path.join(context.home, '.local', 'bin');
  if (!fs.existsSync(binDir)) {
    warn(`~/.local/bin not found — launch it with: ${appPath}`);
    return null;
  }
  const launcherPath = path.join(binDir, 'devbar');
  try {
    fs.rmSync(launcherPath, { force: true });
    fs.symlinkSync(appPath, launcherPath);
    return launcherPath;
  } catch {
    return null;
  }
}

export function main(context: InstallContext): void {
  const { installDir, unpackedDir, executable } = context;

  const serviceGroups = killRunningInstances(context);
  // Verification and forced cleanup complete BEFORE any fallible build or
  // packaging step: if the build aborts, a surviving instance must not be
  // left behind holding the single-instance lock.
  verifyStopped(context);
  killLeftovers(context, serviceGroups);

  if (context.noBuild) {
    step('Skipping build (--no-build)…');
    if (!fs.existsSync(path.join(unpackedDir, executable))) {
      console.error(
        `--no-build: no packaged app at ${unpackedDir} — run without the flag first`,
      );
      return context.fail(1);
    }
    ok(`reusing build: ${unpackedDir}`);
  } else {
    step('Building…');
    context.runStep(process.execPath, [
      '--experimental-strip-types',
      'scripts/build.ts',
    ]);

    step('Packaging (electron-builder dir target, host arch)…');
    context.runStep(process.execPath, [
      '--experimental-strip-types',
      'scripts/package-win-linux.ts',
      context.platform === 'win32' ? 'win' : 'linux',
      'dir',
    ]);
    if (!fs.existsSync(path.join(unpackedDir, executable))) {
      console.error(
        `packaged executable not found at ${path.join(unpackedDir, executable)}`,
      );
      return context.fail(1);
    }
    ok(`built: ${unpackedDir}`);
  }

  step(`Installing to ${installDir}`);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.cpSync(unpackedDir, installDir, { recursive: true });
  ok(`installed at ${installDir}`);

  const launcherPath =
    context.platform === 'linux' ? linkLauncher(context) : null;

  step('Launching');
  const appPath = path.join(installDir, executable);
  const child = context.launch(appPath, context.launchArgs, {
    cwd: installDir,
    env: context.dev ? { ...context.env, DEVBAR_DEV_PANEL: '1' } : context.env,
  });
  // spawn() reports failure ASYNCHRONOUSLY, through the returned handle:
  // without these listeners a relaunch that never started would raise an
  // unhandled 'error' AND still print "Installed and launched". Both are
  // attached BEFORE unref(), which now happens only on a confirmed spawn —
  // until then the handle keeps this process alive to hear the outcome.
  child.onError((error) => {
    console.error(`failed to launch ${appPath}: ${error.message}`);
    process.exitCode = 1;
  });
  child.onSpawn(() => {
    child.unref();
    ok(
      context.dev
        ? 'Installed (dev panel enabled) and launched'
        : 'Installed and launched',
    );
    if (launcherPath) ok(`Launcher: ${launcherPath}`);
    ok('Tail logs with: pnpm logs');
  });
}

/** Build the production context from argv/env and run the install. */
function runCli(): void {
  const platform = process.platform;
  const home = os.homedir();
  const resolved = layout(platform, ROOT, home);
  if (resolved === null) {
    console.error(
      '[install-local] this script handles win32/linux — darwin uses install-local.sh',
    );
    process.exit(1);
  }
  main({
    ...resolved,
    platform,
    root: ROOT,
    home,
    env: process.env,
    dev: process.argv.includes('--dev'),
    noBuild: process.argv.includes('--no-build'),
    /* Extra args for the relaunch, space-separated (CI escape hatch — e.g.
     * `--no-sandbox` on Linux runners, where a plain unpacked copy cannot
     * carry the root-owned setuid chrome-sandbox the .deb postinst
     * creates). */
    launchArgs: (process.env.DEVBAR_LAUNCH_ARGS ?? '')
      .split(' ')
      .filter(Boolean),
    probe: defaultProbe,
    wait: defaultWait,
    processIdentity: readProcessIdentity,
    groupAlive: isServiceGroupAlive,
    runStep: defaultRunStep,
    launch: defaultLaunch,
    fail: (code) => process.exit(code),
  });
}

// Direct execution only. Importing this module for its units (tests) must
// never run an install: it deletes and recreates the install directory.
if (isEntrypoint(import.meta.url)) runCli();
