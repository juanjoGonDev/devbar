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

/** AppImage runtime magic: "AppImage" at byte offset 8. */
function looksLikeAppImage(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8);
    if (readSync(fd, buf, 0, 8, 8) < 8) return false;
    return buf.toString('latin1') === 'AppImage';
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
      throw new Error(`${name} is not a valid AppImage (magic missing)`);
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
      if (!/usr\/share\/icons\/hicolor\/256x256\/apps\//.test(contents))
        throw new Error(`${name} is missing its 256px icon`);
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
