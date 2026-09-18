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
import { readFileSync } from 'node:fs';
import { isEntrypoint } from './script-runtime.ts';

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

/** Escape a literal path for pgrep/pkill's extended-regex pattern. */
export function ereEscape(value: string): string {
  return value.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
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
 * Grace window between SIGTERM and the SIGKILL escalation: long enough
 * for a normal dev server to finish its shutdown handler, short enough
 * that an installer never hangs on one bad service.
 */
export const POSIX_SERVICE_GRACE_MS = 2000;

/**
 * Bounded re-probing AFTER the SIGKILL escalation. Kill is async: the
 * kernel reaps a group within a few milliseconds, but on a loaded
 * runner that can exceed an immediate probe. Poll each identity-
 * matching group within a shared budget so a group that is still in
 * the middle of dying is not reported as a (false) survivor.
 */
export const POSIX_POST_KILL_POLL_MS = 100;
export const POSIX_POST_KILL_POLLS = 20; // ~2 s of worst-case total

const defaultWait = (ms: number): void => {
  // A CLI script may block: no child process needed for a wait.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** True while the process group (pgid == the leader pid) still has a
 *  member: `kill -0` on the group id (ESRCH => gone). */
const defaultGroupAlive = (leaderPid: string): boolean => {
  const res = spawnSync('kill', ['-0', '--', `-${leaderPid}`], {
    stdio: 'ignore',
  });
  return res.status === 0;
};

/**
 * A STABLE identity for a pid, or null when the process is gone (or no
 * primitive is available on this platform). Used to revalidate a
 * discovered service before a DELAYED signal: PIDs are recycled, and a
 * leader that exited during the grace window could hand its pid — and
 * even its process group id — to an unrelated process, which the
 * escalation must never kill.
 *
 * Linux: /proc/<pid>/stat field 22 (starttime, jiffies since boot —
 * cannot be forged without the kernel). Other POSIX: `ps lstart`.
 */
const defaultProcessIdentity = (pid: string): string | null => {
  try {
    // Field 2 is the command name in parentheses and may itself contain
    // spaces/parens — anchor on the LAST ')' to split the fields.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // fields[0] is stat field 3 (state); field 22 (starttime) is index 19.
    const starttime = fields[19];
    return starttime != null ? `starttime:${starttime}` : null;
  } catch {
    try {
      const res = spawnSync('ps', ['-o', 'lstart=', '-p', pid], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      const lstart = (res.stdout ?? '').trim();
      return res.status === 0 && lstart !== '' ? `lstart:${lstart}` : null;
    } catch {
      return null;
    }
  }
};

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
 * Escalation: SIGTERM is a request, and a service whose command line
 * matches none of the app's kill patterns is invisible to the instance
 * pkill waves — if it ignores TERM it would keep its port while the
 * install proceeds. So every discovered group id is retained, and after
 * the grace window the groups get SIGKILL. KILLing an already-dead group
 * is a harmless no-op, which keeps this best effort: "nothing to stop"
 * is an expected outcome, and a pattern matching nothing must not fail
 * the install.
 *
 * Returns the group leader pids that SURVIVE the SIGKILL escalation:
 * SIGKILL cannot be caught, so a survivor (stuck in uninterruptible I/O)
 * is not something the installer can clear — the caller must fail rather
 * than installing under a live service.
 *
 * Non-service children (Electron helpers) are NOT group leaders, so the
 * group form fails and the plain-pid form kills just that helper — which
 * the instance's own pkill takes down anyway.
 */
export function posixKillServiceTrees(
  patterns: string[],
  {
    run = defaultRun,
    wait = defaultWait,
    graceMs = POSIX_SERVICE_GRACE_MS,
    groupAlive = defaultGroupAlive,
    processIdentity = defaultProcessIdentity,
  }: {
    run?: KillTreeRun;
    wait?: (ms: number) => void;
    graceMs?: number;
    /** Liveness probe for a service group (pgid == the leader pid). */
    groupAlive?: (leaderPid: string) => boolean;
    /** Stable-identity probe for a pid (null when gone/unknown). */
    processIdentity?: (pid: string) => string | null;
  } = {},
): string[] {
  const groups: string[] = [];
  // Identity captured at DISCOVERY: the delayed SIGKILL must revalidate
  // against it (pid reuse during the grace window).
  const identities = new Map<string, string | null>();
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
        // Capture the leader's identity BEFORE any signal: if the process
        // exits in the gap between the two TERM signals, a post-signal
        // capture could record a REPLACEMENT that already took the pid.
        identities.set(child, processIdentity(child));
        // Group first (leader == child pid: shell + user command), then the
        // bare pid in case the group is already gone.
        run('kill', ['-s', 'TERM', '--', `-${child}`]);
        run('kill', ['-s', 'TERM', child]);
        groups.push(child);
      }
    }
  }
  if (groups.length === 0) return [];
  wait(graceMs);
  for (const child of groups) {
    // Revalidate the identity captured at discovery: if the leader
    // exited and its pid was REUSED, the group kill would target a new
    // group and the plain-pid kill an unrelated process — skip both.
    // (A null capture means the identity primitive was unavailable or
    // the process was already gone: nothing to revalidate, and the
    // signal is then a no-op.)
    const captured = identities.get(child) ?? null;
    if (captured !== null && processIdentity(child) !== captured) continue;
    // Same group-then-pid order; a group that honored TERM is gone by now
    // and the signal is a no-op for it.
    run('kill', ['-s', 'KILL', '--', `-${child}`]);
    run('kill', ['-s', 'KILL', child]);
  }
  // SIGKILL is async: the kernel reaps the group a few ms after the
  // signal, and an immediate probe can see a group that is already in
  // the middle of dying. Re-probe each identity-matching group within
  // a shared budget before declaring it a survivor.
  let pollsLeft = POSIX_POST_KILL_POLLS;
  const settled = new Map<string, boolean>();
  for (const child of groups) {
    const captured = identities.get(child) ?? null;
    if (captured !== null && processIdentity(child) !== captured) continue;
    let alive = groupAlive(child);
    while (alive && pollsLeft > 0) {
      wait(POSIX_POST_KILL_POLL_MS);
      pollsLeft -= 1;
      alive = groupAlive(child);
    }
    settled.set(child, alive);
  }
  // A survivor is a leader whose identity STILL MATCHES and whose group
  // still has members after the post-kill budget: an identity-mismatched
  // entry means the original exited and its pid/pgid was reused — that
  // live group is an unrelated process, not a surviving service
  // (reporting it would fail a healthy install).
  return groups.filter((child) => {
    const captured = identities.get(child) ?? null;
    if (captured !== null && processIdentity(child) !== captured) return false;
    return settled.get(child) ?? groupAlive(child);
  });
}

// ── CLI entry: `node --experimental-strip-types scripts/lib/kill-trees.ts <pattern>…` ──
// Used by install-local.sh (bash) so all three OSes share one
// implementation of the tree walk instead of three.

if (isEntrypoint(import.meta.url)) {
  const patterns = process.argv.slice(2);
  if (process.platform === 'win32') {
    console.error(
      '[kill-trees] CLI form is POSIX-only; Windows uses windowsKillImageTreeArgs()',
    );
    process.exit(1);
  }
  const survivors = posixKillServiceTrees(patterns);
  if (survivors.length > 0) {
    // A group that outlives SIGKILL still holds whatever port or lock it
    // held: the installer must fail loudly instead of swapping files
    // under a live service. (A clean machine — nothing matched — still
    // exits 0; that is the normal case.)
    console.error(
      `[kill-trees] service group(s) survived SIGKILL: ${survivors.join(', ')} — aborting.`,
    );
    process.exit(1);
  }
}
