'use strict';

const path = require('node:path');
const { packager } = require('@electron/packager');

const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);

async function main() {
  const [architecture, outputDirectory] = process.argv.slice(2);

  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported macOS architecture: ${architecture || '<missing>'}`);
  }
  if (!outputDirectory) {
    throw new Error('Output directory is required.');
  }

  const rootDirectory = path.resolve(__dirname, '..');
  await packager({
    dir: rootDirectory,
    name: 'DevBar',
    platform: 'darwin',
    arch: architecture,
    out: path.resolve(outputDirectory),
    overwrite: true,
    ignore: /^\/(?:dist|tests|\.agents|\.github)(?:$|\/)/,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
