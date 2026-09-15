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
 * Stopping is done in two waves, because a leftover process is exactly how
 * a reinstall (or an automatic update) half-resolves: the old instance
 * keeps its tray icon and the new one either fails to replace locked files
 * or both run side by side.
 *   1. kill: the packaged image name (Windows) or the exact install/dist/
 *      dev paths (Linux), including a `pnpm start` instance of THIS repo.
 *   2. verify: poll until nothing matched anymore. If something survives,
 *      say so loudly instead of swapping files under a live process.
 *
 * Usage: node --experimental-strip-types scripts/install-local.ts
 *        [--dev] [--no-build]
 *
 * --no-build reuses an existing dist/electron-builder/<os>-unpacked output
 * (CI builds it right before, so the kill+install+relaunch cycle can run
 * without a second full build).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isDev = process.argv.includes('--dev');
const noBuild = process.argv.includes('--no-build');
const platform = process.platform;
/** Extra args for the relaunch, space-separated (CI escape hatch — e.g.
 *  `--no-sandbox` on Linux runners, where a plain unpacked copy cannot
 *  carry the root-owned setuid chrome-sandbox the .deb postinst creates). */
const launchArgs = (process.env.DEVBAR_LAUNCH_ARGS ?? '')
  .split(' ')
  .filter(Boolean);

const step = (message: string): void => console.log(`→ ${message}`);
const ok = (message: string): void => console.log(`✓ ${message}`);
const warn = (message: string): void => console.log(`! ${message}`);

function run(cmd: string, args: string[], inherit = true): void {
  const result = spawnSync(cmd, args, {
    stdio: inherit ? 'inherit' : 'ignore',
    cwd: ROOT,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function tryQuiet(cmd: string, args: string[]): void {
  try {
    spawnSync(cmd, args, { stdio: 'ignore', cwd: ROOT });
    /* nothing to stop is an expected outcome */
  } catch {
    /* best effort */
  }
}

interface InstallLayout {
  unpackedDir: string;
  installDir: string;
  executable: string;
}

function layout(): InstallLayout {
  if (platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return {
      unpackedDir: path.join(ROOT, 'dist', 'electron-builder', 'win-unpacked'),
      installDir: path.join(localAppData, 'Programs', 'DevBar'),
      executable: 'DevBar.exe',
    };
  }
  if (platform === 'linux') {
    return {
      unpackedDir: path.join(
        ROOT,
        'dist',
        'electron-builder',
        'linux-unpacked',
      ),
      installDir: path.join(os.homedir(), '.local', 'share', 'DevBar'),
      executable: 'devbar',
    };
  }
  console.error(
    '[install-local] this script handles win32/linux — darwin uses install-local.sh',
  );
  process.exit(1);
}

/**
 * Wave 1 — kill. Windows: the packaged image name, plus electron.exe
 * processes started from THIS repo (`pnpm start` runs electron, not
 * DevBar.exe, so the image-name kill alone would leave a dev instance
 * alive). Linux: exact paths of the installed copy, a dist/ run, and a
 * dev run from this checkout — no assumptions about the repo folder name.
 */
function killRunningInstances(installDir: string): void {
  step('Stopping any running DevBar…');
  if (platform === 'win32') {
    tryQuiet('taskkill', ['/F', '/IM', 'DevBar.exe']);
    // Dev mode: electron.exe whose command line references this checkout.
    // (Killing every electron.exe on the machine would be too aggressive.)
    // NOTE: backslashes are NOT doubled — PowerShell single-quoted strings
    // treat `\` as literal and `-like` has no backslash metacharacters, so
    // the pattern must contain the path exactly as the command line does.
    tryQuiet('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.CommandLine -like '*${ROOT}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ]);
  } else {
    tryQuiet('pkill', ['-f', path.join(installDir)]);
    tryQuiet('pkill', ['-f', path.join(ROOT, 'dist', 'electron-builder')]);
    tryQuiet('pkill', ['-f', path.join(ROOT, 'node_modules')]);
  }
}

/**
 * Wave 2 — verify. Poll until the kill patterns match nothing; if a process
 * survives, warn instead of swapping files under a live process.
 */
function verifyStopped(installDir: string): void {
  const alive = (): boolean => {
    if (platform === 'win32') {
      const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DevBar.exe'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (list.error) return false;
      return /DevBar\.exe/i.test(list.stdout ?? '');
    }
    const pids = spawnSync('pgrep', ['-f', path.join(installDir)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (pids.error) return false;
    // pgrep can match its own spawn line through the pattern — ignore pids
    // younger than this script (nothing matching can be older and real
    // except the instances we are trying to kill).
    return (pids.stdout ?? '').trim().length > 0;
  };
  for (let i = 0; i < 20; i++) {
    if (!alive()) return;
    // A CLI script may block: no child process needed for a half-second.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (alive())
    warn(
      'A DevBar process is still running after the kill — if the next step ' +
        'fails to replace files, close it manually and re-run.',
    );
}

function main(): void {
  const { unpackedDir, installDir, executable } = layout();

  killRunningInstances(installDir);

  if (noBuild) {
    step('Building…');
    if (!fs.existsSync(path.join(unpackedDir, executable))) {
      console.error(
        `--no-build: no packaged app at ${unpackedDir} — run without the flag first`,
      );
      process.exit(1);
    }
    ok(`reusing build: ${unpackedDir}`);
  } else {
    step('Building…');
    run(process.execPath, ['--experimental-strip-types', 'scripts/build.ts']);

    step(`Packaging (electron-builder dir target, host arch)…`);
    run(process.execPath, [
      '--experimental-strip-types',
      'scripts/package-win-linux.ts',
      platform === 'win32' ? 'win' : 'linux',
      'dir',
    ]);
    if (!fs.existsSync(path.join(unpackedDir, executable))) {
      console.error(
        `packaged executable not found at ${path.join(unpackedDir, executable)}`,
      );
      process.exit(1);
    }
    ok(`built: ${unpackedDir}`);
  }

  verifyStopped(installDir);

  step(`Installing to ${installDir}`);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.cpSync(unpackedDir, installDir, { recursive: true });
  ok(`installed at ${installDir}`);

  let launcherPath: string | null = null;
  if (platform === 'linux') {
    const binDir = path.join(os.homedir(), '.local', 'bin');
    if (fs.existsSync(binDir)) {
      launcherPath = path.join(binDir, 'devbar');
      try {
        fs.rmSync(launcherPath, { force: true });
        fs.symlinkSync(path.join(installDir, executable), launcherPath);
      } catch {
        launcherPath = null;
      }
    } else {
      warn(
        '~/.local/bin not found — launch it with: ' +
          path.join(installDir, executable),
      );
    }
  }

  step('Launching');
  const appPath = path.join(installDir, executable);
  const child = spawn(appPath, launchArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: installDir,
    env: isDev ? { ...process.env, DEVBAR_DEV_PANEL: '1' } : process.env,
  });
  child.unref();

  ok(
    isDev
      ? 'Installed (dev panel enabled) and launched'
      : 'Installed and launched',
  );
  if (launcherPath) ok(`Launcher: ${launcherPath}`);
  ok('Tail logs with: pnpm logs');
}

main();
