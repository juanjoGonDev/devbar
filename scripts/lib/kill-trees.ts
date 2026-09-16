/**
 * Kill helpers shared by the local installers (install-local.ts for
 * win/linux, install-local.sh for macOS via the CLI entry below).
 *
 * Why this exists: a running DevBar owns service trees — its commands
 * spawn a shell that runs the user command (a dev server holding a port,
 * typically). "Kill the app" must therefore be "kill the app AND its
 * trees", otherwise the services outlive the reinstall and the next start
 * fails with "address already in use".
 *
 * Kept out of install-local.ts so the exact argument shapes are
 * unit-testable without running an install.
 *
 * Known limitation: killing is done per process GROUP (pgid). A
 * descendant that detaches itself from the group — `setsid`, double
 * fork, systemd-run, `start` in a new Windows process group — escapes
 * the kill and survives. That is a fundamental limit of group-based
 * killing; the only full fix is a per-service supervisor process
 * (e.g. a subreaper on Linux), which is tracked as a follow-up. The
 * services DevBar manages are long-running user commands launched by
 * DevBar itself, and the escalated wait (SIGTERM -> SIGKILL per pgid)
 * covers all of them; only a service that deliberately re-parents
 * itself can leave an orphan.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Spawn a process, ignoring its exit status. Returns stdout or null. */
export type KillTreeRun = (cmd: string, args: string[]) => string | null;

const defaultRun: KillTreeRun = (cmd, args) => {
  try {
    const res = spawnSync(cmd, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return res.error ? null : (res.stdout ?? null);
  } catch {
    return null;
  }
};

/**
 * Windows: taskkill every process with this image name, walking its whole
 * tree. `/T` is the part that reaches the services: without it only the
 * DevBar.exe process dies and the user's dev servers keep their ports.
 */
export function windowsKillImageTreeArgs(image: string): string[] {
  return ['/F', '/T', '/IM', image];
}

/**
 * Escape a path for safe embedding in a PowerShell single-quoted
 * `-like` pattern: `'` is doubled (it would terminate the string), and
 * the wildcard characters `[ ] * ?` — plus a literal backtick, which is
 * `-like`'s own escape character — are escaped with the backtick, the
 * documented wildcard escape (what `[WildcardPattern]::Escape()`
 * produces). Backslashes stay literal: PowerShell single-quoted strings
 * have no backslash escape and `-like` has no backslash metacharacter.
 * (Keep in sync with the inline copy in install-local.ts — strip-only
 * mode cannot import it from here.)
 */
export function psLikeEscape(value: string): string {
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

/**
 * Windows dev mode: the instance is electron.exe started from a given
 * checkout, so it cannot be matched by image name alone. Find those
 * processes by command line and taskkill each one with /T.
 *
 * NOTE: backslashes are NOT doubled — PowerShell single-quoted strings
 * treat `\` as literal and `-like` has no backslash metacharacters, so
 * the pattern must contain the path exactly as the command line does
 * (apart from the wildcard/quote escaping psLikeEscape applies).
 */
export function windowsKillDevInstanceCommand(checkoutPath: string): string {
  const escaped = psLikeEscape(checkoutPath);
  return (
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    `ForEach-Object { & taskkill /PID $($_.ProcessId) /T /F | Out-Null }`
  );
}

/**
 * POSIX: kill each matching instance's service trees BEFORE the instance
 * itself (the caller still pkill -f's the instances).
 *
 * A service spawns `detached`, so it is the leader of its own process
 * group (pgid == its own pid) and a bare `pkill` of the app never reaches
 * it. `pgrep -P <app>` finds the service's shell — the app's direct child
 * and group leader — and `kill -TERM -- -<pid>` signals the group: the
 * shell plus everything the user command spawned.
 *
 * Non-service children (Electron helpers) are NOT group leaders, so the
 * group form fails and the plain-pid form kills just that helper — which
 * the instance's own pkill takes down anyway. Best effort throughout:
 * "nothing to stop" is an expected outcome, and a pattern matching
 * nothing must not fail the install.
 */
export function posixKillServiceTrees(
  patterns: string[],
  { run = defaultRun }: { run?: KillTreeRun } = {},
): void {
  for (const pattern of patterns) {
    const pidOut = run('pgrep', ['-f', pattern]);
    if (pidOut == null) continue;
    for (const pid of pidOut.split('\n').map((line) => line.trim())) {
      if (!pid) continue;
      // pgrep -f can match the caller's own spawn line (the CLI form passes
      // the patterns on argv, and so can a wrapping shell) — never signal
      // self or the parent shell.
      if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
      const childOut = run('pgrep', ['-P', pid]);
      if (childOut == null) continue;
      for (const child of childOut.split('\n').map((line) => line.trim())) {
        if (!child) continue;
        // Group first (leader == child pid: shell + user command), then the
        // bare pid in case the group is already gone.
        run('kill', ['-s', 'TERM', '--', `-${child}`]);
        run('kill', ['-s', 'TERM', child]);
      }
    }
  }
}

// ── CLI entry: `node --experimental-strip-types scripts/lib/kill-trees.ts <pattern>…` ──
// Used by install-local.sh (bash) so all three OSes share one
// implementation of the tree walk instead of three.

function isDirectRun(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

if (isDirectRun()) {
  const patterns = process.argv.slice(2);
  if (process.platform === 'win32') {
    console.error(
      '[kill-trees] CLI form is POSIX-only; Windows uses windowsKillImageTreeArgs()',
    );
    process.exit(1);
  }
  posixKillServiceTrees(patterns);
  // Best effort: exit 0 even when nothing matched — a clean machine is the
  // normal case and the installer must not treat it as a failure.
}
