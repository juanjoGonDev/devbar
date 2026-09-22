import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { expectedReleaseArtifactNames } from '../scripts/release-artifacts.js';
import {
  findRepoRoot,
  main,
  resolveManifestRequest,
  writeReleaseManifest,
} from '../scripts/release-manifest.js';

/**
 * The publish job's manifest writer. It runs once per release, from a
 * directory assembled out of three OS build jobs, so every branch here is
 * one that only ever executes when a release is already in flight.
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

/** A directory holding one non-empty file per artifact of the full set. */
function makeArtifactDir(version: string, skip?: string): string {
  const directory = makeTempDir('devbar-manifest-');
  for (const name of expectedReleaseArtifactNames(version)) {
    if (name === skip) continue;
    writeFileSync(path.join(directory, name), `fixture:${name}`);
  }
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

describe('scripts/release-manifest.ts', () => {
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
      // The compiled scripts live next to a tsc-emitted package.json; only
      // the lockfile marks the real root.
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

  describe('resolveManifestRequest', () => {
    it('defaults to <root>/dist/release and the packaged version', () => {
      expect(resolveManifestRequest([], '/checkout', '1.2.3')).toEqual({
        directory: path.resolve(path.join('/checkout', 'dist', 'release')),
        version: '1.2.3',
      });
    });

    it('prefers the arguments over the defaults', () => {
      expect(
        resolveManifestRequest(
          [path.join(path.sep, 'out', 'release'), '4.5.6'],
          '/checkout',
          '1.2.3',
        ),
      ).toEqual({
        directory: path.join(path.sep, 'out', 'release'),
        version: '4.5.6',
      });
    });

    it('makes a relative directory absolute', () => {
      // A relative path would otherwise be interpreted differently by
      // writeSha256Manifest depending on the caller's working directory.
      const { directory } = resolveManifestRequest(
        ['out/release'],
        '/checkout',
        '1.2.3',
      );
      expect(path.isAbsolute(directory)).toBe(true);
      expect(directory.endsWith(path.join('out', 'release'))).toBe(true);
    });

    it('treats an empty argument as "not given"', () => {
      expect(resolveManifestRequest(['', ''], '/checkout', '1.2.3')).toEqual({
        directory: path.resolve(path.join('/checkout', 'dist', 'release')),
        version: '1.2.3',
      });
    });
  });

  describe('writeReleaseManifest', () => {
    it('hashes every artifact of the full release set', async () => {
      const directory = makeArtifactDir('1.2.3');
      const capture = captureStdout();
      const manifestPath = await writeReleaseManifest({
        directory,
        version: '1.2.3',
      });
      capture.restore();

      expect(manifestPath).toBe(path.join(directory, 'SHA256SUMS.txt'));
      const lines = readFileSync(manifestPath, 'utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(14);
      expect(lines).toContain(
        `${sha256('fixture:DevBar-1.2.3-linux-armv7.deb')}  DevBar-1.2.3-linux-armv7.deb`,
      );
      expect(lines).toContain(
        `${sha256('fixture:DevBar-1.2.3-macos-arm64.dmg')}  DevBar-1.2.3-macos-arm64.dmg`,
      );
      expect(capture.lines).toEqual([
        `Wrote ${manifestPath} (14 artifacts for v1.2.3)\n`,
      ]);
    });

    it('fails instead of writing a partial manifest', async () => {
      const directory = makeArtifactDir(
        '1.2.3',
        'DevBar-1.2.3-win-x64-setup.exe',
      );
      const capture = captureStdout();
      await expect(
        writeReleaseManifest({ directory, version: '1.2.3' }),
      ).rejects.toThrow('DevBar-1.2.3-win-x64-setup.exe is missing or empty');
      capture.restore();
      expect(capture.lines).toEqual([]);
    });
  });

  describe('main', () => {
    it('writes the manifest for the directory and version given on argv', async () => {
      const directory = makeArtifactDir('7.8.9');
      const capture = captureStdout();
      const manifestPath = await main([directory, '7.8.9']);
      capture.restore();
      expect(manifestPath).toBe(path.join(directory, 'SHA256SUMS.txt'));
      expect(readFileSync(manifestPath, 'utf8')).toContain(
        'DevBar-7.8.9-win-arm64-portable.exe',
      );
      expect(capture.lines.join('')).toContain('(14 artifacts for v7.8.9)');
    });

    it('defaults the version to the one in package.json', async () => {
      const version = packageJson.version;
      const directory = makeArtifactDir(version);
      const capture = captureStdout();
      const manifestPath = await main([directory]);
      capture.restore();
      const lines = readFileSync(manifestPath, 'utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(14);
      for (const line of lines)
        expect(line, line).toContain(`  DevBar-${version}-`);
    });
  });
});
