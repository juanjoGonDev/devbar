import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectedReleaseArtifactNames,
  type ReleasePlatform,
} from '../scripts/release-artifacts.js';
import {
  findRepoRoot,
  main,
  resolveVerifyRequest,
} from '../scripts/verify-release-artifacts.js';

/**
 * The release gate: the last check between a built artifact set and a
 * published GitHub release. It only ever runs inside a release job, so its
 * argument handling has no other way to be exercised.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const temporaryDirectories: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

interface FixtureOptions {
  version: string;
  platform?: ReleasePlatform;
  withManifest?: boolean;
  skip?: string;
  corrupt?: string;
}

/** A directory that looks like a finished build of `platform`. */
function makeArtifactDir({
  version,
  platform,
  withManifest = true,
  skip,
  corrupt,
}: FixtureOptions): string {
  const directory = makeTempDir('devbar-verify-');
  const manifestLines: string[] = [];
  for (const name of expectedReleaseArtifactNames(version, platform)) {
    if (name === skip) continue;
    const contents = name === corrupt ? `tampered:${name}` : `fixture:${name}`;
    writeFileSync(path.join(directory, name), contents);
    manifestLines.push(`${sha256(`fixture:${name}`)}  ${name}`);
  }
  if (withManifest)
    writeFileSync(
      path.join(directory, 'SHA256SUMS.txt'),
      `${manifestLines.join('\n')}\n`,
    );
  return directory;
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

describe('scripts/verify-release-artifacts.ts', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('findRepoRoot', () => {
    it('walks up to the directory carrying pnpm-lock.yaml', () => {
      const root = makeTempDir('devbar-root-');
      writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfile: 9\n');
      const nested = path.join(root, 'build', 'scripts');
      mkdirSync(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(root);
    });

    it('is not fooled by the emitted build/package.json', () => {
      const root = makeTempDir('devbar-root-');
      writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfile: 9\n');
      const emitted = path.join(root, 'build');
      mkdirSync(path.join(emitted, 'scripts'), { recursive: true });
      writeFileSync(path.join(emitted, 'package.json'), '{}');
      expect(findRepoRoot(path.join(emitted, 'scripts'))).toBe(root);
    });

    it('throws when no ancestor carries the lockfile', () => {
      const orphan = makeTempDir('devbar-orphan-');
      expect(() => findRepoRoot(orphan)).toThrow('repository root not found');
    });

    it('defaults to this checkout when no directory is given', () => {
      expect(findRepoRoot()).toBe(repositoryRoot);
    });
  });

  describe('resolveVerifyRequest', () => {
    it('defaults to <root>/dist/release and the packaged version', () => {
      expect(resolveVerifyRequest([], '/checkout', '1.2.3')).toEqual({
        directory: path.resolve(path.join('/checkout', 'dist', 'release')),
        version: '1.2.3',
      });
    });

    it('leaves the platform key OUT when no platform is given', () => {
      // An explicit `platform: undefined` would still read as "per-platform"
      // to a caller checking the key, and the full-set publish gate (manifest
      // required, no stray files) would be skipped.
      const request = resolveVerifyRequest([], '/checkout', '1.2.3');
      expect('platform' in request).toBe(false);
    });

    it('accepts each platform of the release contract', () => {
      for (const platform of ['macos', 'win', 'linux'] as const) {
        expect(
          resolveVerifyRequest(
            [path.join(path.sep, 'out'), '4.5.6', platform],
            '/checkout',
            '1.2.3',
          ),
          platform,
        ).toEqual({
          directory: path.join(path.sep, 'out'),
          version: '4.5.6',
          platform,
        });
      }
    });

    it('rejects an unknown platform name', () => {
      expect(() =>
        resolveVerifyRequest(
          ['/out', '1.2.3', 'windows'],
          '/checkout',
          '1.2.3',
        ),
      ).toThrow('Unknown platform: windows');
      expect(() =>
        resolveVerifyRequest(['/out', '1.2.3', 'MACOS'], '/checkout', '1.2.3'),
      ).toThrow('Unknown platform: MACOS');
    });
  });

  describe('main', () => {
    it('verifies the full release set and reports the count', async () => {
      const directory = makeArtifactDir({ version: '1.2.3' });
      const capture = captureStdout();
      await main([directory, '1.2.3']);
      capture.restore();
      expect(capture.lines).toEqual([
        `Verified 14 release artifacts for v1.2.3 in ${directory}\n`,
      ]);
    });

    it('verifies one platform without requiring the full manifest', async () => {
      const directory = makeArtifactDir({
        version: '1.2.3',
        platform: 'win',
        withManifest: false,
      });
      const capture = captureStdout();
      await main([directory, '1.2.3', 'win']);
      capture.restore();
      expect(capture.lines).toEqual([
        `Verified 4 release artifacts for v1.2.3 (win) in ${directory}\n`,
      ]);
    });

    it('rejects an unknown platform before reading the directory', async () => {
      // The directory does not exist: only the argument guard can produce
      // this message, so a passthrough would fail with an fs error instead.
      await expect(
        main([path.join(path.sep, 'no', 'such', 'dir'), '1.2.3', 'windows']),
      ).rejects.toThrow('Unknown platform: windows');
    });

    it('fails when an artifact is missing', async () => {
      const directory = makeArtifactDir({
        version: '1.2.3',
        platform: 'linux',
        skip: 'DevBar-1.2.3-linux-armv7.AppImage',
      });
      await expect(main([directory, '1.2.3', 'linux'])).rejects.toThrow(
        'DevBar-1.2.3-linux-armv7.AppImage is missing or empty',
      );
    });

    it('fails when an artifact does not match its checksum', async () => {
      const directory = makeArtifactDir({
        version: '1.2.3',
        corrupt: 'DevBar-1.2.3-macos-x64.zip',
      });
      await expect(main([directory, '1.2.3'])).rejects.toThrow(
        'Checksum mismatch for DevBar-1.2.3-macos-x64.zip.',
      );
    });
  });
});
