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
    // The non-repository diagnostics (stable in the forced C locale across
    // git versions) are the ONLY failures we can classify: "not a git
    // repository" for a plain directory, and "cannot change to …" when the
    // configured path itself no longer exists (deleted/renamed folder).
    if (
      (probe.stderr || '').includes('fatal: not a git repository') ||
      (probe.stderr || '').includes('fatal: cannot change to')
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
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  if (!result.ok) return { ok: false, isRepo: true, error: result.error };
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.endsWith('/HEAD')) continue;
    const name = line.startsWith('origin/') ? line.slice(7) : line;
    if (!seen.has(name)) {
      seen.add(name);
      branches.push(name);
    }
  }
  branches.sort();
  return { ok: true, branches, isRepo: true };
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
  const dirty = await git(repo, ['status', '--porcelain']);
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
  const pulled = await git(repo, ['pull', '--ff-only', 'origin', branch], {
    timeout: 60000,
  });
  return pulled.ok ? { ok: true } : { ok: false, error: pulled.error };
}
