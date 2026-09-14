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
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.resolve(
  process.argv[2] || path.join(ROOT, 'dist', 'release'),
);
const version = process.argv[3] || packageJson.version;
const artifactNames = expectedReleaseArtifactNames(version);

const manifestPath = await writeSha256Manifest(outputDirectory, artifactNames);
process.stdout.write(
  `Wrote ${manifestPath} (${artifactNames.length} artifacts for v${version})\n`,
);
