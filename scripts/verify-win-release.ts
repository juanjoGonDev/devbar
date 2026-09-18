import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
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

const outputDirectory =
  process.argv[2] || path.join(ROOT, 'dist', 'electron-builder');
const version = process.argv[3] || packageJson.version;

/**
 * A real Windows PE executable: the two-byte MZ header AND the PE
 * signature at the offset the DOS header's e_lfanew field points to.
 * The bare MZ prefix alone would also accept a non-empty file that
 * happens to start with those bytes (e.g. a truncated or corrupted
 * arm64 artifact that never gets smoke-launched).
 */
function looksLikeWindowsExe(filePath: string): boolean {
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

async function main(): Promise<void> {
  // 1. Contract: exactly the expected win artifacts exist (non-empty).
  const result = await verifyReleaseArtifactSet({
    directory: outputDirectory,
    version,
    platform: 'win',
  });
  console.log(
    `Verified ${result.artifactNames.length} win artifacts for v${version} in ${result.directory}`,
  );

  // 2. Contents: every artifact (NSIS installer + portable) is a real PE
  //    executable, so an HTML error page or truncated download cannot ship.
  for (const name of result.artifactNames) {
    const filePath = path.join(outputDirectory, name);
    if (!looksLikeWindowsExe(filePath))
      throw new Error(`${name} is not a valid Windows executable`);
    console.log(`ok: ${name} (MZ header)`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
