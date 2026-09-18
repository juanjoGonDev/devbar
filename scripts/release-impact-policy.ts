import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { isEntrypoint } from './lib/script-runtime.ts';

type JsonObject = Record<string, unknown>;

type Classification = {
  publish: boolean;
  paths: string[];
};

type PendingImpact = {
  publish: boolean;
  commitCount: number;
  commits: string[];
};

const RELEASE_PREFIXES = ['assets/', 'renderer/', 'src/'];

const RELEASE_EXACT_PATHS = new Set([
  '.npmrc',
  'scripts/build-macos-release.sh',
  'scripts/build.ts',
  // Shared by build.ts and the release verifiers; a change to it changes
  // whether those scripts run at all.
  'scripts/lib/script-runtime.ts',
  'scripts/package-electron.ts',
  'scripts/package-macos-app.sh',
  'scripts/package-win-linux.ts',
  'scripts/platform.ts',
  // The published artifact names / checksum contract and the SHA256SUMS.txt
  // manifest generator: a change to either is a change to what gets
  // published, so it must count as release-impacting.
  'scripts/release-artifacts.ts',
  'scripts/release-manifest.ts',
  'tsconfig.node.json',
  'tsconfig.renderer.json',
]);

// Dev dependencies that never reach the packaged app: bumping them must not
// trigger a release. Everything else in devDependencies (electron, esbuild,
// @electron/packager, typescript) is packaged or shapes the built output, so a
// dev dependency added later counts until it is listed here.
const NON_SHIPPING_DEV_DEPENDENCIES = [
  '@types/',
  // The whole @vitest scope is test tooling (coverage provider, ESLint
  // plugin). Listing bare 'vitest' does not cover it: the prefix match is on
  // the raw name, and '@vitest/coverage-v8' starts with '@', not 'vitest'.
  '@vitest/',
  'dependency-cruiser',
  'eslint',
  'jiti',
  // The DOM the renderer tests run in. Node is the default environment; only
  // the jsdom-tagged test files ask for it, and none of it is packaged.
  'jsdom',
  'knip',
  'lefthook',
  'prettier',
  'typescript-eslint',
  'vitest',
];

