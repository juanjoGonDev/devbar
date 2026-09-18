import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** COFF Machine field values (IMAGE_FILE_MACHINE_*). */
export const PE_MACHINE: Record<'x64' | 'arm64', number> = {
  x64: 0x8664, // IMAGE_FILE_MACHINE_AMD64
  arm64: 0xaa64, // IMAGE_FILE_MACHINE_ARM64
};

/**
 * A real Windows PE executable of the expected architecture: the two-byte
 * MZ header, the PE signature at the offset the DOS header's e_lfanew
 * field points to, and the COFF Machine field (first two bytes after the
 * signature) matching `expectedMachine`. The MZ + PE-signature checks
 * alone would accept a VALID exe of the WRONG architecture (an x64 file
 * shipped as the arm64 artifact) — and that artifact never gets
 * smoke-launched on the other arch, so nothing else would catch it.
 */
export function looksLikeWindowsExe(
  filePath: string,
  expectedMachine: number,
): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(fd, dosHeader, 0, dosHeader.length, 0) < dosHeader.length)
      return false;
    if (dosHeader.toString('latin1', 0, 2) !== 'MZ') return false;

    // e_lfanew — byte offset of the PE signature — is the last field of
    // the 64-byte DOS header. A garbage offset reads past EOF (0 bytes)
    // or points at wrong bytes, both of which fail the check below.
    // Six bytes: the 4-byte PE signature + the 2-byte Machine field.
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (readSync(fd, peHeader, 0, peHeader.length, peOffset) !== 6)
      return false;
    if (!peHeader.subarray(0, 4).equals(Buffer.from('PE\0\0', 'latin1')))
      return false;
    return peHeader.readUInt16LE(4) === expectedMachine;
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
  //    executable of the architecture its name carries, so an HTML error
  //    page, a truncated download, or an x64 file shipped as arm64 cannot
  //    ship.
  for (const name of result.artifactNames) {
    const arch = /-win-(x64|arm64)-/.exec(name)?.[1] as
      'x64' | 'arm64' | undefined;
    if (!arch) throw new Error(`cannot determine architecture from ${name}`);
    const filePath = path.join(outputDirectory, name);
    if (!looksLikeWindowsExe(filePath, PE_MACHINE[arch]))
      throw new Error(`${name} is not a valid ${arch} Windows executable`);
    console.log(`ok: ${name} (PE ${arch})`);
  }
}

// Entrypoint guard so the checks stay importable from tests (same
// pattern as verify-linux-release.ts / package-electron.ts).
const entrypointPath = process.argv[1];
const isEntrypoint =
  entrypointPath !== undefined &&
  import.meta.url === pathToFileURL(entrypointPath).href;

if (isEntrypoint) {
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
