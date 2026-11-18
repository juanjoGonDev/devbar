import path from 'node:path';
import { errorMessage } from './ipc-validators.js';

/** The slice of the file system pruning needs (the updater's own fake). */
interface PruneFs {
  readdirSync: (dir: string) => string[];
  isDirectory: (target: string) => boolean;
  rmSync: (
    target: string,
    options: { recursive?: boolean; force: boolean },
  ) => void;
}

/**
 * Drop every staged version under `updatesDir` but the ones still in use —
 * each one is a full copy of the app. Housekeeping: a failure is logged,
 * never thrown, so it cannot mark a good download as failed.
 */
export function pruneStagedVersions(
  fs: PruneFs,
  updatesDir: string,
  keep: ReadonlyArray<string | null>,
): void {
  try {
    for (const entry of fs.readdirSync(updatesDir)) {
      if (keep.includes(entry)) continue;
      const candidate = path.join(updatesDir, entry);
      if (!fs.isDirectory(candidate)) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[updates] no se pudo limpiar: ${errorMessage(err)}`);
  }
}