function shipsInBuild(dependency: string): boolean {
  return !NON_SHIPPING_DEV_DEPENDENCIES.some(
    (name) => dependency === name || dependency.startsWith(name),
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePackageJson(text: string, label: string): JsonObject | null {
  if (!text) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      throw new Error('root value must be an object');
    }
    return parsed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} package.json is invalid: ${message}`);
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (!isJsonObject(value)) return value;

  const canonical: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalizeJson(value[key]);
  }
  return canonical;
}

function packageFingerprint(text: string, label: string): string | null {
  const packageJson = parsePackageJson(text, label);
  if (packageJson === null) return null;

  const buildRelevantPackage: JsonObject = { ...packageJson };
  delete buildRelevantPackage.version;

  const devDependencies = buildRelevantPackage.devDependencies;
  if (isJsonObject(devDependencies)) {
    buildRelevantPackage.devDependencies = Object.fromEntries(
      Object.entries(devDependencies).filter(([name]) => shipsInBuild(name)),
    );
  }

  return JSON.stringify(canonicalizeJson(buildRelevantPackage));
}

export function packageChangeAffectsBuild(
  beforeText: string,
  afterText: string,
): boolean {
  const before = packageFingerprint(beforeText, 'Previous');
  const after = packageFingerprint(afterText, 'Current');
  if (before === null || after === null) return true;
  return before !== after;
}

export function classifyReleaseImpact(
  paths: readonly string[],
  beforePackageText = '',
  afterPackageText = '',
): Classification {
  const impactedPaths: string[] = [];
  const uniquePaths = new Set(
    paths.map((path) => path.trim()).filter((path) => path.length > 0),
  );
  const packageAffectsBuild =
    uniquePaths.has('package.json') &&
    packageChangeAffectsBuild(beforePackageText, afterPackageText);

  for (const path of uniquePaths) {
    if (path === 'package.json') {
      if (packageAffectsBuild) impactedPaths.push(path);
      continue;
    }

    // ponytail: the lockfile alone proves nothing about the app — it moves for
    // tooling bumps too. It counts only alongside a build-relevant manifest
    // change, so a transitive-only bump of a production dependency is missed;
    // classify it by production dependency tree if that ever shows up.
    if (path === 'pnpm-lock.yaml') {
      if (packageAffectsBuild) impactedPaths.push(path);
      continue;
    }

    if (
      RELEASE_EXACT_PATHS.has(path) ||
      RELEASE_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      impactedPaths.push(path);
    }
  }

  return {
    publish: impactedPaths.length > 0,
    paths: impactedPaths.sort(),
  };
}

/**
 * `repository` is the checkout the query runs against. The CLI leaves it
 * undefined so git inherits the process working directory (what the
 * workflows rely on); tests pass a throwaway repository instead of
 * changing the process-wide cwd.
 */
function git(args: readonly string[], repository?: string): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function packageAt(ref: string, repository?: string): string {
  try {
    return git(['show', `${ref}:package.json`], repository);
  } catch {
    return '';
  }
}

function changedPaths(
  base: string,
  head: string,
  repository?: string,
): string[] {
  return git(
    ['diff', '--name-only', '-z', '--no-renames', base, head],
    repository,
  )
    .split('\0')
    .filter((path) => path.length > 0);
}

export function classifyGitRange(
  base: string,
  head: string,
  repository?: string,
): Classification {
  const paths = changedPaths(base, head, repository);
  const packageChanged = paths.includes('package.json');
  return classifyReleaseImpact(
    paths,
    packageChanged ? packageAt(base, repository) : '',
    packageChanged ? packageAt(head, repository) : '',
  );
}

export function pendingReleaseImpact(
  base: string,
  head: string,
  repository?: string,
): PendingImpact {
  const commits: string[] = [];
  const candidateCommits = git(
    ['rev-list', '--first-parent', '--reverse', `${base}..${head}`],
    repository,
  )
    .split(/\r?\n/u)
    .filter((sha) => sha.length > 0);

  for (const sha of candidateCommits) {
    const parent = git(['rev-parse', `${sha}^1`], repository).trim();
    if (classifyGitRange(parent, sha, repository).publish) commits.push(sha);
  }

  return {
    publish: commits.length > 0,
    commitCount: commits.length,
    commits,
  };
}

function parseNullDelimitedPaths(filePath: string): string[] {
  return readFileSync(filePath, 'utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

export function main(
  argv: readonly string[],
  repository?: string,
): Classification | PendingImpact {
  const [mode, first, second, third] = argv;

  if (mode === 'classify') {
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error(
        'Usage: release-impact-policy.ts classify <paths-file> <before-package> <after-package>',
      );
    }
    return classifyReleaseImpact(
      parseNullDelimitedPaths(first),
      readFileSync(second, 'utf8'),
      readFileSync(third, 'utf8'),
    );
  }

  if (mode === 'range') {
    if (first === undefined || second === undefined) {
      throw new Error('Usage: release-impact-policy.ts range <base> <head>');
    }
    return classifyGitRange(first, second, repository);
  }

  if (mode === 'pending') {
    if (first === undefined || second === undefined) {
      throw new Error('Usage: release-impact-policy.ts pending <base> <head>');
    }
    return pendingReleaseImpact(first, second, repository);
  }

  throw new Error('Expected mode: classify, range, or pending');
}

// Entrypoint guard via the shared helper: both sides are realpath-resolved
// there, so a checkout reached through a symlink still runs main(). The
// raw `import.meta.url === pathToFileURL(process.argv[1]).href` comparison
// this replaces was FALSE in that case, and the release workflows then read
// an empty stdout and mis-classified the release impact.
if (isEntrypoint(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
