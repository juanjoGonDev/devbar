import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const policyPath = resolve(process.cwd(), 'scripts/release-impact-policy.mjs');
const temporaryDirectories: string[] = [];

function classify(paths: string[], releaseWorkflowPatch = ''): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'devbar-release-impact-'));
  temporaryDirectories.push(directory);
  const pathsFile = join(directory, 'paths.bin');
  const patchFile = join(directory, 'release.patch');
  writeFileSync(pathsFile, `${paths.join('\0')}\0`, 'utf8');
  writeFileSync(patchFile, releaseWorkflowPatch, 'utf8');

  const result = spawnSync(process.execPath, [policyPath, pathsFile, patchFile], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Release impact policy failed');
  }
  return result.stdout.trim() === 'true';
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release impact policy', () => {
  it.each([
    'src/main.ts',
    'src/preload.ts',
    'renderer/index.ts',
    'renderer/index.css',
    'renderer/index.html',
    'assets/icon.icns',
    'package.json',
    'pnpm-lock.yaml',
    '.npmrc',
    'tsconfig.base.json',
    'tsconfig.node.json',
    'tsconfig.renderer.json',
    'scripts/build.sh',
    'scripts/package-electron.ts',
    'scripts/release-artifacts.ts',
    'scripts/verify-release-artifacts.ts',
    'scripts/package-macos-app.sh',
    'scripts/build-macos-release.sh',
    'scripts/verify-macos-release.sh',
  ])('counts artifact input %s', (path) => {
    expect(classify([path])).toBe(true);
  });

  it.each([
    'README.md',
    'CHANGELOG.md',
    '.agents/specs/example.md',
    'tests/groups-model.test.ts',
    '.github/workflows/ci.yml',
    '.github/workflows/codeql.yml',
    'eslint.config.ts',
    'knip.json',
    'tsconfig.tests.json',
  ])('ignores non-artifact maintenance path %s', (path) => {
    expect(classify([path])).toBe(false);
  });

  it('skips mechanical Actions updates in release workflows', () => {
    const patch = `--- a/.github/workflows/release.yml\n+++ b/.github/workflows/release.yml\n@@ -1 +1 @@\n-        uses: actions/setup-node@old # v6.4.0\n+        uses: actions/setup-node@new # v6.5.0\n`;
    expect(classify(['.github/workflows/release.yml'], patch)).toBe(false);
  });

  it('counts substantive release workflow changes', () => {
    const patch = `--- a/.github/workflows/auto-release.workflow.yml\n+++ b/.github/workflows/auto-release.workflow.yml\n@@ -1 +1 @@\n-  MINIMUM_COMMITS: '3'\n+  MINIMUM_COMMITS: '4'\n`;
    expect(classify(['.github/workflows/auto-release.workflow.yml'], patch)).toBe(
      true,
    );
  });

  it('lets a real app change win over an Actions-only update', () => {
    const patch = `@@ -1 +1 @@\n-        uses: actions/checkout@old\n+        uses: actions/checkout@new\n`;
    expect(
      classify(['.github/workflows/release.yml', 'renderer/index.css'], patch),
    ).toBe(true);
  });

  it('counts dependency updates even when the rest of the PR is maintenance', () => {
    expect(classify(['package.json', 'pnpm-lock.yaml', 'README.md'])).toBe(true);
  });
});
