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
        env: enhancedEnv(),
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
export async function listBranches(
  repo: string,
): Promise<{ ok: boolean; branches?: string[]; error?: string | undefined }> {
  if (!repo) return { ok: false, error: 'No git repo configured' };
  const result = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  if (!result.ok) return { ok: false, error: result.error };
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
  return { ok: true, branches };
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
