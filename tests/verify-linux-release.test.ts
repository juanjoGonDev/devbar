import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkAppImage,
  looksLikeAppImage,
} from '../scripts/verify-linux-release.js';

const temporaryDirectories: string[] = [];

async function writeFixture(name: string, contents: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devbar-verify-linux-'));
  temporaryDirectories.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents);
  return filePath;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** 16-byte ELF ident with the AppImage marker embedded at offset 8
 *  (the ELF ident padding, where the spec puts it). */
function elfIdent(typeByte: number): Buffer {
  const ident = Buffer.alloc(16);
  ident[0] = 0x7f;
  ident[1] = 0x45; // 'E'
  ident[2] = 0x4c; // 'L'
  ident[3] = 0x46; // 'F'
  ident[8] = 0x41; // 'A'
  ident[9] = 0x49; // 'I'
  ident[10] = typeByte;
  return ident;
}

/** A structurally valid 96-byte SquashFS superblock (128 KiB blocks,
 *  gzip) unless a field is overridden — overrides build INCONSISTENT
 *  blocks, which must not count. */
function superblock(
  overrides: {
    blockSize?: number;
    blockLog?: number;
    compressionId?: number;
  } = {},
): Buffer {
  const sb = Buffer.alloc(96);
  sb.write('hsqs', 0, 'latin1');
  sb.writeUInt32LE(overrides.blockSize ?? 131072, 8);
  sb.writeUInt16LE(overrides.blockLog ?? 17, 12);
  sb.writeUInt16LE(overrides.compressionId ?? 1, 16);
  return sb;
}

describe('looksLikeAppImage (scripts/verify-linux-release.ts)', () => {
  it('accepts a type-2 image: ELF + marker + valid appended superblock', async () => {
    const file = await writeFixture(
      'good.AppImage',
      Buffer.concat([
        elfIdent(0x02),
        Buffer.alloc(64, 0xab), // stand-in runtime payload
        superblock(),
        Buffer.alloc(32, 0),
      ]),
    );
    expect(looksLikeAppImage(file)).toBe(true);
  });

  it('accepts the AppImageKit-12 mksquashfs layout used by electron-builder', async () => {
    // The static mksquashfs bundled in the appimage-12.0.1 toolset
    // writes a NON-standard superblock: creation @ +8, block size
    // @ +12, compression @ +20, block log @ +22 (instead of the stock
    // block @ +8 / log @ +12). Layout-independent acceptance must
    // find the self-consistent pair (131072 == 2^17).
    const sb = Buffer.alloc(96);
    sb.write('hsqs', 0, 'latin1');
    sb.writeUInt32LE(112, 4); // mystery field observed in real builds
    sb.writeUInt32LE(1789677472, 8); // creation timestamp
    sb.writeUInt32LE(131072, 12); // block size
    sb.writeUInt16LE(1, 20); // gzip
    sb.writeUInt16LE(17, 22); // block log
    const file = await writeFixture(
      'appimagekit.AppImage',
      Buffer.concat([elfIdent(0x02), Buffer.alloc(64), sb]),
    );
    expect(looksLikeAppImage(file)).toBe(true);
  });

  it('rejects a truncated type-2 image (ELF + marker, no filesystem)', async () => {
    const file = await writeFixture(
      'truncated.AppImage',
      Buffer.concat([elfIdent(0x02), Buffer.alloc(64, 0xab)]),
    );
    expect(looksLikeAppImage(file)).toBe(false);
  });

  it('rejects a 16-byte marker-only blob', async () => {
    const file = await writeFixture('blob.AppImage', elfIdent(0x02));
    expect(looksLikeAppImage(file)).toBe(false);
  });

  it('does not trust a bare "hsqs" magic inside the runtime ELF', async () => {
    // "hsqs" with garbage fields (inconsistent block size/log, unknown
    // compression) — exactly what the runtime's own reader code looks
    // like: the magic must not be accepted without the fields.
    const spurious = Buffer.from('hsqs', 'latin1');
    const spuriousBlock = Buffer.concat([
      spurious,
      Buffer.from([0x78, 0x56, 0x34, 0x12]), // block size 0x12345678
      Buffer.from([0x05, 0x00]), // block log 5 (inconsistent)
      Buffer.from([0x63, 0x00]), // compression id 99
    ]);
    const file = await writeFixture(
      'spurious.AppImage',
      Buffer.concat([elfIdent(0x02), spuriousBlock, Buffer.alloc(64, 0xab)]),
    );
    expect(looksLikeAppImage(file)).toBe(false);
  });

  it('accepts the image when a valid superblock follows spurious magic', async () => {
    const spurious = Buffer.concat([
      Buffer.from('hsqs', 'latin1'),
      Buffer.alloc(14, 0), // garbage fields (zeroes are inconsistent)
    ]);
    const file = await writeFixture(
      'mixed.AppImage',
      Buffer.concat([elfIdent(0x02), spurious, Buffer.alloc(32), superblock()]),
    );
    expect(looksLikeAppImage(file)).toBe(true);
  });

  it('finds a superblock that straddles the 1 MiB scan boundary', async () => {
    const MiB = 1 << 20;
    const sbOffset = MiB - 5; // magic starts 5 bytes before the boundary
    const buffer = Buffer.alloc(sbOffset + 96 + 32);
    elfIdent(0x02).copy(buffer, 0);
    superblock().copy(buffer, sbOffset);
    const file = await writeFixture('boundary.AppImage', buffer);
    expect(looksLikeAppImage(file)).toBe(true);
  });

  it('accepts a type-1 image with a PVD signature at sector 16', async () => {
    const buffer = Buffer.alloc(32769 + 5);
    elfIdent(0x01).copy(buffer, 0); // (type 1 is not an ELF; the header
    buffer.write('CD001', 32769, 'latin1'); // bytes are not checked)
    const file = await writeFixture('iso.AppImage', buffer);
    expect(looksLikeAppImage(file)).toBe(true);
  });

  it('rejects a type-1 image without the PVD signature', async () => {
    const buffer = Buffer.alloc(32769 + 5);
    elfIdent(0x01).copy(buffer, 0);
    const file = await writeFixture('iso-broken.AppImage', buffer);
    expect(looksLikeAppImage(file)).toBe(false);
  });

  it('rejects an unknown marker type byte', async () => {
    const file = await writeFixture(
      'unknown.AppImage',
      Buffer.concat([elfIdent(0x03), superblock()]),
    );
    expect(looksLikeAppImage(file)).toBe(false);
  });

  it('rejects a type-2 file that is not an ELF at offset 0', async () => {
    // The marker + a perfectly valid superblock are not enough: the
    // runtime (ELF) itself is part of the type-2 contract.
    const header = Buffer.alloc(16);
    header[8] = 0x41; // 'A'
    header[9] = 0x49; // 'I'
    header[10] = 0x02;
    const file = await writeFixture(
      'noelf.AppImage',
      Buffer.concat([header, superblock()]),
    );
    expect(looksLikeAppImage(file)).toBe(false);
  });
});

