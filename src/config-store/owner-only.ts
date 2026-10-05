import fs from 'node:fs';

/**
 * The config file holds «Control remoto»'s identity seed as it is
 * (src/main/remote/identity.ts), so it stays readable and writable by its
 * user only — 0600, the way a key in ~/.ssh is kept.
 *
 * conf writes the file with that mode (`configFileMode` in store.ts) every
 * time it writes it; `restrictToOwner` tightens a file an earlier version
 * left readable by everyone, which conf would only rewrite once something
 * changes.
 */

export const OWNER_ONLY = 0o600;

export function restrictToOwner(
  file: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // POSIX modes do not apply on Windows: the ACLs of the user's AppData
  // already keep other accounts out.
  if (platform === 'win32') return;
  try {
    fs.chmodSync(file, OWNER_ONLY);
  } catch (error) {
    console.error(
      `[config-store] could not make ${file} readable by its user only:`,
      error,
    );
  }
}
