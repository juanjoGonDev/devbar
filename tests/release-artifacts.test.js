import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  expectedReleaseArtifactNames,
  parseChecksumManifest,
  verifyReleaseArtifactSet,
} = require('../scripts/release-artifacts.js');

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function createArtifactFixture(version = '0.2.0') {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-release-'));
  temporaryDirectories.push(directory);

  const artifactNames = expectedReleaseArtifactNames(version);
  const manifestLines = [];

  for (const artifactName of artifactNames) {
    const contents = `fixture:${artifactName}`;
    await writeFile(path.join(directory, artifactName), contents);
    manifestLines.push(`${sha256(contents)}  ${artifactName}`);
  }

  await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${manifestLines.join('\n')}\n`);

  return { artifactNames, directory, version };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('release artifact contract', () => {
  it('defines both DMG and ZIP artifacts for each supported architecture', () => {
    expect(expectedReleaseArtifactNames('0.2.0')).toEqual([
      'DevBar-0.2.0-macos-arm64.dmg',
      'DevBar-0.2.0-macos-arm64.zip',
      'DevBar-0.2.0-macos-x64.dmg',
      'DevBar-0.2.0-macos-x64.zip',
    ]);
  });

  it('rejects unsafe and duplicate manifest entries', () => {
    const checksum = 'a'.repeat(64);

    expect(() => parseChecksumManifest(`${checksum}  ../artifact.dmg\n`)).toThrow(
      'Unsafe checksum manifest path',
    );
    expect(() =>
      parseChecksumManifest(`${checksum}  artifact.dmg\n${checksum}  artifact.dmg\n`),
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

  it('fails when an artifact is changed after the manifest is generated', async () => {
    const fixture = await createArtifactFixture();
    await writeFile(path.join(fixture.directory, fixture.artifactNames[0]), 'tampered');

    await expect(
      verifyReleaseArtifactSet({
        directory: fixture.directory,
        version: fixture.version,
      }),
    ).rejects.toThrow(`Checksum mismatch for ${fixture.artifactNames[0]}`);
  });

  it('runs independently from the caller working directory', async () => {
    const fixture = await createArtifactFixture();
    const callerDirectory = await mkdtemp(path.join(tmpdir(), 'devbar-release-caller-'));
    temporaryDirectories.push(callerDirectory);
    const verifier = path.resolve('scripts/verify-release-artifacts.js');

    const { stdout } = await execFileAsync(
      process.execPath,
      [verifier, fixture.directory, fixture.version],
      { cwd: callerDirectory },
    );

    expect(stdout).toContain('Verified 4 release artifacts for v0.2.0');
  });
});
