import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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

function parsePackageJson(text, label) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} package.json is invalid: ${message}`);
  }
}

function packageFingerprint(text, label) {
  const packageJson = parsePackageJson(text, label);
  if (packageJson === null) return null;
  const { version: _version, ...buildRelevantPackage } = packageJson;
  return JSON.stringify(buildRelevantPackage);
}

export function packageChangeAffectsBuild(beforeText, afterText) {
  const before = packageFingerprint(beforeText, 'Previous');
  const after = packageFingerprint(afterText, 'Current');
  if (before === null || after === null) return true;
  return before !== after;
}

export function classifyReleaseImpact(
  paths,
  beforePackageText = '',
  afterPackageText = '',
) {
  const impactedPaths = [];
  const uniquePaths = new Set(
    paths.map((path) => String(path).trim()).filter(Boolean),
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

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function packageAt(ref) {
  try {
    return git(['show', `${ref}:package.json`]);
  } catch {
    return '';
  }
}

function changedPaths(base, head) {
  return git(['diff', '--name-only', '-z', '--no-renames', base, head])
    .split('\0')
    .filter(Boolean);
}

export function classifyGitRange(base, head) {
  const paths = changedPaths(base, head);
  const packageChanged = paths.includes('package.json');
  return classifyReleaseImpact(
    paths,
    packageChanged ? packageAt(base) : '',
    packageChanged ? packageAt(head) : '',
  );
}

export function pendingReleaseImpact(base, head) {
  const commits = [];
  const candidateCommits = git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${base}..${head}`,
  ])
    .split(/\r?\n/u)
    .filter(Boolean);

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

function parseNullDelimitedPaths(filePath) {
  return readFileSync(filePath, 'utf8').split('\0').filter(Boolean);
}

function main(argv) {
  const [mode, first, second, third] = argv;

  if (mode === 'classify') {
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error(
        'Usage: release-impact-policy.mjs classify <paths-file> <before-package> <after-package>',
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
      throw new Error('Usage: release-impact-policy.mjs range <base> <head>');
    }
    return classifyGitRange(first, second);
  }

  if (mode === 'pending') {
    if (first === undefined || second === undefined) {
      throw new Error('Usage: release-impact-policy.mjs pending <base> <head>');
    }
    return pendingReleaseImpact(first, second);
  }

  throw new Error('Expected mode: classify, range, or pending');
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
