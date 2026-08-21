import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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
  'pnpm-lock.yaml',
  'scripts/build-macos-release.sh',
  'scripts/build.sh',
  'scripts/package-electron.ts',
  'scripts/package-macos-app.sh',
  'tsconfig.node.json',
  'tsconfig.renderer.json',
]);

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

  for (const path of uniquePaths) {
    if (path === 'package.json') {
      if (packageChangeAffectsBuild(beforePackageText, afterPackageText)) {
        impactedPaths.push(path);
      }
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

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function packageAt(ref: string): string {
  try {
    return git(['show', `${ref}:package.json`]);
  } catch {
    return '';
  }
}

function changedPaths(base: string, head: string): string[] {
  return git(['diff', '--name-only', '-z', '--no-renames', base, head])
    .split('\0')
    .filter((path) => path.length > 0);
}

export function classifyGitRange(base: string, head: string): Classification {
  const paths = changedPaths(base, head);
  const packageChanged = paths.includes('package.json');
  return classifyReleaseImpact(
    paths,
    packageChanged ? packageAt(base) : '',
    packageChanged ? packageAt(head) : '',
  );
}

export function pendingReleaseImpact(
  base: string,
  head: string,
): PendingImpact {
  const commits: string[] = [];
  const candidateCommits = git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${base}..${head}`,
  ])
    .split(/\r?\n/u)
    .filter((sha) => sha.length > 0);

  for (const sha of candidateCommits) {
    const parent = git(['rev-parse', `${sha}^1`]).trim();
    if (classifyGitRange(parent, sha).publish) commits.push(sha);
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

function main(argv: readonly string[]): Classification | PendingImpact {
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
    return classifyGitRange(first, second);
  }

  if (mode === 'pending') {
    if (first === undefined || second === undefined) {
      throw new Error('Usage: release-impact-policy.ts pending <base> <head>');
    }
    return pendingReleaseImpact(first, second);
  }

  throw new Error('Expected mode: classify, range, or pending');
}

const entrypointPath = process.argv[1];
const isEntrypoint =
  entrypointPath !== undefined &&
  import.meta.url === pathToFileURL(entrypointPath).href;

if (isEntrypoint) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
