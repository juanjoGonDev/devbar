import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  expectedReleaseArtifactNames,
  writeSha256Manifest,
} from './release-artifacts.js';

/**
 * Write SHA256SUMS.txt for the FULL release set (all platforms) once every
 * platform's artifacts live in one directory. Used by the release publish
 * job; the per-platform build jobs deliberately produce no manifest.
 *
 * Usage: node --experimental-strip-types scripts/release-manifest.ts [dir] [version]
 */
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

const outputDirectory = path.resolve(
  process.argv[2] || path.join(ROOT, 'dist', 'release'),
);
const version = process.argv[3] || packageJson.version;
const artifactNames = expectedReleaseArtifactNames(version);

const manifestPath = await writeSha256Manifest(outputDirectory, artifactNames);
process.stdout.write(
  `Wrote ${manifestPath} (${artifactNames.length} artifacts for v${version})\n`,
);
