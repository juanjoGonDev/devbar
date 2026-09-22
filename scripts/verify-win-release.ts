import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { isEntrypoint } from './lib/script-runtime.ts';
import { verifyReleaseArtifactSet } from './release-artifacts.js';

/**
 * Repo root, independent of how this script is invoked: from source
 * (scripts/) or compiled (build/scripts/). The root is the only directory
 * level that carries pnpm-lock.yaml (the tsc-emitted build/package.json
 * would be a false anchor).
 */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('repository root not found');
    dir = parent;
  }
}

const ROOT = findRepoRoot();

/**
 * CLI defaults, read once at load exactly as before. `main` takes them as
 * parameters so a test can point the verification at a fixture directory
 * without rewriting process.argv.
 */
const DEFAULT_OUTPUT_DIRECTORY =
  process.argv[2] || path.join(ROOT, 'dist', 'electron-builder');
const DEFAULT_VERSION = process.argv[3] || packageJson.version;

/**
 * A real Windows PE executable: the two-byte MZ header AND the PE
 * signature at the offset the DOS header's e_lfanew field points to.
 * The bare MZ prefix alone would also accept a non-empty file that
 * happens to start with those bytes (e.g. a truncated or corrupted
 * arm64 artifact that never gets smoke-launched).
 *
 * No COFF `Machine` gate: both win targets are NSIS stubs, PE32 0x14c for
 * every target arch — the payload architecture is in the compressed data.
 */
export function looksLikeWindowsExe(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(fd, dosHeader, 0, dosHeader.length, 0) < dosHeader.length)
      return false;
    if (dosHeader.toString('latin1', 0, 2) !== 'MZ') return false;

    // e_lfanew — byte offset of the PE signature — is the last field of
    // the 64-byte DOS header. A garbage offset reads past EOF (0 bytes)
    // or points at wrong bytes, both of which fail the check below.
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const signature = Buffer.alloc(4);
    return (
      readSync(fd, signature, 0, signature.length, peOffset) ===
        signature.length && signature.equals(Buffer.from('PE\0\0', 'latin1'))
    );
  } finally {
    closeSync(fd);
  }
}

export async function main({
  directory = DEFAULT_OUTPUT_DIRECTORY,
  version = DEFAULT_VERSION,
}: { directory?: string; version?: string } = {}): Promise<void> {
  // 1. Contract: exactly the expected win artifacts exist (non-empty).
  const result = await verifyReleaseArtifactSet({
    directory,
    version,
    platform: 'win',
  });
  console.log(
    `Verified ${result.artifactNames.length} win artifacts for v${version} in ${result.directory}`,
  );

  // 2. Contents: every artifact (NSIS installer + portable) is a real PE
  //    executable, so an HTML error page or truncated download cannot ship.
  for (const name of result.artifactNames) {
    const filePath = path.join(directory, name);
    if (!looksLikeWindowsExe(filePath))
      throw new Error(`${name} is not a valid Windows executable`);
    console.log(`ok: ${name} (MZ header)`);
  }
}

// Entrypoint guard so the checks stay importable from tests (same
// pattern as verify-linux-release.ts / package-electron.ts).
if (isEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // On CI, mirror the failure into the job annotations: the Checks UI
    // shows it without opening logs, and it is readable via the
    // check-runs annotations API.
    if (process.env.GITHUB_ACTIONS) console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
