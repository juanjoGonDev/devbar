import { describe, expect, it } from 'vitest';
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

describe('stop() on POSIX — signal-based kill detection', () => {
  it('logs a signal-based stop and leaves killRequested empty', async () => {
    const pm = new ProcessManager(store);
    const pid = makeCommandId('g1', 'c1');
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
  });
});
