import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { verifyReleaseArtifactSet } from './release-artifacts.js';

/**
 * Repo root, independent of how this script is invoked: from source
 * (scripts/) or compiled (build/scripts/). The root is the only directory
 * level that carries pnpm-lock.yaml (the tsc-emitted build/package.json
 * would be a false anchor).
 */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('repository root not found');
    dir = parent;
  }
}

const ROOT = findRepoRoot();

const outputDirectory =
  process.argv[2] || path.join(ROOT, 'dist', 'electron-builder');
const version = process.argv[3] || packageJson.version;

/**
 * SquashFS superblock fields, little-endian (squashfs.h):
 *   +0  magic "hsqs"     +8   block size  (4 KiB..1 MiB, power of 2)
 *   +12 block log        +16  compression id
 * A type-2 AppImage appends the SquashFS right after the runtime ELF, so
 * a well-formed image carries a valid superblock somewhere in the file.
 * The 4-byte magic alone is NOT proof: the runtime ELF embeds SquashFS
 * reader code and can contain raw "hsqs" bytes of its own. The block
 * size / block log / compression fields are validated for
 * self-consistency (block size === 2^block log, sane ranges) — random
 * ELF bytes will not satisfy that.
 */
const SQUASHFS_MAGIC = Buffer.from('hsqs', 'latin1');

function isValidSquashfsSuperblock(data: Buffer, at: number): boolean {
  if (at + 18 > data.length) return false;
  const blockSize = data.readUInt32LE(at + 8);
  const blockLog = data.readUInt16LE(at + 12);
  const compressionId = data.readUInt16LE(at + 16);
  if (blockLog < 12 || blockLog > 20) return false;
  if (blockSize !== 2 ** blockLog) return false;
  return compressionId <= 7;
}

/**
 * True when the file carries an appended filesystem, i.e. contains a
 * structurally valid SquashFS superblock. Images run 50–300 MiB, so the
 * file is scanned in 1 MiB chunks (a 17-byte carry keeps a superblock
 * that straddles a boundary searchable). When no valid superblock is
 * found, returns a diagnostic listing the first candidates and their
 * fields, so a CI failure says WHY a real-looking image was rejected.
 */
function findSquashfsSuperblock(filePath: string): {
  found: boolean;
  detail: string | null;
} {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.alloc(1 << 20);
    const CARRY = 17; // the fields read 17 bytes past the magic
    const MAX_SAMPLES = 5;
    let offset = 0;
    let carry = Buffer.alloc(0);
    let totalCandidates = 0;
    const samples: string[] = [];
    while (offset < size) {
      const n = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, size - offset),
        offset,
      );
      if (n <= 0) break;
      const data =
        carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, n)])
          : chunk.subarray(0, n);
      let from = 0;
      for (;;) {
        const at = data.indexOf(SQUASHFS_MAGIC, from);
        if (at === -1) break;
        totalCandidates += 1;
        if (isValidSquashfsSuperblock(data, at))
          return { found: true, detail: null };
        if (samples.length < MAX_SAMPLES) {
          const fileAt = offset - (data.length - n) + at;
          if (at + 18 > data.length) {
            samples.push(`@${fileAt} (fields truncated at file end)`);
          } else {
            const blockSize = data.readUInt32LE(at + 8);
            const blockLog = data.readUInt16LE(at + 12);
            const compressionId = data.readUInt16LE(at + 16);
            const why =
              blockLog < 12 || blockLog > 20
                ? `block log ${blockLog} out of range`
                : blockSize !== 2 ** blockLog
                  ? `block ${blockSize} != 2^${blockLog}`
                  : `compression ${compressionId} unknown`;
            samples.push(
              `@${fileAt} block=${blockSize} log=${blockLog} comp=${compressionId} (${why})`,
            );
          }
        }
        from = at + 1;
      }
      carry =
        data.length > CARRY
          ? Buffer.from(data.subarray(data.length - CARRY))
          : Buffer.from(data);
      offset += n;
    }
    const detail =
      `size=${size}B, hsqs candidates=${totalCandidates}` +
      (samples.length > 0 ? `, first: ${samples.join('; ')}` : ' (none)');
    return { found: false, detail };
  } finally {
    closeSync(fd);
  }
}

/**
 * AppImageSpec structure, not just the marker: "AI" + type byte at
 * offset 8 PLUS the container the spec mandates for that type —
 *  - type 2 (0x414902, what electron-builder produces): MUST be a valid
 *    ELF executable (the marker lives in the ELF ident padding), so the
 *    ELF magic `\x7fELF` at offset 0 is required, AND it must carry the
 *    appended filesystem (a valid SquashFS superblock) — a truncated
 *    image keeps a valid ELF header, so the header + marker alone do
 *    not prove the payload is there;
 *  - type 1 (0x414901): an ISO 9660 image — its primary volume
 *    descriptor sits in sector 16 (2048-byte sectors) and carries the
 *    "CD001" signature at offset 1 of that sector.
 * The marker alone would accept a 16-byte marker-only blob, which could
 * then ride along as a published arm64/armv7 artifact (only the x64
 * image is launched in CI). The remaining ident padding is zeroes, so
 * the legacy "AppImage" string check is checking the wrong convention.
 * On rejection, `detail` explains WHY — the release jobs log it so a
 * CI failure on a real-looking image is diagnosable from the step
 * output instead of a bare "not a valid AppImage".
 */