describe('checkAppImage diagnostics (scripts/verify-linux-release.ts)', () => {
  it('accepts a valid image with no detail', async () => {
    const file = await writeFixture(
      'good.AppImage',
      Buffer.concat([elfIdent(0x02), Buffer.alloc(32), superblock()]),
    );
    const result = checkAppImage(file);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe(null);
  });

  it('explains a truncated image with the candidate fields', async () => {
    // ELF + marker, then a "hsqs" with inconsistent fields and no valid
    // superblock — the detail must point at the candidate and its
    // failing field so a real CI rejection is diagnosable.
    const bad = Buffer.concat([
      Buffer.from('hsqs', 'latin1'),
      Buffer.alloc(4), // creation time
      Buffer.alloc(4), // block size 0
      Buffer.from([0x11, 0x00]), // block log 17
      Buffer.from([0x01, 0x00]), // compression 1
      Buffer.alloc(82),
    ]);
    const file = await writeFixture(
      'truncated.AppImage',
      Buffer.concat([elfIdent(0x02), bad]),
    );
    const result = checkAppImage(file);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/size=\d+B/);
    expect(result.detail).toMatch(/block=0 log=17/);
    expect(result.detail).toMatch(/block 0 != 2\^17/);
  });

  it('explains a marker-only blob', async () => {
    const file = await writeFixture('blob.AppImage', elfIdent(0x02));
    const result = checkAppImage(file);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no valid SquashFS superblock/);
  });

  it('explains a non-ELF type-2 header', async () => {
    const header = Buffer.alloc(16);
    header[8] = 0x41;
    header[9] = 0x49;
    header[10] = 0x02;
    const file = await writeFixture(
      'noelf.AppImage',
      Buffer.concat([header, superblock()]),
    );
    const result = checkAppImage(file);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ELF magic/);
  });

  it('explains an unknown type byte', async () => {
    const file = await writeFixture('unknown.AppImage', elfIdent(0x03));
    const result = checkAppImage(file);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/unknown AppImage type byte/);
  });
});
