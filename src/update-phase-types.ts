/**
 * The update state machine, as one discriminated union shared by the main
 * process (which drives it, see src/main/update-phase.ts) and every window
 * (which renders it). Types only; re-exported by ipc-contract.ts.
 */

/**
 * How a downloaded update gets installed: `restart` swaps a staged copy in,
 * `package` runs the system package manager for the user (.deb installs),
 * `manual` leaves the file for the user with instructions.
 */
type UpdateInstallRoute = 'restart' | 'package' | 'manual';

/**
 * Where the update flow is RIGHT NOW — the single state machine every pane
 * renders. Failures carry their reason; the download-bound states carry the
 * file they produced so the UI can point at it.
 */
export type UpdatePhase =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'check-failed'; reason: string }
  | { state: 'available'; version: string }
  | {
      state: 'downloading';
      version: string;
      received: number;
      total: number | null;
    }
  | { state: 'download-failed'; version: string; reason: string }
  | { state: 'verifying'; version: string }
  | { state: 'verify-failed'; version: string; reason: string }
  | {
      state: 'ready-to-install';
      version: string;
      path: string;
      install: UpdateInstallRoute;
      /** Exact shell command for a manual install, when there is one. */
      command: string | null;
    }
  | { state: 'installing'; version: string }
  | {
      state: 'install-failed';
      version: string;
      reason: string;
      path: string;
      command: string | null;
    }
  | { state: 'restarting'; version: string };
