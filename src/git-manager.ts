import { execFile } from 'node:child_process';
import { expandTilde, enhancedEnv } from './path-helper.js';
interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string | undefined;
}
interface GitOptions {
  timeout?: number;
  /** Extra env merged over enhancedEnv() (e.g. a forced diagnostic locale). */
  env?: NodeJS.ProcessEnv;
}
function git(
  repo: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['-C', expandTilde(repo), ...args],
      {
        timeout: options.timeout ?? 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...enhancedEnv(), ...options.env },
      },
      (error, stdout, stderr) => {
        resolve(
          error
            ? {
                ok: false,
                error: (stderr || error.message).trim(),
                stdout,
                stderr,
              }
            : { ok: true, stdout: stdout.trim(), stderr },
        );
      },
    ),
  );
}
/**
 * The name to offer for a ref: `refs/heads/x` and `refs/remotes/origin/x` are
 * the same branch seen from two sides, so both read as `x`; any other remote
 * keeps its prefix, the way git itself prints it.
 */
function branchName(refname: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/origin/', 'refs/remotes/'])
    if (refname.startsWith(prefix)) return refname.slice(prefix.length);
  return refname;
}

export async function listBranches(repo: string): Promise<{
  ok: boolean;
  branches?: string[];
  error?: string | undefined;
  /**
   * False when the path is not a git repository (or has no path): the UI
   * hides the branch selector instead of showing a stuck "Cargando…".
   */
  isRepo?: boolean;
}> {
  if (!repo)
    return { ok: false, isRepo: false, error: 'No git repo configured' };
  // Probe first: `rev-parse --is-inside-work-tree` succeeds only inside a
  // work tree. Outside one it exits 128 with git's diagnostic — so the
  // probe's FAILURE is the ordinary non-repository result and must be
  // classified as such, or the UI never sees isRepo: false for a
  // configured non-repo directory. The diagnostic text is localized, so
  // the probe forces the C locale to make it parseable.
  const probe = await git(repo, ['rev-parse', '--is-inside-work-tree'], {
    timeout: 5000,
    env: { LC_ALL: 'C', LANG: 'C' },
  });
  if (!probe.ok) {
    // The missing-path diagnostics (stable in the forced C locale across
    // git versions) are the ONLY failures we can classify as "not a
    // repository": "not a git repository" for a plain directory, and
    // "cannot change to …: No such file or directory" when the configured
    // path itself no longer exists (deleted/renamed folder). The
    // "cannot change to" prefix alone is NOT enough — it also prefixes
    // operational failures like "Permission denied", which say nothing
    // about whether the folder is a repository.
    const stderr = probe.stderr || '';
    if (
      stderr.includes('fatal: not a git repository') ||
      (stderr.includes('fatal: cannot change to') &&
        stderr.includes('No such file or directory'))
    ) {
      return { ok: false, isRepo: false, error: 'not a git repository' };
    }
    // git timed out, is missing, or failed for another operational
    // reason: we learned nothing, so do NOT assert "not a repository" —
    // that verdict would make the UI hide the selector (negative cache)
    // even though the project may be a perfectly good repo.
    return { ok: false, error: probe.error ?? 'git probe failed' };
  }
  if (probe.stdout !== 'true') {
    return { ok: false, isRepo: false, error: 'not a git repository' };
  }
  const result = await git(repo, [
    // Full refnames, not `%(refname:short)`. The short form of
    // `refs/remotes/origin/HEAD` — the pointer every `git clone` writes — is
    // just `origin`, indistinguishable from a branch of that name, so the
    // guard below could never see it and the selector offered the remote
    // itself as somewhere to switch to.
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]);
  if (!result.ok) return { ok: false, isRepo: true, error: result.error };
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.endsWith('/HEAD')) continue;
    const name = branchName(line);
    if (!seen.has(name)) {
      seen.add(name);
      branches.push(name);
    }
  }
  branches.sort();
  return { ok: true, branches, isRepo: true };
}
/**
 * How long a repository's remote refs are trusted after a refresh finished.
 * The selector asks for branches every time a dropdown opens, and a fetch is a
 * network round trip against the forge: without a floor, three opens in a row
 * would hit origin three times for an answer that cannot have moved in
 * between — and on a slow or paid connection that is felt.
 */
export const REMOTE_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * The clock the throttle reads, replaceable so a test can jump the window
 * instead of standing still for a real minute.
 */
let refreshClock: () => number = () => Date.now();
/** When each repo's last refresh FINISHED, keyed by the path as it was given. */
const lastRefreshEndedAt = new Map<string, number>();
/**
 * Refreshes still running. A burst of dropdown opens must share ONE fetch:
 * concurrent `git fetch` runs on the same repository contend for the same
 * refs and index locks, and the second one buys nothing the first is not
 * already bringing.
 */
const refreshInFlight = new Map<string, Promise<{ changed: boolean }>>();

/** Test seam: forgets the throttle and in-flight bookkeeping, and the clock. */
export function resetRemoteRefreshForTests(fakeClock?: () => number): void {
  lastRefreshEndedAt.clear();
  refreshInFlight.clear();
  refreshClock = fakeClock ?? (() => Date.now());
}

