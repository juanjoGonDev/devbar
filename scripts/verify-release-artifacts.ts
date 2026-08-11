import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { verifyReleaseArtifactSet } from './release-artifacts.js';

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
  const result = await verifyReleaseArtifactSet({
    directory: outputDirectory,
    version,
  });
  process.stdout.write(
    `Verified ${result.artifactNames.length} release artifacts for v${result.version} in ${result.directory}\n`,
  );
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
