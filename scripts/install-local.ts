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
 * Usage: node --experimental-strip-types scripts/install-local.ts [--dev]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isDev = process.argv.includes('--dev');
const platform = process.platform;

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
    const result = spawnSync(cmd, args, { stdio: 'ignore', cwd: ROOT });
    if (!result.error && result.status !== 0) {
      /* nothing to stop — expected */
    }
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

function stopRunningInstances(): void {
  step('Stopping any running DevBar…');
  if (platform === 'win32') {
    // taskkill /F /IM: packaged app. Dev-mode (electron .) is left alone —
    // killing every electron.exe on the machine would be too aggressive.
    tryQuiet('taskkill', ['/F', '/IM', 'DevBar.exe']);
  } else {
    // Packaged build from dist/, installed copy, and dev mode (electron .)
    // resolved through this repo's node_modules.
    tryQuiet('pkill', ['-f', 'devbar/dist/electron-builder']);
    tryQuiet('pkill', ['-f', 'share/DevBar']);
    tryQuiet('pkill', ['-f', 'devbar/node_modules']);
  }
}

function main(): void {
  const { unpackedDir, installDir, executable } = layout();

  stopRunningInstances();

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
  const child = spawn(appPath, [], {
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
