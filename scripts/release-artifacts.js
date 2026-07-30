'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { stat, readFile } = require('node:fs/promises');
const path = require('node:path');

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_ARCHITECTURES = Object.freeze(['arm64', 'x64']);

function assertStableVersion(version) {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid stable release version: ${version || '<missing>'}`);
  }
}

function expectedReleaseArtifactNames(version) {
  assertStableVersion(version);

  return RELEASE_ARCHITECTURES.flatMap((architecture) => [
    `DevBar-${version}-macos-${architecture}.dmg`,
    `DevBar-${version}-macos-${architecture}.zip`,
  ]);
}

function parseChecksumManifest(contents) {
  const entries = new Map();
  const lines = contents.split(/\r?\n/u).filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('SHA256SUMS.txt is empty.');
  }

  for (const line of lines) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (!match) {
      throw new Error(`Invalid checksum manifest line: ${line}`);
    }

    const [, checksum, filename] = match;
    if (!SHA256_PATTERN.test(checksum)) {
      throw new Error(`Invalid SHA-256 checksum for ${filename}.`);
    }
    if (path.basename(filename) !== filename || filename.includes('\\')) {
      throw new Error(`Unsafe checksum manifest path: ${filename}`);
    }
    if (entries.has(filename)) {
      throw new Error(`Duplicate checksum manifest entry: ${filename}`);
    }

    entries.set(filename, checksum);
  }

  return entries;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

async function assertNonEmptyFile(filePath, label) {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
  }
}

async function verifyReleaseArtifactSet({ directory, version }) {
  assertStableVersion(version);

  const outputDirectory = path.resolve(directory);
  const artifactNames = expectedReleaseArtifactNames(version);
  const manifestPath = path.join(outputDirectory, 'SHA256SUMS.txt');

  await Promise.all(
    artifactNames.map((artifactName) =>
      assertNonEmptyFile(path.join(outputDirectory, artifactName), artifactName),
    ),
  );
  await assertNonEmptyFile(manifestPath, 'SHA256SUMS.txt');

  const manifest = parseChecksumManifest(await readFile(manifestPath, 'utf8'));
  const expectedNames = new Set(artifactNames);

  for (const artifactName of artifactNames) {
    if (!manifest.has(artifactName)) {
      throw new Error(`Missing checksum manifest entry: ${artifactName}`);
    }
  }

  for (const manifestName of manifest.keys()) {
    if (!expectedNames.has(manifestName)) {
      throw new Error(`Unexpected checksum manifest entry: ${manifestName}`);
    }
  }

  await Promise.all(
    artifactNames.map(async (artifactName) => {
      const actualChecksum = await hashFile(path.join(outputDirectory, artifactName));
      const expectedChecksum = manifest.get(artifactName);
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Checksum mismatch for ${artifactName}.`);
      }
    }),
  );

  return {
    artifactNames,
    directory: outputDirectory,
    version,
  };
}

module.exports = {
  RELEASE_ARCHITECTURES,
  assertStableVersion,
  expectedReleaseArtifactNames,
  parseChecksumManifest,
  verifyReleaseArtifactSet,
};
