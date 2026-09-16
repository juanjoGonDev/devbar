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

// ── process-kill helpers ──────────────────────────────────────────────
// Same logic as scripts/lib/kill-trees.ts (which stays a standalone CLI
// for install-local.sh), inlined here because
// `--experimental-strip-types` does not resolve the local
// `./lib/kill-trees.js → .ts` import at runtime.
function windowsKillImageTreeArgs(image: string): string[] {
  return ['/F', '/T', '/IM', image];
}
/**
 * Escape a path for safe embedding in a PowerShell single-quoted
 * `-like` pattern: `'` is doubled (string terminator), and the wildcard
 * characters `[ ] * ?` — plus a literal backtick, which is `-like`'s
 * own escape character — are escaped with the backtick, the documented
 * wildcard escape (what `[WildcardPattern]::Escape()` produces).
 * Backslashes stay literal — PowerShell has no backslash escape in
 * single-quoted strings and `-like` treats `\` as an ordinary character.
 */
function psLikeEscape(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === "'") out += "''";
    else if (ch === '`') out += '``';
    else if (ch === '[' || ch === ']' || ch === '*' || ch === '?')
      out += `\`${ch}`;
    else out += ch;
  }
  return out;
}
/** Windows dev mode: electron.exe from this checkout, matched by command
 *  line. NOTE: backslashes are NOT doubled — PowerShell single-quoted
 *  strings treat `\` as literal and `-like` has no backslash metachars
 *  (apart from the wildcard/quote escaping psLikeEscape applies). Keep
 *  in sync with scripts/lib/kill-trees.ts — strip-only mode cannot
 *  import it from there. */
function windowsKillDevInstanceCommand(checkoutPath: string): string {
  const escaped = psLikeEscape(checkoutPath);
  return (
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    `ForEach-Object { & taskkill /PID $($_.ProcessId) /T /F | Out-Null }`
  );
}
/** True while a dev-mode electron.exe from this checkout is alive. */
function windowsDevInstanceAlive(): boolean {
  const escaped = psLikeEscape(ROOT);
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `if (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${escaped}*' }) { exit 1 }; exit 0`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], cwd: ROOT, encoding: 'utf8' },
  );
  if (res.error) return false;
  return res.status === 1;
}
/**
 * POSIX: signal each matching instance's service trees BEFORE the
 * instances themselves. A service spawns `detached` (its own process
 * group), so a bare pkill of the app never reaches it: pgrep -P finds the
 * service shell (the group leader) and `kill -- -<pid>` signals the group.
 * Best effort: a pattern matching nothing must not fail the install.
 */
function posixKillServiceTrees(patterns: string[]): void {
  for (const pattern of patterns) {
    const pidRes = spawnSync('pgrep', ['-f', pattern], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (pidRes.error || pidRes.status !== 0) continue;
    for (const pid of (pidRes.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())) {
      if (!pid) continue;
      // pgrep -f can match the caller's own spawn line — never signal self
      // or the parent shell.
      if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
      const childRes = spawnSync('pgrep', ['-P', pid], {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (childRes.error || childRes.status !== 0) continue;
      for (const child of (childRes.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())) {
        if (!child) continue;
        // Group first (leader == child pid: shell + user command), then the
        // bare pid in case the group is already gone.
        tryQuiet('kill', ['-s', 'TERM', '--', `-${child}`]);
        tryQuiet('kill', ['-s', 'TERM', child]);
      }
    }
  }
}

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
 *
 * Every kill is TREE-aware (taskkill /T, and the POSIX service-group walk
 * for the detached service processes): the running instance's commands —
 * the user's dev servers — must die with it, or the reinstall leaves them
 * holding their ports.
 */
function killRunningInstances(installDir: string): void {
  step('Stopping any running DevBar…');
  if (platform === 'win32') {
    tryQuiet('taskkill', windowsKillImageTreeArgs('DevBar.exe'));
    // Dev mode: electron.exe whose command line references this checkout.
    // (Killing every electron.exe on the machine would be too aggressive.)
    tryQuiet('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsKillDevInstanceCommand(ROOT),
    ]);
  } else {
    const patterns = [
      path.join(installDir),
      path.join(ROOT, 'dist', 'electron-builder'),
      path.join(ROOT, 'node_modules', 'electron'),
    ];
    // The services first (they outlive a bare pkill of the app), then the
    // instances themselves — TERM, so a current build can also run its own
    // graceful shutdown; the wave-2 verify catches anything that survives.
    posixKillServiceTrees(patterns);
    for (const pattern of patterns) tryQuiet('pkill', ['-f', pattern]);
  }
}

/**
 * Wave 2 — verify. Poll until the kill patterns match nothing; if a process
 * survives, warn instead of swapping files under a live process.
 */
/**
 * True while any process the kill wave targets still matches. The
 * verification must check the SAME set as the kill, or a surviving
 * instance the other checks cannot see (a dev electron.exe on Windows,
 * a dist/- or node_modules-rooted instance on Linux) would pass
 * verification and the install would swap files under it.
 */
function isAnyDevBarAlive(installDir: string): boolean {
  if (platform === 'win32') {
    const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DevBar.exe'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (!list.error && /DevBar\.exe/i.test(list.stdout ?? '')) return true;
    // Image-name check cannot see a dev-mode electron.exe from this
    // checkout.
    return windowsDevInstanceAlive();
  }
  for (const pattern of [
    path.join(installDir),
    path.join(ROOT, 'dist', 'electron-builder'),
    path.join(ROOT, 'node_modules', 'electron'),
  ]) {
    const pids = spawnSync('pgrep', ['-f', pattern], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (pids.error) continue;
    // Defense in depth: never count the install's own process chain
    // (a shell or editor whose command line mentions the electron
    // path) as a running app instance.
    const real = (pids.stdout ?? '')
      .split(/\s+/)
      .filter(
        (pid) =>
          pid && Number(pid) !== process.pid && Number(pid) !== process.ppid,
      );
    if (real.length > 0) return true;
  }
  return false;
}

/**
 * Wave 2 — verify. Poll until the kill patterns match nothing; if a process
 * survives, warn instead of swapping files under a live process.
 */
function verifyStopped(installDir: string): void {
  for (let i = 0; i < 20; i++) {
    if (!isAnyDevBarAlive(installDir)) return;
    // A CLI script may block: no child process needed for a half-second.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (isAnyDevBarAlive(installDir))
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
function killLeftovers(installDir: string): void {
  if (!isAnyDevBarAlive(installDir)) return;
  warn('A DevBar process ignored the graceful stop — forcing it.');
  if (platform === 'win32') {
    tryQuiet('taskkill', windowsKillImageTreeArgs('DevBar.exe'));
    tryQuiet('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsKillDevInstanceCommand(ROOT),
    ]);
  } else {
    const patterns = [
      path.join(installDir),
      path.join(ROOT, 'dist', 'electron-builder'),
      path.join(ROOT, 'node_modules', 'electron'),
    ];
    for (const pattern of patterns) tryQuiet('pkill', ['-9', '-f', pattern]);
  }
  for (let i = 0; i < 10; i++) {
    if (!isAnyDevBarAlive(installDir)) {
      ok('all previous instances stopped');
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
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
  process.exit(1);
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
  killLeftovers(installDir);

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
