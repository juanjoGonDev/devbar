import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  verifyReleaseArtifactSet,
  type ReleasePlatform,
} from './release-artifacts.js';
import { isEntrypoint } from './lib/script-runtime.ts';

/**
 * Verify a built artifact set against the release contract.
 *
 * Usage: node --experimental-strip-types scripts/verify-release-artifacts.ts [dir] [version] [platform]
 *
 * The work lives in main() behind the entrypoint guard: importing this
 * module (tests) must not verify anything.
 */

const PLATFORMS: readonly ReleasePlatform[] = ['macos', 'win', 'linux'];

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

export interface VerifyRequest {
  directory: string;
  version: string;
  platform?: ReleasePlatform;
}

/**
 * CLI arguments, defaulted and validated. An unknown platform name is
 * rejected instead of being passed through: `verifyReleaseArtifactSet`
 * treats an undefined platform as "the full release", so a typo
 * (`windows`) must not quietly downgrade into a different check.
 */
export function resolveVerifyRequest(
  args: readonly (string | undefined)[],
  repoRoot: string,
  defaultVersion: string,
): VerifyRequest {
  const platformArg = args[2] as ReleasePlatform | undefined;
  if (platformArg !== undefined && !PLATFORMS.includes(platformArg))
    throw new Error(`Unknown platform: ${platformArg}`);
  const request: VerifyRequest = {
    directory: path.resolve(args[0] || path.join(repoRoot, 'dist', 'release')),
    version: args[1] || defaultVersion,
  };
  if (platformArg !== undefined) request.platform = platformArg;
  return request;
}

export async function verifyRequest(request: VerifyRequest): Promise<void> {
  const result = await verifyReleaseArtifactSet(request);
  process.stdout.write(
    `Verified ${result.artifactNames.length} release artifacts for v${result.version}${request.platform ? ` (${request.platform})` : ''} in ${result.directory}\n`,
  );
}

export async function main(
  args: readonly (string | undefined)[] = process.argv.slice(2),
): Promise<void> {
  await verifyRequest(
    resolveVerifyRequest(args, findRepoRoot(), packageJson.version),
  );
}

if (isEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
