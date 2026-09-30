import type { AvailableUpdate, StagedUpdate } from '../domain-types.js';
import type { UpdatePhase } from '../update-phase-types.js';
import type { SimpleResult } from './simple-result.js';

export interface UpdateStatus {
  available: AvailableUpdate | null;
  /** Downloaded and unpacked — applying it is just a restart. */
  staged: StagedUpdate | null;
  lastCheckAt: string | null;
  currentVersion: string;
  phase: UpdatePhase;
}

/** The self-update calls of the window API (part of `DevBarApi`). */
export interface UpdatesApi {
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  applyUpdate(): Promise<Record<string, unknown>>;
  onUpdateStatus(callback: (payload: UpdateStatus) => void): () => void;
  /** Live phase pushes, download progress included. */
  onUpdatePhase(callback: (phase: UpdatePhase) => void): () => void;
  /** Copies the manual-install command of the current phase. */
  copyUpdateCommand(): Promise<SimpleResult>;
  /** Reveals the downloaded update file in the file manager. */
  showUpdateDownload(): Promise<SimpleResult>;
}
