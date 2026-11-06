/**
 * Local install for Windows and Linux — the counterpart of
 * scripts/install-local.sh (macOS, invoked by scripts/platform.ts).
 *
 * Same spirit as the macOS script, in the same order: build and pack for
 * the host FIRST, then stop the running DevBar, replace the per-user
 * install location and relaunch. The running app — and the user's services
 * it runs — keep going through the slow build, and a failed build or pack
 * leaves them untouched. The one exception is an instance running FROM the
 * build output (dist/electron-builder): the pack overwrites its files (and
 * on Windows fails on them while they are locked), so that one alone is
 * stopped right before packaging, with the same three waves. On Windows the
 * location is %LOCALAPPDATA%\Programs\DevBar — the very path the NSIS
 * per-user installer uses, so the in-app updater keeps recognising it. On
 * Linux it is ~/.local/share/DevBar with a launcher in ~/.local/bin when
 * that directory exists.
 *
 * Stopping — three waves, scoped to dist/ or to everything — lives in
 * scripts/install-local-stop.ts. The POSIX process-group walk it uses lives
 * in scripts/lib/kill-trees.ts, shared with install-local.sh (macOS).
 *
 * Usage: node --experimental-strip-types scripts/install-local.ts
 *        [--dev] [--no-build]
 *
 * --no-build reuses an existing dist/electron-builder/<os>[-arch]-unpacked
 * output (CI builds it right before, so the kill+install+relaunch cycle can
 * run without a second full build): nothing to build, so it stops
 * everything up front and installs.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok,
  step,
  stopInstances,
  warn,
  type ProbeProcess,
  type StopContext,
} from './install-local-stop.ts';
import { isServiceGroupAlive, readProcessIdentity } from './lib/kill-trees.ts';
import { unpackedDirName } from './package-win-linux.ts';
import { absoluteEnvDir, isEntrypoint } from './lib/script-runtime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── injectable seams ──────────────────────────────────────────────────
// Everything that touches the process table, the clock or a child process
// goes through one of these, so the install can be exercised end to end
// without signalling a real process or launching a real app.

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

const defaultWait = (ms: number): void => {
  // A CLI script may block: no child process needed for a half-second.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A build/packaging step; answers its exit status (0 = success). A
 *  failure ends the install — a half-built app must never be copied over a
 *  working one. */
export type RunStep = (cmd: string, args: string[]) => number;

const defaultRunStep: RunStep = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (!result.error) return result.status ?? 1;
  console.error(`${cmd}: ${result.error.message}`);
  return 1;
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

/** What a failed build or pack says: nothing the user runs was stopped. */
const LEFT_UNTOUCHED = 'the running DevBar was left untouched';

function abortUnlessOk(
  context: InstallContext,
  what: string,
  status: number,
): void {
  if (status === 0) return;
  console.error(`${what} failed — ${LEFT_UNTOUCHED}`);
  context.fail(status);
}

/**
 * Build and pack while the running DevBar keeps going. Only an instance
 * running FROM the build output stops first — the pack overwrites its
 * files — and only once the build (which does not touch dist/) succeeded.
 * Any failure aborts before the installed or dev instance was touched.
 */
function buildAndPack(context: InstallContext): void {
  const { unpackedDir, executable } = context;
  step('Building…');
  abortUnlessOk(
    context,
    'build',
    context.runStep(process.execPath, [
      '--experimental-strip-types',
      'scripts/build.ts',
    ]),
  );
  stopInstances(context, 'dist');
  step('Packaging (electron-builder dir target, host arch)…');
  abortUnlessOk(
    context,
    'pack',
    context.runStep(process.execPath, [
      '--experimental-strip-types',
      'scripts/package-win-linux.ts',
      context.platform === 'win32' ? 'win' : 'linux',
      'dir',
    ]),
  );
  const packed = path.join(unpackedDir, executable);
  if (!fs.existsSync(packed)) {
    console.error(
      `packaged executable not found at ${packed} — ${LEFT_UNTOUCHED}`,
    );
    return context.fail(1);
  }
  ok(`built: ${unpackedDir}`);
}

export function main(context: InstallContext): void {
  const { installDir, unpackedDir, executable } = context;

  if (context.noBuild) {
    // Nothing to build: stop everything up front, then reuse the output.
    stopInstances(context, 'all');
    step('Skipping build (--no-build)…');
    if (!fs.existsSync(path.join(unpackedDir, executable))) {
      console.error(
        `--no-build: no packaged app at ${unpackedDir} — run without the flag first`,
      );
      return context.fail(1);
    }
    ok(`reusing build: ${unpackedDir}`);
  } else {
    buildAndPack(context);
    // Only now, with a packed app in hand, does the running DevBar stop —
    // all three waves complete before any file is swapped.
    stopInstances(context, 'all');
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
