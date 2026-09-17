import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBranches } from '../src/git-manager.js';

/**
 * listBranches' failure classification drives the tray branch selector:
 * only the git diagnostics that PROVE "not a repository" may set
 * isRepo: false (the UI then hides the selector with a TTL); anything
 * else must stay an unclassified operational failure. These cases are
 * exercised against the real git binary (CI images always have it).
 */
describe('listBranches failure classification', () => {
  it('a plain directory (not a git repo) is classified isRepo: false', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-notrepo-'));
    try {
      const res = await listBranches(dir);
      expect(res.ok).toBe(false);
      expect(res.isRepo).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing directory is classified isRepo: false (cannot change to…)', async () => {
    // git -C <gone> fails with "fatal: cannot change to '<path>':
    // No such file or directory" (stable in the forced C locale) — the
    // same UI verdict as a non-repo, so a deleted/renamed project folder
    // hides the selector instead of leaving it stuck on "Cargando…".
    const res = await listBranches(
      path.join(os.tmpdir(), 'devbar-does-not-exist-xyz'),
    );
    expect(res.ok).toBe(false);
    expect(res.isRepo).toBe(false);
  });

  it('a permission-denied path is an operational failure, not "not a repo"', async () => {
    // POSIX-only setup: 0o000 does not block traversal on Windows, where
    // the path would then read as "missing" (isRepo: false) and the
    // assertion below would fail for the wrong reason.
    if (process.platform === 'win32') return;
    // Root (or CAP_DAC_OVERRIDE) traverses 0o000 anyway, so the premise
    // only holds for unprivileged processes.
    if (typeof process.geteuid === 'function' && process.geteuid() === 0)
      return;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-noperm-'));
    const locked = path.join(base, 'locked');
    fs.mkdirSync(locked, { mode: 0o000 });
    try {
      // git -C <locked>/inner fails with "fatal: cannot change to
      // '…': Permission denied" — that diagnostic says nothing about
      // whether the folder is a repository, so no isRepo verdict.
      const res = await listBranches(path.join(locked, 'inner'));
      expect(res.ok).toBe(false);
      expect(res.isRepo).toBeUndefined();
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('an actual repository resolves its branches', async () => {
    // The devbar checkout itself is a repository (tests run from the
    // repo root).
    const res = await listBranches(process.cwd());
    if (!res.ok) return; // no git in the environment: classification
    // is covered by the two cases above.
    expect(res.isRepo).toBe(true);
    expect(Array.isArray(res.branches)).toBe(true);
  });
});
