import { execFileSync } from 'node:child_process';
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
 * AppImageSpec structure, not just the marker: "AI" + type byte at
 * offset 8 PLUS the container the spec mandates for that type —
 *  - type 2 (0x414902, what electron-builder produces): MUST be a valid
 *    ELF executable (the marker lives in the ELF ident padding), so the
 *    ELF magic `\x7fELF` at offset 0 is required;
 *  - type 1 (0x414901): an ISO 9660 image — its primary volume
 *    descriptor sits in sector 16 (2048-byte sectors) and carries the
 *    "CD001" signature at offset 1 of that sector.
 * The marker alone would accept a 16-byte marker-only blob, which could
 * then ride along as a published arm64/armv7 artifact (only the x64
 * image is launched in CI). The remaining ident padding is zeroes, so
 * the legacy "AppImage" string check is checking the wrong convention.
 */
function looksLikeAppImage(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const magic = Buffer.alloc(3);
    if (readSync(fd, magic, 0, 3, 8) < 3) return false;
    if (magic[0] !== 0x41 || magic[1] !== 0x49) return false;
    if (magic[2] === 0x02) {
      const elf = Buffer.alloc(4);
      if (readSync(fd, elf, 0, 4, 0) < 4) return false;
      return elf.toString('latin1') === '\x7fELF';
    }
    if (magic[2] !== 0x01) return false;
    const pvd = Buffer.alloc(5);
    if (readSync(fd, pvd, 0, 5, 32769) < 5) return false;
    return pvd.toString('latin1') === 'CD001';
  } finally {
    closeSync(fd);
  }
}

function dpkgDebAvailable(): boolean {
  try {
    execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 1. Contract: exactly the expected linux artifacts exist (non-empty),
  //    and any manifest present is consistent.
  const result = await verifyReleaseArtifactSet({
    directory: outputDirectory,
    version,
    platform: 'linux',
  });
  console.log(
    `Verified ${result.artifactNames.length} linux artifacts for v${version} in ${result.directory}`,
  );

  // 2. Contents: AppImage magic on every AppImage.
  for (const name of result.artifactNames) {
    if (!name.endsWith('.AppImage')) continue;
    const filePath = path.join(outputDirectory, name);
    if (!looksLikeAppImage(filePath))
      throw new Error(
        `${name} is not a valid AppImage (marker or container structure missing)`,
      );
    console.log(`ok: ${name} (AppImage magic)`);
  }

  // 3. Contents: dpkg structure on every .deb when dpkg-deb is available
  //    (ubuntu runners have it; elsewhere the check is skipped with a
  //    warning — presence + checksums are still verified above).
  const debNames = result.artifactNames.filter((name) => name.endsWith('.deb'));
  if (dpkgDebAvailable()) {
    for (const name of debNames) {
      const filePath = path.join(outputDirectory, name);
      const contents = execFileSync('dpkg-deb', ['-c', filePath], {
        encoding: 'utf8',
      });
      if (
        !/\/usr\/share\/applications\/[A-Za-z0-9._-]+\.desktop/.test(contents)
      )
        throw new Error(`${name} is missing its .desktop entry`);
      if (!/usr\/share\/icons\/hicolor\/256x256\/apps\//.test(contents)) {
        // Dump whatever icon entries DO exist so the CI log explains the
        // failure (size set wrong? different path? no icons at all?).
        const iconLines = contents
          .split('\n')
          .filter((line) => line.includes('/icons/'))
          .map((line) => line.trim())
          .join('\n    ');
        throw new Error(
          `${name} is missing its 256px icon.\n    Icon entries found in the deb:\n    ${iconLines || '(none)'}`,
        );
      }
      console.log(`ok: ${name} (dpkg -c: desktop entry + icon present)`);
    }
  } else {
    for (const name of debNames)
      console.log(`skip: ${name} (dpkg-deb no disponible en este host)`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
