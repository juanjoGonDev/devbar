const { execFile } = require('child_process');
const { expandTilde, enhancedEnv } = require('./path-helper');

function git(repo, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', expandTilde(repo), ...args],
      {
        timeout: opts.timeout || 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: enhancedEnv(),
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: (stderr || err.message).trim(),
            stdout,
            stderr,
          });
        } else {
          resolve({ ok: true, stdout: stdout.trim(), stderr });
        }
      },
    );
  });
}

async function listBranches(repo) {
  if (!repo) return { ok: false, error: 'No git repo configured' };
  const res = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  if (!res.ok) return res;
  const seen = new Set();
  const branches = [];
  for (const raw of res.stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.endsWith('/HEAD')) continue;
    const name = line.startsWith('origin/')
      ? line.slice('origin/'.length)
      : line;
    if (seen.has(name)) continue;
    seen.add(name);
    branches.push(name);
  }
  branches.sort();
  return { ok: true, branches };
}

async function currentBranch(repo) {
  if (!repo) return { ok: false, error: 'No git repo configured' };
  const res = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!res.ok) return res;
  return { ok: true, branch: res.stdout };
}

async function switchBranch(repo, branch) {
  if (!repo) return { ok: false, error: 'No git repo configured' };
  if (!branch) return { ok: false, error: 'No branch specified' };

  const dirty = await git(repo, ['status', '--porcelain']);
  if (!dirty.ok) return dirty;
  if (dirty.stdout) {
    return {
      ok: false,
      error: 'Working tree has uncommitted changes — commit or stash first',
    };
  }

  const fetched = await git(repo, ['fetch', 'origin'], { timeout: 60000 });
  if (!fetched.ok) return fetched;

  const localExists = await git(repo, [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}`,
  ]);
  let checkout;
  if (localExists.ok) {
    checkout = await git(repo, ['checkout', branch]);
  } else {
    checkout = await git(repo, ['checkout', '-B', branch, `origin/${branch}`]);
  }
  if (!checkout.ok) return checkout;

  const pulled = await git(repo, ['pull', '--ff-only', 'origin', branch], {
    timeout: 60000,
  });
  if (!pulled.ok) return pulled;

  return { ok: true };
}

module.exports = { listBranches, currentBranch, switchBranch };
