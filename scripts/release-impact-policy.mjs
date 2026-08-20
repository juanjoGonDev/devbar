import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const RELEASE_WORKFLOWS = new Set([
  '.github/workflows/release.yml',
  '.github/workflows/auto-release.workflow.yml',
]);

const ARTIFACT_EXACT_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  '.npmrc',
  'tsconfig.base.json',
  'tsconfig.node.json',
  'tsconfig.renderer.json',
  'scripts/build.sh',
  'scripts/package-macos-app.sh',
  'scripts/build-macos-release.sh',
  'scripts/verify-macos-release.sh',
]);

function changedContentLines(patch) {
  return String(patch ?? '')
    .split(/\r?\n/u)
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---')),
    )
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
}

export function isMechanicalActionsUpdate(patch) {
  const lines = changedContentLines(patch);
  return lines.length > 0 && lines.every((line) => /^uses:\s+\S+/u.test(line));
}

function isArtifactPath(path) {
  return (
    path.startsWith('src/') ||
    path.startsWith('renderer/') ||
    path.startsWith('assets/') ||
    (path.startsWith('scripts/') && path.endsWith('.ts')) ||
    ARTIFACT_EXACT_PATHS.has(path)
  );
}

export function isReleaseImpacting(paths, releaseWorkflowPatch = '') {
  const uniquePaths = new Set(paths.map((path) => String(path).trim()).filter(Boolean));

  for (const path of uniquePaths) {
    if (isArtifactPath(path)) return true;
  }

  const releaseWorkflowChanged = [...uniquePaths].some((path) =>
    RELEASE_WORKFLOWS.has(path),
  );
  if (!releaseWorkflowChanged) return false;

  return !isMechanicalActionsUpdate(releaseWorkflowPatch);
}

function parseNullDelimitedPaths(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean);
}

function main(argv) {
  const [pathsFile, releaseWorkflowPatchFile] = argv;
  if (!pathsFile || !releaseWorkflowPatchFile) {
    throw new Error(
      'Usage: release-impact-policy.mjs <nul-delimited-paths-file> <release-workflow-patch-file>',
    );
  }
  const impacting = isReleaseImpacting(
    parseNullDelimitedPaths(pathsFile),
    readFileSync(releaseWorkflowPatchFile, 'utf8'),
  );
  process.stdout.write(`${impacting}\n`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
