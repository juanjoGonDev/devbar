import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The release artifact contract. Every OS job in the release workflow builds
 * exactly the artifacts listed here for its platform, and the publish job
 * assembles them into the full set plus a SHA256SUMS.txt manifest. The
 * in-app updater selects its download from the same names
 * (src/update-check.ts), so this list is the single source of truth.
 */

export type ReleasePlatform = 'macos' | 'win' | 'linux';

export const RELEASE_PLATFORMS: readonly ReleasePlatform[] = [
  'macos',
  'win',
  'linux',
];

/** Apple Silicon + Intel. */
export const MACOS_ARCHITECTURES = ['arm64', 'x64'] as const;
/** Windows 10/11 x64 + Windows on ARM. */
export const WIN_ARCHITECTURES = ['x64', 'arm64'] as const;
/** Desktop x64 + Raspberry Pi 4/5 (arm64) + 32-bit Pi OS (armv7). */
export const LINUX_ARCHITECTURES = ['x64', 'arm64', 'armv7'] as const;

function platformArtifactNames(
  version: string,
  platform: ReleasePlatform,
): string[] {
  if (platform === 'macos')
    return MACOS_ARCHITECTURES.flatMap((architecture) => [
      `DevBar-${version}-macos-${architecture}.dmg`,
      `DevBar-${version}-macos-${architecture}.zip`,
    ]);
  if (platform === 'win')
    return WIN_ARCHITECTURES.flatMap((architecture) => [
      `DevBar-${version}-win-${architecture}-setup.exe`,
      `DevBar-${version}-win-${architecture}-portable.exe`,
    ]);
  return LINUX_ARCHITECTURES.flatMap((architecture) => [
    `DevBar-${version}-linux-${architecture}.AppImage`,
    `DevBar-${version}-linux-${architecture}.deb`,
  ]);
}

/**
 * Artifact file names for one platform, or for the whole release when
 * `platform` is omitted.
 */
export function expectedReleaseArtifactNames(
  version: string,
  platform?: ReleasePlatform,
): string[] {
  assertStableVersion(version);
  const platforms: readonly ReleasePlatform[] = platform
    ? [platform]
    : RELEASE_PLATFORMS;
  return platforms.flatMap((p) => platformArtifactNames(version, p));
}

export function assertStableVersion(version: string): void {
  if (!STABLE_VERSION_PATTERN.test(version))
    throw new Error(
      `Invalid stable release version: ${version || '<missing>'}`,
    );
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
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
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

/**
 * Write SHA256SUMS.txt for the given artifacts (sorted by name). Used by the
 * publish job once every platform's artifacts are in one directory.
 */
export async function writeSha256Manifest(
  directory: string,
  artifactNames: readonly string[],
): Promise<string> {
  const lines = await Promise.all(
    [...artifactNames].sort().map(async (name) => {
      const filePath = path.join(directory, name);
      await assertNonEmptyFile(filePath, name);
      return `${await hashFile(filePath)}  ${name}`;
    }),
  );
  const manifestPath = path.join(directory, 'SHA256SUMS.txt');
  writeFileSync(manifestPath, `${lines.join('\n')}\n`);
  return manifestPath;
}

export interface VerifyArtifactSetResult {
  artifactNames: string[];
  directory: string;
  version: string;
}

/**
 * Verify a built artifact set:
 *  - every expected artifact exists and is non-empty;
 *  - manifest rules:
 *      · full set (no `platform`): a SHA256SUMS.txt MUST be present, must
 *        cover the full contract exactly, and every hash must match — this
 *        is the publish gate.
 *      · per-platform (`platform`): the set is what an OS job just built and
 *        the full manifest doesn't exist yet, so none is required; if one IS
 *        present it must stay consistent (entries from the contract only,
 *        every expected file covered, hashes match).
 */
export async function verifyReleaseArtifactSet({
  directory,
  version,
  platform,
}: {
  directory: string;
  version: string;
  platform?: ReleasePlatform;
}): Promise<VerifyArtifactSetResult> {
  assertStableVersion(version);
  const outputDirectory = path.resolve(directory);
  const artifactNames = expectedReleaseArtifactNames(version, platform);
  const manifestPath = path.join(outputDirectory, 'SHA256SUMS.txt');

  await Promise.all(
    artifactNames.map((name) =>
      assertNonEmptyFile(path.join(outputDirectory, name), name),
    ),
  );

  const manifest = (await stat(manifestPath).catch(() => null))
    ? parseChecksumManifest(await readFile(manifestPath, 'utf8'))
    : null;

  if (platform === undefined) {
    if (!manifest) throw new Error('SHA256SUMS.txt is missing.');
    const expectedNames = expectedReleaseArtifactNames(version);
    for (const name of expectedNames)
      if (!manifest.has(name))
        throw new Error(`Missing checksum manifest entry: ${name}`);
    for (const name of manifest.keys())
      if (!expectedNames.includes(name))
        throw new Error(`Unexpected checksum manifest entry: ${name}`);
    await Promise.all(
      expectedNames.map(async (name) => {
        const actual = await hashFile(path.join(outputDirectory, name));
        if (actual !== manifest.get(name))
          throw new Error(`Checksum mismatch for ${name}.`);
      }),
    );
    return {
      artifactNames: expectedNames,
      directory: outputDirectory,
      version,
    };
  }

  if (manifest) {
    const fullContract = new Set(expectedReleaseArtifactNames(version));
    for (const name of manifest.keys())
      if (!fullContract.has(name))
        throw new Error(`Unexpected checksum manifest entry: ${name}`);
    for (const name of artifactNames)
      if (!manifest.has(name))
        throw new Error(`Missing checksum manifest entry: ${name}`);
    await Promise.all(
      artifactNames.map(async (name) => {
        const actual = await hashFile(path.join(outputDirectory, name));
        if (actual !== manifest.get(name))
          throw new Error(`Checksum mismatch for ${name}.`);
      }),
    );
  }

  return { artifactNames, directory: outputDirectory, version };
}
