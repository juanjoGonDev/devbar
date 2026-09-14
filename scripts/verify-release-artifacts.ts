import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  verifyReleaseArtifactSet,
  type ReleasePlatform,
} from './release-artifacts.js';

const PLATFORMS: readonly ReleasePlatform[] = ['macos', 'win', 'linux'];

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

async function main(): Promise<void> {
  const rootDirectory = findRepoRoot();
  const outputDirectory = path.resolve(
    process.argv[2] || path.join(rootDirectory, 'dist', 'release'),
  );
  const version = process.argv[3] || packageJson.version;
  const platformArg = process.argv[4] as ReleasePlatform | undefined;
  if (platformArg !== undefined && !PLATFORMS.includes(platformArg)) {
    throw new Error(`Unknown platform: ${platformArg}`);
  }
  const options: {
    directory: string;
    version: string;
    platform?: ReleasePlatform;
  } = { directory: outputDirectory, version };
  if (platformArg !== undefined) options.platform = platformArg;
  const result = await verifyReleaseArtifactSet(options);
  process.stdout.write(
    `Verified ${result.artifactNames.length} release artifacts for v${result.version}${platformArg ? ` (${platformArg})` : ''} in ${result.directory}\n`,
  );
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
