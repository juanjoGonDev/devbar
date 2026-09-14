import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  verifyReleaseArtifactSet,
  type ReleasePlatform,
} from './release-artifacts.js';

const PLATFORMS: readonly ReleasePlatform[] = ['macos', 'win', 'linux'];

async function main(): Promise<void> {
  const rootDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
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
