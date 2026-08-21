import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const policyPath = resolve(process.cwd(), 'scripts/release-impact-policy.ts');
const temporaryDirectories: string[] = [];

type Classification = {
  publish: boolean;
  paths: string[];
};

type PendingImpact = {
  publish: boolean;
  commitCount: number;
  commits: string[];
};

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runPolicy(
  args: string[],
  cwd = process.cwd(),
): Classification | PendingImpact {
  const policyArgs = ['--experimental-strip-types', policyPath, ...args];
  const result = spawnSync(process.execPath, policyArgs, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'release impact policy failed');
  }
  return JSON.parse(result.stdout) as Classification | PendingImpact;
}

function classify(
  paths: string[],
  beforePackage: Record<string, unknown>,
  afterPackage: Record<string, unknown>,
): Classification {
  const directory = temporaryDirectory('devbar-release-policy-');
  const pathsFile = join(directory, 'paths.bin');
  const beforeFile = join(directory, 'before-package.json');
  const afterFile = join(directory, 'after-package.json');

  writeFileSync(pathsFile, `${paths.join('\0')}\0`, 'utf8');
  writeFileSync(beforeFile, JSON.stringify(beforePackage), 'utf8');
  writeFileSync(afterFile, JSON.stringify(afterPackage), 'utf8');

  return runPolicy([
    'classify',
    pathsFile,
    beforeFile,
    afterFile,
  ]) as Classification;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function commitFile(
  directory: string,
  path: string,
  content: string,
  message: string,
): string {
  const absolutePath = join(directory, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  git(directory, 'add', path);
  git(directory, 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('release impact policy', () => {
  const packageJson = {
    name: 'devbar',
    version: '1.0.0',
    dependencies: { menubar: '9.5.2' },
  };

  it.each([
    'src/main.ts',
    'renderer/index.ts',
    'assets/icon.icns',
    'pnpm-lock.yaml',
    '.npmrc',
    'tsconfig.node.json',
    'tsconfig.renderer.json',
    'scripts/build.sh',
    'scripts/build-macos-release.sh',
    'scripts/package-electron.ts',
    'scripts/package-macos-app.sh',
  ])('classifies %s as release-impacting', (path) => {
    expect(classify([path], packageJson, packageJson)).toEqual({
      publish: true,
      paths: [path],
    });
  });

  it.each([
    'README.md',
    'CHANGELOG.md',
    'AGENTS.md',
    'tests/changelog-view.test.ts',
    '.agents/specs/release.md',
    '.github/workflows/release.yml',
    '.github/workflows/dependabot-auto-merge.workflow.yml',
    'scripts/release-impact-policy.ts',
    'scripts/verify-macos-release.sh',
    'tsconfig.tests.json',
  ])('skips release-neutral path %s', (path) => {
    expect(classify([path], packageJson, packageJson)).toEqual({
      publish: false,
      paths: [],
    });
  });

  it('skips a package.json version-only change', () => {
    expect(
      classify(
        ['package.json'],
        packageJson,
        { ...packageJson, version: '1.0.1' },
      ),
    ).toEqual({ publish: false, paths: [] });
  });

  it('publishes for a semantic package.json dependency change', () => {
    expect(
      classify(
        ['package.json'],
        packageJson,
        {
          ...packageJson,
          version: '1.0.1',
          dependencies: { menubar: '9.6.0' },
        },
      ),
    ).toEqual({ publish: true, paths: ['package.json'] });
  });

  it('publishes mixed changes when one build input changes', () => {
    expect(
      classify(['README.md', 'src/main.ts'], packageJson, packageJson),
    ).toEqual({ publish: true, paths: ['src/main.ts'] });
  });

  it('counts only release-impacting first-parent commits', () => {
    const directory = temporaryDirectory('devbar-release-history-');
    git(directory, 'init');
    git(directory, 'config', 'user.name', 'DevBar Test');
    git(directory, 'config', 'user.email', 'devbar@example.test');

    commitFile(
      directory,
      'package.json',
      JSON.stringify(packageJson),
      'chore: baseline',
    );
    git(directory, 'tag', 'v1.0.0');

    commitFile(directory, 'README.md', 'docs', 'docs: update readme');
    const releaseCommit = commitFile(
      directory,
      'src/main.ts',
      'export const value = 1;\n',
      'feat: add product behavior',
    );
    commitFile(
      directory,
      '.github/workflows/ci.yml',
      'name: CI\n',
      'chore(actions): pin checkout',
    );
    commitFile(
      directory,
      'package.json',
      JSON.stringify({ ...packageJson, version: '1.0.1' }),
      'chore(release): prepare v1.0.1',
    );

    expect(runPolicy(['pending', 'v1.0.0', 'HEAD'], directory)).toEqual({
      publish: true,
      commitCount: 1,
      commits: [releaseCommit],
    });
  });
});