export function checkAppImage(filePath: string): {
  ok: boolean;
  detail: string | null;
} {
  const fd = openSync(filePath, 'r');
  try {
    const magic = Buffer.alloc(3);
    if (readSync(fd, magic, 0, 3, 8) < 3)
      return {
        ok: false,
        detail: 'file too small for the AI marker at offset 8',
      };
    const markerType = magic.readUInt8(2);
    if (magic.readUInt8(0) !== 0x41 || magic.readUInt8(1) !== 0x49)
      return {
        ok: false,
        detail: `bad marker bytes 0x${magic
          .readUInt8(0)
          .toString(
            16,
          )} 0x${magic.readUInt8(1).toString(16)} at offset 8 (expected 'AI')`,
      };
    if (markerType === 0x02) {
      const elf = Buffer.alloc(4);
      if (readSync(fd, elf, 0, 4, 0) < 4)
        return { ok: false, detail: 'file too small for the ELF header' };
      if (elf.toString('latin1') !== '\x7fELF')
        return { ok: false, detail: 'no \\x7fELF magic at offset 0' };
      // The runtime is there — now the payload (see above).
      const squashfs = findSquashfsSuperblock(filePath);
      return squashfs.found
        ? { ok: true, detail: null }
        : {
            ok: false,
            detail: `no valid SquashFS superblock — ${squashfs.detail}`,
          };
    }
    if (markerType !== 0x01)
      return {
        ok: false,
        detail: `unknown AppImage type byte 0x${markerType.toString(16)}`,
      };
    const pvd = Buffer.alloc(5);
    if (readSync(fd, pvd, 0, 5, 32769) < 5)
      return {
        ok: false,
        detail: 'file too small for the ISO PVD at sector 16',
      };
    return pvd.toString('latin1') === 'CD001'
      ? { ok: true, detail: null }
      : { ok: false, detail: 'no CD001 PVD signature at offset 32769' };
  } finally {
    closeSync(fd);
  }
}

/** Boolean convenience wrapper around checkAppImage (unit tests). */
export function looksLikeAppImage(filePath: string): boolean {
  return checkAppImage(filePath).ok;
}

function dpkgDebAvailable(): boolean {
  try {
    execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 1. Contract: exactly the expected linux artifacts exist (non-empty),
  //    and any manifest present is consistent.
  const result = await verifyReleaseArtifactSet({
    directory: outputDirectory,
    version,
    platform: 'linux',
  });
  console.log(
    `Verified ${result.artifactNames.length} linux artifacts for v${version} in ${result.directory}`,
  );

  // 2. Contents: AppImage structure on every AppImage (marker +
  //    container +, for type 2, the appended filesystem).
  for (const name of result.artifactNames) {
    if (!name.endsWith('.AppImage')) continue;
    const filePath = path.join(outputDirectory, name);
    const check = checkAppImage(filePath);
    if (!check.ok)
      throw new Error(`${name} is not a valid AppImage: ${check.detail}`);
    console.log(
      `ok: ${name} (AppImage structure: marker + container + filesystem)`,
    );
  }

  // 3. Contents: dpkg structure on every .deb when dpkg-deb is available
  //    (ubuntu runners have it; elsewhere the check is skipped with a
  //    warning — presence + checksums are still verified above).
  const debNames = result.artifactNames.filter((name) => name.endsWith('.deb'));
  if (dpkgDebAvailable()) {
    for (const name of debNames) {
      const filePath = path.join(outputDirectory, name);
      const contents = execFileSync('dpkg-deb', ['-c', filePath], {
        encoding: 'utf8',
      });
      if (
        !/\/usr\/share\/applications\/[A-Za-z0-9._-]+\.desktop/.test(contents)
      )
        throw new Error(`${name} is missing its .desktop entry`);
      if (!/usr\/share\/icons\/hicolor\/256x256\/apps\//.test(contents)) {
        // Dump whatever icon entries DO exist so the CI log explains the
        // failure (size set wrong? different path? no icons at all?).
        const iconLines = contents
          .split('\n')
          .filter((line) => line.includes('/icons/'))
          .map((line) => line.trim())
          .join('\n    ');
        throw new Error(
          `${name} is missing its 256px icon.\n    Icon entries found in the deb:\n    ${iconLines || '(none)'}`,
        );
      }
      console.log(`ok: ${name} (dpkg -c: desktop entry + icon present)`);
    }
  } else {
    for (const name of debNames)
      console.log(`skip: ${name} (dpkg-deb no disponible en este host)`);
  }
}

// Entrypoint guard so the checks stay importable from tests (same
// pattern as package-electron.ts).
const entrypointPath = process.argv[1];
const isEntrypoint =
  entrypointPath !== undefined &&
  import.meta.url === pathToFileURL(entrypointPath).href;

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
