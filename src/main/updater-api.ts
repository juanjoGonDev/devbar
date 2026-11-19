import type { ApplyUpdateResult } from './assisted-update.js';
import type { SimpleResult } from './update-actions.js';
import type { AvailableUpdate, StagedUpdate } from '../domain-types.js';
import type { UpdateStatus } from '../ipc-contract.js';

/** What the rest of the app may ask of the updater (built in updater.ts). */
export interface Updater {
  status: () => UpdateStatus;
  broadcastStatus: () => void;
  runUpdateCheck: (options?: { manual?: boolean }) => Promise<UpdateStatus>;
  applyUpdate: () => Promise<ApplyUpdateResult>;
  /**
   * applyUpdate for surfaces that cannot show the result themselves (tray
   * menu, banner button): failures and "your turn" steps become a banner
   * that opens the Updates pane. Never rejects.
   */
  applyUpdateAndReport: () => Promise<void>;
  copyInstallCommand: () => SimpleResult;
  showDownloadedFile: () => SimpleResult;
  /** Dev simulation: stage a locally built zip through the real code path. */
  stageFromZip: (zipPath: string, update: AvailableUpdate) => Promise<void>;
  pruneStagedUpdates: (keep: string) => void;
  installedBundleId: () => string | null;
  /** A staged update matching the release can be swapped in right now. */
  canInstallStaged: () => boolean;
  /** applyUpdate without the restart dialog, staged updates only. */
  installStagedHeadless: () => Promise<ApplyUpdateResult>;
  available: () => AvailableUpdate | null;
  staged: () => StagedUpdate | null;
  setSimulatedUpdate: (update: AvailableUpdate | null) => void;
}
