import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { isEntrypoint } from './lib/script-runtime.ts';
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

const LINUX_ARCHITECTURES = ['x64', 'arm64', 'armv7'] as const;
type LinuxArchitecture = (typeof LINUX_ARCHITECTURES)[number];

/** ELF `e_machine` (EM_*) value each release architecture must declare. */
export const ELF_MACHINE: Record<LinuxArchitecture, number> = {
  x64: 0x3e, // EM_X86_64
  arm64: 0xb7, // EM_AARCH64
  armv7: 0x28, // EM_ARM
};

/** Debian control `Architecture:` value for each release architecture. */
const DEB_ARCHITECTURE: Record<LinuxArchitecture, string> = {
  x64: 'amd64',
  arm64: 'arm64',
  armv7: 'armhf',
};

/**
 * The architecture an artifact name PROMISES. The file contents are then
 * checked against it: format alone would accept an x64 binary shipped
 * under the arm64 name, and only the x64 artifacts are ever launched in
 * CI, so nothing downstream would catch the swap.
 */
function artifactArchitecture(name: string): LinuxArchitecture {
  const parsed = /-linux-(x64|arm64|armv7)\./.exec(name)?.[1];
  const architecture = LINUX_ARCHITECTURES.find((value) => value === parsed);
  if (architecture === undefined)
    throw new Error(`cannot determine architecture from ${name}`);
  return architecture;
}

/**
 * SquashFS superblock acceptance. The superblock MUST declare its data
 * block size and its log2, and both fields sit in the first 32 bytes
 * after the "hsqs" magic — but their exact offsets DIFFER between
 * mksquashfs variants:
 *   - stock layout:  block size (u32) @ +8,  block log (u16) @ +12
 *   - AppImageKit 12 static build (the one electron-builder bundles,
 *     appimage-12.0.1 toolset): creation @ +8, block size @ +12,
 *     compression @ +20, block log @ +22
 * Pinning one layout made the gate reject every real DevBar AppImage.
 * So a candidate is accepted when ANY self-consistent pair is present
 * in the first 32 bytes after the magic: a little-endian u32 equal to
 * 2^L at one offset, with the matching u16 L (12..20 => 4 KiB..1 MiB)
 * at another. That proves a real superblock (block size and log agree)
 * without depending on field positions; the runtime ELF's spurious
 * "hsqs" bytes (its embedded SquashFS reader code) satisfy this with
 * negligible probability (~3e-12 per candidate).
 */
const SQUASHFS_MAGIC = Buffer.from('hsqs', 'latin1');

function hasConsistentBlockPair(data: Buffer, at: number): boolean {
  const end = Math.min(at + 32, data.length);
  for (let logAt = at; logAt + 2 <= end; logAt += 1) {
    const blockLog = data.readUInt16LE(logAt);
    if (blockLog < 12 || blockLog > 20) continue;
    const blockSize = 2 ** blockLog;
    for (let blkAt = at; blkAt + 4 <= end; blkAt += 1) {
      if (data.readUInt32LE(blkAt) === blockSize) return true;
    }
  }
  return false;
}

/**
 * Standard-layout field read, for the REJECTION diagnostic only: it
 * shows what the stock offsets decode to so a future layout drift is
 * visible in the CI failure message (hex dump included by the caller).
 */
function describeStandardFields(data: Buffer, at: number): string | null {
  if (at + 18 > data.length) return 'fields truncated at file end';
  const blockSize = data.readUInt32LE(at + 8);
  const blockLog = data.readUInt16LE(at + 12);
  const compressionId = data.readUInt16LE(at + 16);
  const logInRange = blockLog >= 12 && blockLog <= 20;
  const why = !logInRange
    ? `block log ${blockLog} out of range`
    : blockSize !== 2 ** blockLog
      ? `block ${blockSize} != 2^${blockLog}`
      : `compression ${compressionId} unknown`;
  return `block=${blockSize} log=${blockLog} comp=${compressionId} (stock ${why})`;
}

/**
 * True when the file carries an appended filesystem, i.e. contains a
 * "hsqs" candidate with a self-consistent block size/log pair (see
 * hasConsistentBlockPair). Images run 50–300 MiB, so the file is
 * scanned in 1 MiB chunks (a 31-byte carry keeps a candidate that
 * straddles a boundary searchable). When no candidate passes, returns
 * a diagnostic (size, candidate count, first candidates with fields
 * and raw hex), so a CI failure says WHY a real-looking image was
 * rejected.
 */
