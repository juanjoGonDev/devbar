import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  expectedReleaseArtifactNames,
  parseChecksumManifest,
  verifyReleaseArtifactSet,
  writeSha256Manifest,
  RELEASE_PLATFORMS,
  type ReleasePlatform,
} from '../scripts/release-artifacts.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function createArtifactFixture(
  version = '0.2.0',
  platform?: ReleasePlatform,
  withManifest = true,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-release-'));
  temporaryDirectories.push(directory);

  const artifactNames = expectedReleaseArtifactNames(version, platform);
  const manifestLines = [];

  for (const artifactName of artifactNames) {
    const contents = `fixture:${artifactName}`;
    await writeFile(path.join(directory, artifactName), contents);
    manifestLines.push(`${sha256(contents)}  ${artifactName}`);
  }

  if (withManifest) {
    await writeFile(
      path.join(directory, 'SHA256SUMS.txt'),
      `${manifestLines.join('\n')}\n`,
    );
  }

  return { artifactNames, directory, version };
}

describe('scripts/release-artifacts.ts', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  describe('release artifact contract', () => {
    it('lists every artifact of every platform for the full release', () => {
      const names = expectedReleaseArtifactNames('0.2.0');
      expect(names).toEqual(
        expect.arrayContaining([
          'DevBar-0.2.0-macos-arm64.dmg',
          'DevBar-0.2.0-macos-arm64.zip',
          'DevBar-0.2.0-macos-x64.dmg',
          'DevBar-0.2.0-macos-x64.zip',
          'DevBar-0.2.0-win-x64-setup.exe',
          'DevBar-0.2.0-win-x64-portable.exe',
          'DevBar-0.2.0-win-arm64-setup.exe',
          'DevBar-0.2.0-win-arm64-portable.exe',
          'DevBar-0.2.0-linux-x64.AppImage',
          'DevBar-0.2.0-linux-x64.deb',
          'DevBar-0.2.0-linux-arm64.AppImage',
          'DevBar-0.2.0-linux-arm64.deb',
          'DevBar-0.2.0-linux-armv7.AppImage',
          'DevBar-0.2.0-linux-armv7.deb',
        ]),
      );
      expect(names).toHaveLength(14);
      expect(new Set(names).size).toBe(names.length);
    });

    it('filters to one platform when asked', () => {
      expect(expectedReleaseArtifactNames('0.2.0', 'macos')).toEqual([
        'DevBar-0.2.0-macos-arm64.dmg',
        'DevBar-0.2.0-macos-arm64.zip',
        'DevBar-0.2.0-macos-x64.dmg',
        'DevBar-0.2.0-macos-x64.zip',
      ]);
      expect(expectedReleaseArtifactNames('0.2.0', 'win')).toEqual([
        'DevBar-0.2.0-win-x64-setup.exe',
        'DevBar-0.2.0-win-x64-portable.exe',
        'DevBar-0.2.0-win-arm64-setup.exe',
        'DevBar-0.2.0-win-arm64-portable.exe',
      ]);
      expect(expectedReleaseArtifactNames('0.2.0', 'linux')).toEqual([
        'DevBar-0.2.0-linux-x64.AppImage',
        'DevBar-0.2.0-linux-x64.deb',
        'DevBar-0.2.0-linux-arm64.AppImage',
        'DevBar-0.2.0-linux-arm64.deb',
        'DevBar-0.2.0-linux-armv7.AppImage',
        'DevBar-0.2.0-linux-armv7.deb',
      ]);
    });

    it('covers every declared platform', () => {
      for (const platform of RELEASE_PLATFORMS)
        expect(
          expectedReleaseArtifactNames('0.2.0', platform).length,
        ).toBeGreaterThan(0);
    });

    it('rejects unsafe and duplicate manifest entries', () => {
      const checksum = 'a'.repeat(64);

      expect(() =>
        parseChecksumManifest(`${checksum}  ../artifact.dmg\n`),
      ).toThrow('Unsafe checksum manifest path');
      expect(() =>
        parseChecksumManifest(
          `${checksum}  artifact.dmg\n${checksum}  artifact.dmg\n`,
        ),
      ).toThrow('Duplicate checksum manifest entry');
    });

    it('verifies a complete artifact set and its checksums', async () => {
      const fixture = await createArtifactFixture();

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).resolves.toMatchObject({
        artifactNames: fixture.artifactNames,
        directory: fixture.directory,
        version: fixture.version,
      });
    });

    it('verifies a per-platform set without a manifest', async () => {
      const fixture = await createArtifactFixture('0.2.0', 'win', false);

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
          platform: 'win',
        }),
      ).resolves.toMatchObject({
        artifactNames: fixture.artifactNames,
      });
    });

    it('verifies a per-platform set against a full manifest', async () => {
      const platformFixture = await createArtifactFixture(
        '0.2.0',
        'win',
        false,
      );
      const fullFixture = await createArtifactFixture();
      // The platform job's directory holds ITS artifacts plus (optionally) a
      // full manifest that must stay consistent.
      for (const name of platformFixture.artifactNames)
        await readFile(path.join(fullFixture.directory, name), 'utf8').then(
          (contents) =>
            writeFile(path.join(platformFixture.directory, name), contents),
        );
      await readFile(
        path.join(fullFixture.directory, 'SHA256SUMS.txt'),
        'utf8',
      ).then((contents) =>
        writeFile(
          path.join(platformFixture.directory, 'SHA256SUMS.txt'),
          contents,
        ),
      );

      await expect(
        verifyReleaseArtifactSet({
          directory: platformFixture.directory,
          version: '0.2.0',
          platform: 'win',
        }),
      ).resolves.toMatchObject({
        artifactNames: platformFixture.artifactNames,
      });
    });

    it('fails when an expected artifact is missing', async () => {
      const fixture = await createArtifactFixture();
      await unlink(path.join(fixture.directory, fixture.artifactNames[0]));

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).rejects.toThrow(`${fixture.artifactNames[0]} is missing or empty`);
    });

    it('rejects an unknown regular file in the release directory', async () => {
      const fixture = await createArtifactFixture();
      await writeFile(
        path.join(fixture.directory, 'suspicious-byproduct.txt'),
        'not an artifact',
      );

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).rejects.toThrow(
        'Unexpected file in release directory: suspicious-byproduct.txt',
      );
    });

    it('tolerates electron-builder byproducts for a per-platform set (raw outDir)', async () => {
      // Per-platform verification runs against dist/electron-builder, the
      // raw build output: blockmaps, latest.yml, builder-debug.yml and the
      // unpacked dirs live there by design and must not fail the verify.
      const fixture = await createArtifactFixture('0.2.0', 'win', false);
      await writeFile(
        path.join(fixture.directory, 'builder-debug.yml'),
        'electron-builder debug log',
      );
      await writeFile(
        path.join(fixture.directory, 'latest.yml'),
        'version: 0.2.0',
      );
      await writeFile(
        path.join(fixture.directory, 'DevBar-0.2.0-win-x64-setup.exe.blockmap'),
        'blockmap',
      );

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: '0.2.0',
          platform: 'win',
        }),
      ).resolves.toMatchObject({ artifactNames: fixture.artifactNames });
    });

    it('allows directories and the manifest next to the artifacts', async () => {
      const fixture = await createArtifactFixture();
      await mkdir(path.join(fixture.directory, 'build-notes'), {
        recursive: true,
      });
      await writeFile(
        path.join(fixture.directory, 'build-notes', 'readme.txt'),
        'nested files do not ship at the top level',
      );

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).resolves.toMatchObject({ artifactNames: fixture.artifactNames });
    });

    it('fails when the manifest omits an expected artifact', async () => {
      const fixture = await createArtifactFixture();
      const manifestPath = path.join(fixture.directory, 'SHA256SUMS.txt');
      const manifestLines = (await readFile(manifestPath, 'utf8'))
        .trimEnd()
        .split('\n');
      await writeFile(manifestPath, `${manifestLines.slice(1).join('\n')}\n`);

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).rejects.toThrow(
        `Missing checksum manifest entry: ${fixture.artifactNames[0]}`,
      );
    });

    it('fails when the manifest includes an unexpected artifact', async () => {
      const fixture = await createArtifactFixture();
      const manifestPath = path.join(fixture.directory, 'SHA256SUMS.txt');
      const manifest = await readFile(manifestPath, 'utf8');
      await writeFile(
        manifestPath,
        `${manifest}${'b'.repeat(64)}  unexpected.bin\n`,
      );

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).rejects.toThrow('Unexpected checksum manifest entry: unexpected.bin');
    });

    it('fails when an artifact is changed after the manifest is generated', async () => {
      const fixture = await createArtifactFixture();
      await writeFile(
        path.join(fixture.directory, fixture.artifactNames[0]),
        'tampered',
      );

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).rejects.toThrow(`Checksum mismatch for ${fixture.artifactNames[0]}`);
    });

    it('fails the full-set check when the manifest is missing', async () => {
      const fixture = await createArtifactFixture('0.2.0', undefined, false);

      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
        }),
      ).rejects.toThrow('SHA256SUMS.txt is missing');
    });

    it('writeSha256Manifest writes sorted, verifiable hashes', async () => {
      const fixture = await createArtifactFixture('0.2.0', 'win', false);
      await writeSha256Manifest(fixture.directory, fixture.artifactNames);
      const manifest = await readFile(
        path.join(fixture.directory, 'SHA256SUMS.txt'),
        'utf8',
      );
      const lines = manifest.trimEnd().split('\n');
      expect(lines).toEqual(
        [...lines].sort(
          (a, b) => b.split('  ')[1].localeCompare(a.split('  ')[1]) * -1,
        ),
      );
      await expect(
        verifyReleaseArtifactSet({
          directory: fixture.directory,
          version: fixture.version,
          platform: 'win',
        }),
      ).resolves.toMatchObject({ artifactNames: fixture.artifactNames });
    });

    it('runs independently from the caller working directory', async () => {
      const fixture = await createArtifactFixture();
      const callerDirectory = await mkdtemp(
        path.join(tmpdir(), 'devbar-release-caller-'),
      );
      temporaryDirectories.push(callerDirectory);
      const tsc = path.join(repositoryRoot, 'node_modules', '.bin', 'tsc');
      // These two timeouts are hang guards, not performance budgets. The
      // compile takes ~6s on an idle machine but comfortably passes 15s when
      // the rest of the suite is competing for the same cores, so a 15s guard
      // failed the whole gate on a healthy run. The test's own timeout below
      // stays above the sum of both.
      await execFileAsync(tsc, ['-p', 'tsconfig.node.json'], {
        cwd: repositoryRoot,
        timeout: 60_000,
      });
      const verifier = path.join(
        repositoryRoot,
        'build',
        'scripts',
        'verify-release-artifacts.js',
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [verifier, fixture.directory, fixture.version],
        { cwd: callerDirectory, timeout: 60_000 },
      );

      expect(stdout).toContain('Verified 14 release artifacts for v0.2.0');
      // This test compiles the whole node project and then runs the emitted
      // verifier, so its own budget is the two subprocess guards above plus
      // the fixture. It has to sit above their sum, or the test can only ever
      // fail as a timeout instead of reporting what actually went wrong.
    }, 150_000);
  });
});
