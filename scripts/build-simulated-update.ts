/**
 * CI helper (macOS): build the simulated next-version update zip the same
 * way the dev panel's "real update" simulation does — a genuine copy of the
 * installed bundle with its version bumped and its ad-hoc seal remade. Only
 * the transfer is simulated; staging, verification and the swap all run the
 * production path.
 *
 * Usage (CI runs the compiled copy — it imports local TS modules, which raw
 * --experimental-strip-types cannot resolve):
 *   node build/scripts/build-simulated-update.js <bundle.app> <workDir> [version]
 * Prints the zip path on the last line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSimulatedUpdate } from '../src/dev/simulate-update.js';

const bundle = process.argv[2];
const workDir = process.argv[3];
if (!bundle || !workDir) {
  console.error(
    'Usage: build-simulated-update.ts <bundle.app> <workDir> [version]',
  );
  process.exit(1);
}

/**
 * Locate the repository root from EITHER copy of this script: the TS
 * source (scripts/) or the compiled CI copy (build/scripts/). Walking up
 * until package.json + pnpm-lock.yaml meet is the only anchor that works
 * for both — `..` alone resolves to `build/` from the compiled copy.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))
    )
      return path.resolve(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(dir);
}

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Bump the minor of a semver string (same rule as the dev panel). */
function nextMinor(version: string): string {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  const [major = NaN, minor = NaN] = parts;
  if (parts.length !== 3 || Number.isNaN(major) || Number.isNaN(minor)) {
    return '99.0.0';
  }
  return `${major}.${minor + 1}.0`;
}

const explicitVersion = process.argv[4] ?? '';
// Read package.json lazily: with an explicit version (always the case in
// CI) there is nothing to look up, and the script stays usable even where
// the root cannot be located.
const version =
  explicitVersion.trim() !== ''
    ? explicitVersion
    : nextMinor(
        (
          JSON.parse(
            fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
          ) as {
            version?: string;
          }
        ).version ?? '',
      );

const zipPath = await buildSimulatedUpdate({
  bundlePath: path.resolve(bundle),
  workDir: path.resolve(workDir),
  version,
});
console.log(zipPath);
