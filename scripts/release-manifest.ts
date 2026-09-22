import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  expectedReleaseArtifactNames,
  writeSha256Manifest,
} from './release-artifacts.js';
import { isEntrypoint } from './lib/script-runtime.ts';

/**
 * Write SHA256SUMS.txt for the FULL release set (all platforms) once every
 * platform's artifacts live in one directory. Used by the release publish
 * job; the per-platform build jobs deliberately produce no manifest.
 *
 * Usage: node --experimental-strip-types scripts/release-manifest.ts [dir] [version]
 *
 * The work lives in main() behind the entrypoint guard: importing this
 * module (tests) must not write anything.
 */

/**
 * Repo root, independent of how this script is invoked: from source
 * (scripts/) or compiled (build/scripts/). The root is the only directory
 * level that carries pnpm-lock.yaml (the tsc-emitted build/package.json
 * would be a false anchor).
 */
export function findRepoRoot(
  startDirectory: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = startDirectory;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('repository root not found');
    dir = parent;
  }
}

export interface ManifestRequest {
  directory: string;
  version: string;
}

/**
 * CLI arguments, defaulted: the release directory the publish job assembles
 * and the version in package.json.
 */
export function resolveManifestRequest(
  args: readonly (string | undefined)[],
  repoRoot: string,
  defaultVersion: string,
): ManifestRequest {
  return {
    directory: path.resolve(args[0] || path.join(repoRoot, 'dist', 'release')),
    version: args[1] || defaultVersion,
  };
}

/** Hash the full contract's artifacts into SHA256SUMS.txt. */
export async function writeReleaseManifest({
  directory,
  version,
}: ManifestRequest): Promise<string> {
  const artifactNames = expectedReleaseArtifactNames(version);
  const manifestPath = await writeSha256Manifest(directory, artifactNames);
  process.stdout.write(
    `Wrote ${manifestPath} (${artifactNames.length} artifacts for v${version})\n`,
  );
  return manifestPath;
}

export async function main(
  args: readonly (string | undefined)[] = process.argv.slice(2),
): Promise<string> {
  return writeReleaseManifest(
    resolveManifestRequest(args, findRepoRoot(), packageJson.version),
  );
}

if (isEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