function findSquashfsSuperblock(filePath: string): {
  found: boolean;
  detail: string | null;
} {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.alloc(1 << 20);
    const CARRY = 31; // the pair check reads 32 bytes past the magic
    let offset = 0;
    let carry = Buffer.alloc(0);
    let totalCandidates = 0;
    const firstSamples: string[] = [];
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
        if (hasConsistentBlockPair(data, at))
          return { found: true, detail: null };
        const fileAt = offset - (data.length - n) + at;
        const hex = data
          .subarray(at, Math.min(at + 48, data.length))
          .toString('hex');
        const sample = `@${fileAt} ${describeStandardFields(data, at)} hex=${hex}`;
        if (firstSamples.length < 3) firstSamples.push(sample);
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
      (firstSamples.length > 0
        ? `, first: ${firstSamples.join('; ')}`
        : ' (none)') +
      ', no candidate carries a self-consistent block size/log pair';
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
export function checkAppImage(
  filePath: string,
  expectedMachine: number,
): {
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
      // e_machine (u16 LE at 0x12) is the only field that distinguishes
      // an x64 runtime from an arm64/armv7 one, so without it a binary
      // built for the wrong CPU passes under the architecture its
      // artifact name claims.
      const machine = Buffer.alloc(2);
      if (readSync(fd, machine, 0, 2, 0x12) < 2)
        return { ok: false, detail: 'file too small for the ELF e_machine' };
      const declaredMachine = machine.readUInt16LE(0);
      if (declaredMachine !== expectedMachine)
        return {
          ok: false,
          detail: `ELF e_machine 0x${declaredMachine.toString(16)} at offset 0x12, expected 0x${expectedMachine.toString(16)}`,
        };
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
export function looksLikeAppImage(
  filePath: string,
  expectedMachine: number,
): boolean {
  return checkAppImage(filePath, expectedMachine).ok;
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
  //    container +, for type 2, the appended filesystem) AND the
  //    architecture its name promises.
  for (const name of result.artifactNames) {
    if (!name.endsWith('.AppImage')) continue;
    const architecture = artifactArchitecture(name);
    const filePath = path.join(outputDirectory, name);
    const check = checkAppImage(filePath, ELF_MACHINE[architecture]);
    if (!check.ok)
      throw new Error(
        `${name} is not a valid ${architecture} AppImage: ${check.detail}`,
      );
    console.log(
      `ok: ${name} (AppImage structure: marker + container + filesystem, ELF ${architecture})`,
    );
  }

  // 3. Contents: dpkg structure on every .deb when dpkg-deb is available
  //    (ubuntu runners have it; elsewhere the check is skipped with a
  //    warning — presence + checksums are still verified above).
  const debNames = result.artifactNames.filter((name) => name.endsWith('.deb'));
  if (dpkgDebAvailable()) {
    for (const name of debNames) {
      const architecture = artifactArchitecture(name);
      const filePath = path.join(outputDirectory, name);
      const declaredArchitecture = execFileSync(
        'dpkg-deb',
        ['-f', filePath, 'Architecture'],
        { encoding: 'utf8' },
      ).trim();
      const expectedArchitecture = DEB_ARCHITECTURE[architecture];
      if (declaredArchitecture !== expectedArchitecture)
        throw new Error(
          `${name} declares Architecture: ${declaredArchitecture || '<missing>'}, expected ${expectedArchitecture}`,
        );
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
      console.log(
        `ok: ${name} (dpkg -c: desktop entry + icon present, Architecture: ${declaredArchitecture})`,
      );
    }
  } else if (debNames.length > 0) {
    // dpkg-deb is the ONLY structural check on the .deb: skipping it
    // turns a broken package into a green release job, so on CI the
    // missing (or unusable) tool is an error, not a log line.
    const reason = `dpkg-deb is unavailable on this host, so the .deb content check cannot run: ${debNames.join(', ')}`;
    if (process.env.CI) throw new Error(reason);
    for (const name of debNames)
      console.log(`skip: ${name} (dpkg-deb unavailable on this host)`);
  }
}

// Entrypoint guard so the checks stay importable from tests (same
// pattern as package-electron.ts).
if (isEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // On CI, mirror the failure into the job annotations: the Checks UI
    // shows it without opening logs, and it is readable via the
    // check-runs annotations API.
    if (process.env.GITHUB_ACTIONS) console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
