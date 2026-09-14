import { openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { verifyReleaseArtifactSet } from './release-artifacts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory =
  process.argv[2] || path.join(ROOT, 'dist', 'electron-builder');
const version = process.argv[3] || packageJson.version;

/** The two-byte MZ header every Windows PE file carries. */
function looksLikeWindowsExe(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    if (readSync(fd, buf, 0, 2, 0) < 2) return false;
    return buf.toString('latin1') === 'MZ';
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  // 1. Contract: exactly the expected win artifacts exist (non-empty).
  const result = await verifyReleaseArtifactSet({
    directory: outputDirectory,
    version,
    platform: 'win',
  });
  console.log(
    `Verified ${result.artifactNames.length} win artifacts for v${version} in ${result.directory}`,
  );

  // 2. Contents: every artifact (NSIS installer + portable) is a real PE
  //    executable, so an HTML error page or truncated download cannot ship.
  for (const name of result.artifactNames) {
    const filePath = path.join(outputDirectory, name);
    if (!looksLikeWindowsExe(filePath))
      throw new Error(`${name} is not a valid Windows executable`);
    console.log(`ok: ${name} (MZ header)`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
