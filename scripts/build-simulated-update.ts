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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = process.argv[2];
const workDir = process.argv[3];
if (!bundle || !workDir) {
  console.error(
    'Usage: build-simulated-update.ts <bundle.app> <workDir> [version]',
  );
  process.exit(1);
}

/** Bump the minor of a semver string (same rule as the dev panel). */
function nextMinor(version: string): string {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  const [major = NaN, minor = NaN] = parts;
  if (parts.length !== 3 || Number.isNaN(major) || Number.isNaN(minor)) {
    return '99.0.0';
  }
  return `${major}.${minor + 1}.0`;
}

const current =
  (
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    }
  ).version ?? '';
const version = process.argv[4] || nextMinor(current);

const zipPath = await buildSimulatedUpdate({
  bundlePath: path.resolve(bundle),
  workDir: path.resolve(workDir),
  version,
});
console.log(zipPath);
