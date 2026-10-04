import type { UpdatePhase } from '../ipc-contract.js';

/**
 * The single holder of the update state machine (see `UpdatePhase`). Every
 * transition is pushed to the renderers, and every failure is logged here —
 * one place, one `[updates]` prefix — so the reason always reaches app.log
 * (the logger tees console) whichever step failed.
 */

export interface PhaseStore {
  get: () => UpdatePhase;
  set: (next: UpdatePhase) => void;
}

const FAILURES = new Set<UpdatePhase['state']>([
  'check-failed',
  'download-failed',
  'verify-failed',
  'install-failed',
]);

export function createPhaseStore(
  push: (phase: UpdatePhase) => void,
): PhaseStore {
  let current: UpdatePhase = { state: 'idle' };
  return {
    get: () => current,
    set(next) {
      current = next;
      if (isFailurePhase(next) && 'reason' in next) {
        const version = phaseVersion(next);
        console.error(
          `[updates] ${next.state}${version ? ` v${version}` : ''}: ${next.reason}`,
        );
      }
      push(next);
    },
  };
}

export function isFailurePhase(phase: UpdatePhase): boolean {
  return FAILURES.has(phase.state);
}

/** Phases a new check may replace: nothing the user still has to act on. */
export function isSettledPhase(phase: UpdatePhase): boolean {
  return (
    phase.state === 'idle' ||
    phase.state === 'checking' ||
    phase.state === 'check-failed' ||
    phase.state === 'available'
  );
}

/** Something is running: a second apply must not start a parallel one. */
export function isBusyPhase(phase: UpdatePhase): boolean {
  return (
    phase.state === 'downloading' ||
    phase.state === 'verifying' ||
    phase.state === 'installing' ||
    phase.state === 'restarting'
  );
}

export function phaseVersion(phase: UpdatePhase): string | null {
  return 'version' in phase ? phase.version : null;
}
