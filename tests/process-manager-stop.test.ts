import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCommandId } from '../src/compound-id.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { Group, GlobalSettings } from '../src/domain-types.js';
import { ProcessManager } from '../src/process-manager.js';

/**
 * Real-spawn stop semantics (POSIX runners only — CI runs them on
 * ubuntu-latest). The regression guarded here: on macOS/Linux a stop is
 * recognized by the exit SIGNAL, not by the killRequested pid set (which is
 * Windows-only, because taskkill exits children with a plain code). The set
 * must therefore stay EMPTY after a POSIX stop — a stale entry could match
 * a reused pid and mislabel an unrelated process's natural exit as
 * "stopped".
 */
const GROUP: Group = normalizeGroup({
  id: 'g1',
  name: 'Stop test',
  path: process.cwd(),
  env: [],
  commands: [{ id: 'c1', name: 'Sleep', command: 'sleep 30', env: [] }],
  actions: [],
  preScripts: [],
});

const store = {
  getGroup: (id: string) => (id === GROUP.id ? GROUP : null),
  listGroups: () => [GROUP],
  getGlobalSettings: () => ({}) as GlobalSettings,
};

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until the child has really forked AND its process group exists.
 * With `detached: true` the child runs `setpgid` between fork and exec;
 * killing `-pid` before that lands in the PARENT's group (ESRCH) and the
 * stop would silently fall through to the 5 s SIGKILL timer. A short grace
 * period after the pid appears is deterministic on CI (setpgid is the
 * child's first action, microseconds in).
 */
async function waitGroupReady(pm: ProcessManager, pid: string): Promise<void> {
  await waitUntil(
    () =>
      pm.getState(pid).status === 'running' &&
      pm.getState(pid).child?.pid != null,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// POSIX only: this suite spawns `sleep 30` through the user shell and
// asserts on the SIGTERM/SIGKILL signal-based kill path. On Windows the
// service launch shape (ComSpec /d /s /c) and the kill shape (taskkill
// /T /F, no signals) are entirely different, and `sleep` does not exist —
// skip the suite there rather than let it fail.
describe.skipIf(process.platform === 'win32')(
  'stop() on POSIX — signal-based kill detection',
  () => {
    // start() runs the command through userShell() (src/platform.ts, which
    // reads $SHELL at call time) in INTERACTIVE mode — i.e. the CONTRIBUTOR's
    // own shell with their rc files. Whether that shell dies on a group
    // SIGTERM is then a property of the developer's machine, not of the code
    // under test: a zsh with a typical ~/.zshrc forks an interactive tree that
    // IGNORES SIGTERM, so the stop falls through to the 6.5 s give-up and the
    // run can only end in a timeout.
    //
    // Pin both halves of that dependency instead:
    // - /bin/bash, which exec()s a simple `-c` command in place, so the pid
    //   the manager tracks IS `sleep` and dies FROM the signal. (Not /bin/sh:
    //   that is dash on Debian/Ubuntu, which does not exec-optimize and exits
    //   with plain code 143 — no signal — which this suite is asserting the
    //   absence of.)
    // - an empty $HOME, so no ~/.bashrc can install a trap; a trapped bash
    //   skips the exec and is back to ignoring SIGTERM.
    let previousShell: string | undefined;
    let previousHome: string | undefined;
    let emptyHome: string;
    beforeAll(() => {
      previousShell = process.env.SHELL;
      previousHome = process.env.HOME;
      emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-stop-home-'));
      process.env.SHELL = '/bin/bash';
      process.env.HOME = emptyHome;
    });
    afterAll(() => {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(emptyHome, { recursive: true, force: true });
    });

    // The child is a REAL `sleep 30`. Both the manager and the id live at
    // suite scope so cleanup can reach them however the test ends: a
    // waitGroupReady timeout or an assertion throwing before stop() would
    // otherwise leave the process running with its pipes attached, which
    // keeps the vitest worker alive long after the failure (the very leak the
    // `hanging-process` reporter exists to surface).
    let pm: ProcessManager | null = null;
    let pid: string | null = null;
    afterEach(async () => {
      // stop() is a no-op for anything not running, so this only ever acts on
      // a child the test left behind.
      if (pm && pid && pm.getState(pid).status === 'running')
        await pm.stop(pid);
      pm = null;
      pid = null;
    }, 15_000);

    it('logs a signal-based stop and leaves killRequested empty', async () => {
      pm = new ProcessManager(store);
      pid = makeCommandId('g1', 'c1');
      const res = pm.start(pid);
      expect(res.ok).toBe(true);
      await waitGroupReady(pm, pid);

      await pm.stop(pid);

      const lines = pm.getLogs(pid).map((entry) => entry.line);
      // The stop is recognized from the SIGTERM the group received — no
      // killRequested entry was ever added on POSIX.
      expect(lines).toContain('■ stopped (SIGTERM)');
      expect(
        (pm as unknown as { killRequested: Set<number> }).killRequested.size,
      ).toBe(0);
      expect(pm.getState(pid).status).toBe('stopped');
      // Confirmed exit releases the handle. (A FAILED stop — kill error or the
      // 6.5 s give-up — must instead keep status 'running' + child, so a later
      // start() cannot launch a duplicate while the original is alive.)
      expect(pm.getState(pid).child).toBeNull();
      // stop() budgets a 5 s SIGKILL retry plus a 6.5 s give-up, both above
      // vitest's 5 s default: without an explicit timeout a failing stop could
      // only ever surface as a timeout, never as the assertions above.
    }, 15_000);
  },
);
