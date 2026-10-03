import { parseProcessId } from '../compound-id.js';
import {
  buildFixtureGroups,
  clampFixtureRepeat,
  FIXTURE_ID_PREFIX,
  type FixtureEnvironment,
} from './fixture-groups.js';
import type { Group } from '../domain-types.js';

/**
 * Turns the dev panel's "Grupos de prueba" on and off.
 *
 * On: the store's groups overlay takes the fixture set, so every window shows
 * only the test groups while the user's own stay on disk untouched — and
 * their running processes keep running, out of sight.
 *
 * Off: every fixture process is stopped and AWAITED first, then the overlay
 * goes and the real groups come back. A stop that fails keeps the overlay
 * up: dropping it would leave a running child that no window can reach.
 */

export interface FixtureHost {
  environment: () => FixtureEnvironment;
  setOverlay: (groups: readonly Group[] | null) => void;
  /** Every process id the process manager tracks. */
  processIds: () => string[];
  stop: (id: string) => Promise<{ ok: boolean; error?: string | undefined }>;
  removeState: (id: string) => void;
  /** Repaints every window and re-targets the repo watchers. */
  refresh: () => void;
}

export interface FixtureStatus {
  active: boolean;
  repeat: number;
}

export interface FixtureResult extends FixtureStatus {
  ok: boolean;
  error?: string;
}

/** Whether a process belongs to a fixture group (never a real one). */
export function isFixtureProcess(id: string): boolean {
  const parsed = parseProcessId(id);
  return (
    (parsed.kind === 'command' ||
      parsed.kind === 'action' ||
      parsed.kind === 'prescript') &&
    parsed.groupId.startsWith(FIXTURE_ID_PREFIX)
  );
}

export function createFixtureMode(host: FixtureHost): {
  status: () => FixtureStatus;
  enable: (repeat: unknown) => Promise<FixtureResult>;
  disable: () => Promise<FixtureResult>;
} {
  let active = false;
  let repeat = 1;
  const status = (): FixtureStatus => ({ active, repeat });

  /** Stops every fixture process; the ids that would not stop. */
  async function stopFixtures(): Promise<string[]> {
    const ids = host.processIds().filter(isFixtureProcess);
    const results = await Promise.all(ids.map((id) => host.stop(id)));
    const failed = ids.filter((_, index) => !results[index]?.ok);
    for (const id of ids) if (!failed.includes(id)) host.removeState(id);
    return failed;
  }

  function refused(failed: string[]): FixtureResult {
    return {
      ok: false,
      ...status(),
      error: `No se pudieron parar: ${failed.join(', ')}`,
    };
  }

  return {
    status,
    async enable(requested) {
      const copies = clampFixtureRepeat(requested);
      if (active) {
        const failed = await stopFixtures();
        if (failed.length) return refused(failed);
      }
      host.setOverlay(buildFixtureGroups(host.environment(), copies));
      active = true;
      repeat = copies;
      host.refresh();
      return { ok: true, ...status() };
    },
    async disable() {
      if (!active) return { ok: true, ...status() };
      const failed = await stopFixtures();
      if (failed.length) return refused(failed);
      host.setOverlay(null);
      active = false;
      host.refresh();
      return { ok: true, ...status() };
    },
  };
}
