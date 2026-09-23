import type { ResumeExitReason } from '../session-resume.js';
import { errorMessage } from './ipc-validators.js';

/**
 * Never orphan a service. A service that outlives DevBar keeps its port and
 * breaks the next start ("address already in use"), so EVERY exit path funnels
 * into one cleanup:
 *
 *   * `before-quit` — tray "Salir", `app:quit`, the update swap. Electron does
 *     not await an async before-quit handler: signalling only the first service
 *     and letting the event loop move on to will-quit orphans the rest.
 *     `preventDefault` + cleanup + `app.quit()` is the supported "quit when
 *     ready" pattern.
 *   * SIGINT / SIGTERM — Ctrl+C in the `pnpm start` terminal, or `kill <pid>`.
 *     Node's default is to exit instantly, leaving every service tree alive.
 *
 * A hard kill (SIGKILL, `taskkill` without /T) runs none of this; that remains
 * the only way a service can outlive DevBar.
 */

type ShutdownPhase = 'idle' | 'cleaning' | 'done';

export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`cleanup still not done after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface ResumeTrackerLike {
  flush: (exit: ResumeExitReason, ids?: readonly string[]) => boolean;
}

export interface ShutdownDeps {
  isPrimary: boolean;
  smokeMode: boolean;
  repoWatcher: { closeAll(): void };
  preScriptRunner: { isRunning(): boolean; cancel(): unknown };
  processManager: { stopAll(): Promise<{ ok: boolean; failed: string[] }> };
  /** Read late: the tracker only exists once the app-data dir is known. */
  sessionResume: () => ResumeTrackerLike | null;
  runningCommandIds: () => string[];
  /** Drop the config window's unsaved-changes veto before the windows go. */
  releaseConfigCloseGuard: () => void;
  appQuit: () => void;
  processExit: (code: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  stopAllDeadlineMs?: number;
  forceExitDelayMs?: number;
}

export interface ShutdownController {
  phase: () => ShutdownPhase;
  /** Record this exit as an UPDATE, so the relaunch may resume the services. */
  markUpdateExit: () => void;
  cleanup: () => Promise<void>;
  onBeforeQuit: (event: { preventDefault(): void }) => void;
  onTerminalSignal: () => void;
}

export function createShutdownController(
  deps: ShutdownDeps,
): ShutdownController {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const stopAllDeadlineMs = deps.stopAllDeadlineMs ?? 8000;
  const forceExitDelayMs = deps.forceExitDelayMs ?? 4000;

  let phase: ShutdownPhase = 'idle';
  // The in-flight cleanup, shared by every caller that arrives while it is
  // running: resolving them immediately would let that caller quit the process
  // the moment ITS (instant) promise settles — mid-stopAll.
  let activeCleanup: Promise<void> | null = null;
  let quitFollowUpScheduled = false;
  let terminalSignals = 0;
  /** `quit` is the default; the signal handler rewrites it to `kill` and the
   *  update flows to `update`. A `quit` snapshot is never resumed — a
   *  deliberate stop stays a stop. */
  let pendingExitReason: ResumeExitReason = 'quit';

  async function performShutdownCleanup(): Promise<void> {
    try {
      deps.releaseConfigCloseGuard();
      deps.repoWatcher.closeAll();
      // Cancel the pre-script pipeline run, if any — one global pipeline now.
      if (deps.preScriptRunner.isRunning()) {
        try {
          deps.preScriptRunner.cancel();
        } catch (_) {}
      }
      // Session resume: capture the running set BEFORE the services are
      // stopped (after stopAll there is nothing left to hand over), with the
      // exit reason that decides whether the next launch may resume it. Smoke
      // mode runs on CI hosts without user services — skip it.
      const tracker = deps.smokeMode ? null : deps.sessionResume();
      let resumeIds: string[] | null = null;
      if (tracker) {
        resumeIds = deps.runningCommandIds();
        tracker.flush(pendingExitReason, resumeIds);
      }
      // Every running service — commands, actions AND pre-scripts: stopAll
      // walks the manager's own state, not just the configured commands. Each
      // stop escalates to SIGKILL / taskkill /F after 5 s; the overall deadline
      // keeps one wedged service from holding the quit hostage.
      const stopped = await withDeadline(
        deps.processManager.stopAll(),
        stopAllDeadlineMs,
      );
      if (!stopped.ok) {
        // Best effort: the quit still proceeds, but log WHAT survived — a
        // wedged child left running after quit is an "address in use" bomb.
        console.error(
          `shutdown cleanup: ${stopped.failed.length} service(s) still running after forced stop: ${stopped.failed.join(', ')}`,
        );
        // A service that survived the quit is STILL RUNNING: resuming it on the
        // next launch would start a second copy (port conflicts, duplicate
        // work). Rewrite the snapshot without it — successfully stopped
        // commands keep their resume entries.
        if (resumeIds && tracker) {
          const survivors = new Set(stopped.failed);
          tracker.flush(
            pendingExitReason,
            resumeIds.filter((id) => !survivors.has(id)),
          );
        }
      }
    } catch (err) {
      // Cleanup is best-effort; the quit itself must always proceed.
      console.error(`shutdown cleanup failed: ${errorMessage(err)}`);
    } finally {
      phase = 'done';
    }
  }

  async function cleanup(): Promise<void> {
    if (phase === 'done') return;
    if (phase === 'cleaning' && activeCleanup) return activeCleanup;
    phase = 'cleaning';
    const run = performShutdownCleanup();
    activeCleanup = run;
    try {
      await run;
    } finally {
      if (activeCleanup === run) activeCleanup = null;
    }
  }

  // Exactly one follow-up quit per cleanup. Re-queueing on every prevented
  // before-quit would spin a microtask storm (each app.quit() re-fires
  // before-quit while the cleanup is still running) and starve the very
  // cleanup it is supposed to wait for.
  function scheduleQuitAfterCleanup(): void {
    if (quitFollowUpScheduled) return;
    quitFollowUpScheduled = true;
    void cleanup().then(() => {
      quitFollowUpScheduled = false;
      deps.appQuit();
    });
  }

  return {
    phase: () => phase,
    markUpdateExit: () => {
      pendingExitReason = 'update';
    },
    cleanup,

    onBeforeQuit(event): void {
      // A second instance quit must be INSTANT: it runs no services and must
      // not touch the primary's session-resume snapshot (an empty flush would
      // delete it).
      if (!deps.isPrimary) return;
      if (phase === 'done') return; // cleanup finished — let it die
      event.preventDefault(); // still cleaning (or not started) — hold the quit
      scheduleQuitAfterCleanup();
    },

    onTerminalSignal(): void {
      terminalSignals += 1;
      if (!deps.isPrimary) {
        deps.processExit(0);
        return;
      }
      // install-local / `kill` / Ctrl+C: the next launch may resume the
      // services (reason recorded when the snapshot is flushed on cleanup).
      pendingExitReason = 'kill';
      if (terminalSignals > 1) {
        // Second Ctrl+C / kill: the user wants out NOW.
        deps.processExit(0);
        return;
      }
      if (phase === 'idle') {
        void cleanup().then(() => {
          // app.quit (not app.exit): a bare exit skips Electron's own shutdown
          // sequence, which is what tears down its child processes (GPU /
          // renderer / utility helpers). A helper that outlives the main
          // process still holds the inherited single-instance socket, and the
          // next launch then dies as a silent second instance. The safety net
          // covers a quit that gets stuck.
          deps.appQuit();
          setTimer(() => deps.processExit(0), forceExitDelayMs);
        });
      } else if (phase === 'done') {
        deps.processExit(0); // already clean
      }
      // 'cleaning': a cleanup is already running and will terminate the
      // process (the before-quit follow-up or the first signal's exit).
    },
  };
}
