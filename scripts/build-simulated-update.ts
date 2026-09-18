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
import { isEntrypoint } from './lib/script-runtime.ts';

/** How far up `findRepoRoot` is willing to look before giving up. */
export const REPO_ROOT_MAX_LEVELS = 8;

export const USAGE =
  'Usage: build-simulated-update.ts <bundle.app> <workDir> [version]';

/**
 * Locate the repository root from EITHER copy of this script: the TS
 * source (scripts/) or the compiled CI copy (build/scripts/). Walking up
 * until package.json + pnpm-lock.yaml meet is the only anchor that works
 * for both — `..` alone resolves to `build/` from the compiled copy, and
 * package.json alone matches any package directory on the way up.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < REPO_ROOT_MAX_LEVELS; i += 1) {
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

/** Bump the minor of a semver string (same rule as the dev panel). */
export function nextMinor(version: string): string {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  const [major = NaN, minor = NaN] = parts;
  if (parts.length !== 3 || Number.isNaN(major) || Number.isNaN(minor)) {
    return '99.0.0';
  }
  return `${major}.${minor + 1}.0`;
}

export interface SimulatedUpdateRequest {
  bundlePath: string;
  workDir: string;
  version: string;
}

export interface MainDeps {
  /** The full `process.argv`. */
  argv: string[];
  /** Repository root, used only to read the version out of package.json. */
  root: string;
  build: (request: SimulatedUpdateRequest) => Promise<string>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Returns the exit code the caller should adopt. */
export async function main(deps: MainDeps): Promise<number> {
  const { argv, root, build, log, error } = deps;
  const bundle = argv[2];
  const workDir = argv[3];
  if (!bundle || !workDir) {
    error(USAGE);
    return 1;
  }

  const explicitVersion = argv[4] ?? '';
  // Read package.json lazily: with an explicit version (always the case in
  // CI) there is nothing to look up, and the script stays usable even where
  // the root cannot be located.
  const version =
    explicitVersion.trim() !== ''
      ? explicitVersion
      : nextMinor(
          (
            JSON.parse(
              fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
            ) as {
              version?: string;
            }
          ).version ?? '',
        );

  const zipPath = await build({
    bundlePath: path.resolve(bundle),
    workDir: path.resolve(workDir),
    version,
  });
  log(zipPath);
  return 0;
}

// Direct execution: node build/scripts/build-simulated-update.js …
if (isEntrypoint(import.meta.url)) {
  const code = await main({
    argv: process.argv,
    root: findRepoRoot(path.dirname(fileURLToPath(import.meta.url))),
    build: buildSimulatedUpdate,
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  });
  if (code !== 0) process.exit(code);
}
