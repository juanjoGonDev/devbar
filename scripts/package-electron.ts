import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64'] as const);
type Architecture = 'arm64' | 'x64';

async function main(): Promise<void> {
  const [architectureValue, outputDirectory] = process.argv.slice(2);
  if (!SUPPORTED_ARCHITECTURES.has(architectureValue as Architecture)) {
    throw new Error(
      `Unsupported macOS architecture: ${architectureValue || '<missing>'}`,
    );
  }
  if (!outputDirectory) throw new Error('Output directory is required.');
  const architecture = architectureValue as Architecture;
  const rootDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  await packager({
    dir: rootDirectory,
    name: 'DevBar',
    platform: 'darwin',
    arch: architecture,
    out: path.resolve(outputDirectory),
    overwrite: true,
    ignore:
      /^\/(?:dist|tests|\.agents|\.github|src|renderer|scripts|tsconfig(?:\.[^.]+)?\.json|eslint\.config\.ts|vitest\.config\.ts|knip\.json|\.dependency-cruiser\.json)(?:$|\/)/,
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
