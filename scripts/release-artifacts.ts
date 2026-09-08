import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const RELEASE_ARCHITECTURES = ['arm64', 'x64'] as const;
export function assertStableVersion(version: string): void {
  if (!STABLE_VERSION_PATTERN.test(version))
    throw new Error(
      `Invalid stable release version: ${version || '<missing>'}`,
    );
}
export function expectedReleaseArtifactNames(version: string): string[] {
  assertStableVersion(version);
  return RELEASE_ARCHITECTURES.flatMap((architecture) => [
    `DevBar-${version}-macos-${architecture}.dmg`,
    `DevBar-${version}-macos-${architecture}.zip`,
  ]);
}
export function parseChecksumManifest(contents: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  if (!lines.length) throw new Error('SHA256SUMS.txt is empty.');
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (!match?.[1] || !match[2])
      throw new Error(`Invalid checksum manifest line: ${line}`);
    const checksum = match[1],
      filename = match[2];
    if (!SHA256_PATTERN.test(checksum))
      throw new Error(`Invalid SHA-256 checksum for ${filename}.`);
    if (path.basename(filename) !== filename || filename.includes('\\'))
      throw new Error(`Unsafe checksum manifest path: ${filename}`);
    if (entries.has(filename))
      throw new Error(`Duplicate checksum manifest entry: ${filename}`);
    entries.set(filename, checksum);
  }
  return entries;
}
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
async function assertNonEmptyFile(
  filePath: string,
  label: string,
): Promise<void> {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0)
    throw new Error(`${label} is missing or empty: ${filePath}`);
}
export async function verifyReleaseArtifactSet({
  directory,
  version,
}: {
  directory: string;
  version: string;
}): Promise<{ artifactNames: string[]; directory: string; version: string }> {
  assertStableVersion(version);
  const outputDirectory = path.resolve(directory);
  const artifactNames = expectedReleaseArtifactNames(version);
  const manifestPath = path.join(outputDirectory, 'SHA256SUMS.txt');
  await Promise.all(
    artifactNames.map((name) =>
      assertNonEmptyFile(path.join(outputDirectory, name), name),
    ),
  );
  await assertNonEmptyFile(manifestPath, 'SHA256SUMS.txt');
  const manifest = parseChecksumManifest(await readFile(manifestPath, 'utf8'));
  const expectedNames = new Set(artifactNames);
  for (const name of artifactNames)
    if (!manifest.has(name))
      throw new Error(`Missing checksum manifest entry: ${name}`);
  for (const name of manifest.keys())
    if (!expectedNames.has(name))
      throw new Error(`Unexpected checksum manifest entry: ${name}`);
  await Promise.all(
    artifactNames.map(async (name) => {
      const actual = await hashFile(path.join(outputDirectory, name));
      if (actual !== manifest.get(name))
        throw new Error(`Checksum mismatch for ${name}.`);
    }),
  );
  return { artifactNames, directory: outputDirectory, version };
}
