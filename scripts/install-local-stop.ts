/**
 * The stop half of scripts/install-local.ts (Windows and Linux): finding
 * and stopping a running DevBar — and the services it runs — before files
 * are swapped under it.
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
 * shared with install-local.sh (macOS) — it used to be duplicated in
 * install-local.ts, which is how the same defect ended up being fixed twice.
 *
 * Every stop has a scope: `all` right before the install swaps files, and
 * `dist` — only an instance running from the build output, told apart by
 * its path (on Windows, by its executable path, never the image name) —
 * right before the pack overwrites it.
 */
import path from 'node:path';
import {
  ereEscape,
  posixKillServiceGroups,
  posixTermServiceTrees,
  psLikeEscape,
  windowsImageUnderDirQuery,
  windowsKillDevInstanceCommand,
  windowsKillImageTreeArgs,
  windowsKillImageUnderDirCommand,
  type KillTreeRun,
  type ServiceGroup,
} from './lib/kill-trees.ts';

export const step = (message: string): void => console.log(`→ ${message}`);
export const ok = (message: string): void => console.log(`✓ ${message}`);
export const warn = (message: string): void => console.log(`! ${message}`);

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

/** The fire-and-forget form kill-trees takes: nothing to stop is an
 *  expected outcome, so only stdout is of any interest. */
const quietRun =
  (probe: ProbeProcess): KillTreeRun =>
  (cmd, args) =>
    probe(cmd, args)?.stdout ?? null;

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
 * Which running instances a stop targets. `all` — every DevBar the install
 * could collide with — runs right before the install swaps files. `dist`
 * is only an instance running FROM the build output, the one the pack
 * overwrites, and runs right before packaging: everything else keeps
 * running through the build.
 */
export type StopScope = 'all' | 'dist';

const IMAGE = 'DevBar.exe';

/** The build output the pack (re)writes. */
const distDir = (root: string): string =>
  path.join(root, 'dist', 'electron-builder');

/** The Windows executable-path filter for an instance under dist/. The
 *  trailing separator keeps a sibling sharing the prefix out. */
const distExecutableDir = (root: string): string =>
  `${distDir(root)}${path.sep}`;

const psArgs = (command: string): string[] => [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  command,
];

/**
 * POSIX patterns that identify a running DevBar: the installed copy, a
 * dist/ run, and a dev run from this checkout — no assumptions about the
 * repo folder name. The `dist` scope narrows them to the dist/ run.
 *
 * ONE list on purpose. The kill wave, the liveness verification and the
 * forced escalation must target exactly the same set: a surviving instance
 * the verification cannot see would pass verification, and the install
 * would then swap files under a live process.
 */
export function killPatterns(
  root: string,
  installDir: string,
  scope: StopScope = 'all',
): string[] {
  const dist = distDir(root);
  const paths =
    scope === 'dist'
      ? [dist]
      : [
          path.join(installDir),
          dist,
          path.join(root, 'node_modules', 'electron'),
        ];
  return paths.map(ereEscape);
}

/** Exit status 1 of a PowerShell `if (<query>) { exit 1 }` probe: a probe
 *  that could not run at all never reads as "alive". */
const windowsQueryFinds = (query: string, probe: ProbeProcess): boolean =>
  probe('powershell', psArgs(`if (${query}) { exit 1 }; exit 0`))?.status === 1;

/** True while a dev-mode electron.exe from this checkout is alive. */
export function windowsDevInstanceAlive(
  root: string,
  probe: ProbeProcess,
): boolean {
  const escaped = psLikeEscape(root);
  return windowsQueryFinds(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${escaped}*' }`,
    probe,
  );
}

/**
 * True while any process the kill wave targets still matches. The
 * verification must check the SAME set as the kill, or a surviving
 * instance the other checks cannot see (a dev electron.exe on Windows,
 * a dist/- or node_modules-rooted instance on Linux) would pass
 * verification and the install would swap files under it.
 */
export function isAnyDevBarAlive(
  context: StopContext,
  scope: StopScope = 'all',
): boolean {
  const { platform, root, installDir, probe } = context;
  if (platform === 'win32') {
    // The installed copy shares the image name, so a dist/ instance is
    // told apart by its executable path alone.
    if (scope === 'dist')
      return windowsQueryFinds(
        windowsImageUnderDirQuery(IMAGE, distExecutableDir(root)),
        probe,
      );
    const list = probe('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`]);
    if (list && /DevBar\.exe/i.test(list.stdout)) return true;
    // The image-name check cannot see a dev-mode electron.exe from this
    // checkout.
    return windowsDevInstanceAlive(root, probe);
  }
  for (const pattern of killPatterns(root, installDir, scope)) {
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
 * Windows kill, for waves 1 and 3 alike (taskkill is forced either way).
 * `all`: the packaged image name, plus electron.exe processes started from
 * THIS repo (`pnpm start` runs electron, not DevBar.exe, so the image-name
 * kill alone would leave a dev instance alive; killing every electron.exe
 * on the machine would be too aggressive). `dist`: only DevBar.exe under
 * the build output — an image-name kill would take the installed copy
 * down with it.
 */
function windowsKill(context: StopContext, scope: StopScope): void {
  const run = quietRun(context.probe);
  if (scope === 'dist') {
    run(
      'powershell',
      psArgs(
        windowsKillImageUnderDirCommand(IMAGE, distExecutableDir(context.root)),
      ),
    );
    return;
  }
  run('taskkill', windowsKillImageTreeArgs(IMAGE));
  run('powershell', psArgs(windowsKillDevInstanceCommand(context.root)));
}

/**
 * Wave 1 — kill. Windows: see windowsKill. Linux: the service trees first
 * (they outlive a bare pkill of the app), then the instances themselves —
 * TERM, so a current build can also run its own graceful shutdown.
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
export function killRunningInstances(
  context: StopContext,
  scope: StopScope = 'all',
): ServiceGroup[] {
  step(
    scope === 'dist'
      ? 'Stopping any DevBar running from the build output (dist/)…'
      : 'Stopping any running DevBar…',
  );
  if (context.platform === 'win32') {
    windowsKill(context, scope);
    return [];
  }
  const run = quietRun(context.probe);
  const patterns = killPatterns(context.root, context.installDir, scope);
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
export function verifyStopped(
  context: StopContext,
  scope: StopScope = 'all',
): void {
  for (let i = 0; i < VERIFY_POLLS; i++) {
    if (!isAnyDevBarAlive(context, scope)) return;
    context.wait(VERIFY_POLL_MS);
  }
  if (isAnyDevBarAlive(context, scope))
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
  scope: StopScope = 'all',
): void {
  // A service group survives on its own even when every app instance is
  // gone — it matches none of the liveness patterns, so it needs its own
  // entry condition.
  if (!isAnyDevBarAlive(context, scope) && groups.length === 0) return;
  warn('A DevBar process ignored the graceful stop — forcing it.');
  const run = quietRun(context.probe);
  if (context.platform === 'win32') {
    windowsKill(context, scope);
  } else {
    const patterns = killPatterns(context.root, context.installDir, scope);
    for (const pattern of patterns) run('pkill', ['-9', '-f', pattern]);
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
    if (!isAnyDevBarAlive(context, scope)) {
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

/** The three waves, in order, for one scope. */
export function stopInstances(context: StopContext, scope: StopScope): void {
  const groups = killRunningInstances(context, scope);
  verifyStopped(context, scope);
  killLeftovers(context, groups, scope);
}
