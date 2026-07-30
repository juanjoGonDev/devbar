'use strict';

const path = require('node:path');
const packageJson = require('../package.json');
const { verifyReleaseArtifactSet } = require('./release-artifacts');

async function main() {
  const rootDirectory = path.resolve(__dirname, '..');
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