/**
 * The remote-tracking refs as one comparable string, or null when git could
 * not answer at all (not a repository, binary missing, timed out) — which is
 * not the same as "there are no remote refs", an empty but valid answer.
 */
async function remoteRefsSnapshot(repo: string): Promise<string | null> {
  const res = await git(repo, [
    // Object names as well as names: a branch the remote FORCE-PUSHED keeps
    // its refname and only moves its tip, and the selector's consumer wants
    // to know about that too.
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/remotes',
  ]);
  return res.ok ? res.stdout : null;
}

async function fetchAndCompare(repo: string): Promise<{ changed: boolean }> {
  const before = await remoteRefsSnapshot(repo);
  if (before === null) return { changed: false };
  // `--prune` so a branch DELETED on the remote also counts as a change and
  // stops being offered; without it the selector would keep listing branches
  // that no longer exist anywhere.
  const fetched = await git(repo, ['fetch', '--prune', 'origin'], {
    timeout: 60000,
  });
  if (!fetched.ok) return { changed: false };
  const after = await remoteRefsSnapshot(repo);
  return { changed: after !== null && after !== before };
}

/**
 * Bring `refs/remotes` up to date behind the selector's back, and say whether
 * anything actually moved.
 *
 * Silent on every failure — offline, no `origin`, a credential prompt the user
 * refused, git missing, the fetch timing out — because the branch list the
 * user asked for was already answered from local refs and is perfectly usable.
 * Surfacing a network problem here would turn "your branches are a minute old"
 * into a branch error on a selector that is working fine.
 *
 * Deliberately not `async`: the in-flight registration below has to happen in
 * the same synchronous turn as the call, or two opens in the same tick would
 * both miss it and both fetch.
 */
export function refreshRemotes(repo: string): Promise<{ changed: boolean }> {
  // No path configured: there is nothing to fetch, and `git -C ''` is a no-op
  // for git, which would run the fetch against whatever directory this
  // process happens to be sitting in.
  if (!repo) return Promise.resolve({ changed: false });
  const pending = refreshInFlight.get(repo);
  if (pending) return pending;
  const endedAt = lastRefreshEndedAt.get(repo);
  if (
    endedAt !== undefined &&
    refreshClock() - endedAt < REMOTE_REFRESH_MIN_INTERVAL_MS
  )
    return Promise.resolve({ changed: false });
  const run = fetchAndCompare(repo)
    // The caller fires and forgets, and an unhandled rejection takes the whole
    // main process down: the "never throws" promise is kept here rather than
    // assumed of everything fetchAndCompare touches.
    .catch(() => ({ changed: false }))
    .finally(() => {
      // Stamped on failure too. An offline machine fails FAST, and without a
      // stamp every dropdown open would retry the doomed fetch.
      lastRefreshEndedAt.set(repo, refreshClock());
      refreshInFlight.delete(repo);
    });
  refreshInFlight.set(repo, run);
  return run;
}

export async function currentBranch(
  repo: string,
): Promise<{ ok: boolean; branch?: string; error?: string | undefined }> {
  if (!repo) return { ok: false, error: 'No git repo configured' };
  const r = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? { ok: true, branch: r.stdout } : { ok: false, error: r.error };
}
export async function switchBranch(
  repo: string,
  branch: string,
): Promise<{ ok: boolean; error?: string | undefined }> {
  if (!repo) return { ok: false, error: 'No git repo configured' };
  if (!branch) return { ok: false, error: 'No branch specified' };
  // `--untracked-files=no` on purpose: a checkout carries untracked files
  // across untouched, so refusing the switch over them blocks the ordinary
  // state of a working copy — an editor's folder, a scratch note, a tool's
  // config. Only TRACKED modifications can be lost by switching. Where an
  // untracked file really is in the way (the target branch has one at the
  // same path) git refuses the checkout itself, with a message naming the
  // file, which is more useful than anything guessed from here.
  const dirty = await git(repo, [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  if (!dirty.ok) return { ok: false, error: dirty.error };
  if (dirty.stdout)
    return {
      ok: false,
      error: 'Working tree has uncommitted changes — commit or stash first',
    };
  const fetched = await git(repo, ['fetch', 'origin'], { timeout: 60000 });
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const local = await git(repo, [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}`,
  ]);
  const checkout = local.ok
    ? await git(repo, ['checkout', branch])
    : await git(repo, ['checkout', '-B', branch, `origin/${branch}`]);
  if (!checkout.ok) return { ok: false, error: checkout.error };
  // The checkout has already happened, so from here the switch SUCCEEDED and
  // only the catch-up can fail. A branch that was never pushed has no
  // `origin/<branch>` to pull from, and `git pull origin <branch>` answers
  // "couldn't find remote ref" — reporting that as a failed switch told the
  // user nothing worked while leaving them on the branch they asked for.
  const remote = await git(repo, [
    'rev-parse',
    '--verify',
    `refs/remotes/origin/${branch}`,
  ]);
  if (!remote.ok) return { ok: true };
  const pulled = await git(repo, ['pull', '--ff-only', 'origin', branch], {
    timeout: 60000,
  });
  return pulled.ok ? { ok: true } : { ok: false, error: pulled.error };
}
