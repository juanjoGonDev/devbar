import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  artifactArchitecture,
  checkAppImage,
  ELF_MACHINE,
  looksLikeAppImage,
  main,
  type DpkgReader,
} from '../scripts/verify-linux-release.js';

const temporaryDirectories: string[] = [];

async function writeFixture(name: string, contents: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devbar-verify-linux-'));
  temporaryDirectories.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents);
  return filePath;
}

describe('scripts/verify-linux-release.ts', () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const dir = temporaryDirectories.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  /** 20-byte ELF header prefix: the 16-byte ident with the AppImage marker
   *  embedded at offset 8 (the ident padding, where the spec puts it),
   *  plus e_type/e_machine — e_machine (u16 LE at 0x12) is what pins the
   *  image to an architecture. */
  function elfIdent(typeByte: number, machine = ELF_MACHINE.x64): Buffer {
    const ident = Buffer.alloc(20);
    ident[0] = 0x7f;
    ident[1] = 0x45; // 'E'
    ident[2] = 0x4c; // 'L'
    ident[3] = 0x46; // 'F'
    ident[8] = 0x41; // 'A'
    ident[9] = 0x49; // 'I'
    ident[10] = typeByte;
    ident.writeUInt16LE(0x02, 0x10); // e_type = ET_EXEC
    ident.writeUInt16LE(machine, 0x12);
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
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(true);
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
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(true);
    });

    it('rejects a truncated type-2 image (ELF + marker, no filesystem)', async () => {
      const file = await writeFixture(
        'truncated.AppImage',
        Buffer.concat([elfIdent(0x02), Buffer.alloc(64, 0xab)]),
      );
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(false);
    });

    it('rejects a header-only blob (no appended filesystem)', async () => {
      const file = await writeFixture('blob.AppImage', elfIdent(0x02));
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(false);
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
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(false);
    });

    it('accepts the image when a valid superblock follows spurious magic', async () => {
      const spurious = Buffer.concat([
        Buffer.from('hsqs', 'latin1'),
        Buffer.alloc(14, 0), // garbage fields (zeroes are inconsistent)
      ]);
      const file = await writeFixture(
        'mixed.AppImage',
        Buffer.concat([
          elfIdent(0x02),
          spurious,
          Buffer.alloc(32),
          superblock(),
        ]),
      );
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(true);
    });

    it('finds a superblock that straddles the 1 MiB scan boundary', async () => {
      const MiB = 1 << 20;
      const sbOffset = MiB - 5; // magic starts 5 bytes before the boundary
      const buffer = Buffer.alloc(sbOffset + 96 + 32);
      elfIdent(0x02).copy(buffer, 0);
      superblock().copy(buffer, sbOffset);
      const file = await writeFixture('boundary.AppImage', buffer);
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(true);
    });

    it('accepts a type-1 image with a PVD signature at sector 16', async () => {
      const buffer = Buffer.alloc(32769 + 5);
      elfIdent(0x01).copy(buffer, 0); // (type 1 is not an ELF; the header
      buffer.write('CD001', 32769, 'latin1'); // bytes are not checked)
      const file = await writeFixture('iso.AppImage', buffer);
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(true);
    });

    it('rejects a type-1 image without the PVD signature', async () => {
      const buffer = Buffer.alloc(32769 + 5);
      elfIdent(0x01).copy(buffer, 0);
      const file = await writeFixture('iso-broken.AppImage', buffer);
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(false);
    });

    it('rejects an unknown marker type byte', async () => {
      const file = await writeFixture(
        'unknown.AppImage',
        Buffer.concat([elfIdent(0x03), superblock()]),
      );
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(false);
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
      expect(looksLikeAppImage(file, ELF_MACHINE.x64)).toBe(false);
    });
  });

  describe('checkAppImage diagnostics (scripts/verify-linux-release.ts)', () => {
    it('accepts a valid image with no detail', async () => {
      const file = await writeFixture(
        'good.AppImage',
        Buffer.concat([elfIdent(0x02), Buffer.alloc(32), superblock()]),
      );
      const result = checkAppImage(file, ELF_MACHINE.x64);
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
      const result = checkAppImage(file, ELF_MACHINE.x64);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/size=\d+B/);
      expect(result.detail).toMatch(/block=0 log=17/);
      expect(result.detail).toMatch(/block 0 != 2\^17/);
    });

    it('explains a header-only blob', async () => {
      const file = await writeFixture('blob.AppImage', elfIdent(0x02));
      const result = checkAppImage(file, ELF_MACHINE.x64);
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
      const result = checkAppImage(file, ELF_MACHINE.x64);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/ELF magic/);
    });

    it('explains an unknown type byte', async () => {
      const file = await writeFixture('unknown.AppImage', elfIdent(0x03));
      const result = checkAppImage(file, ELF_MACHINE.x64);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/unknown AppImage type byte/);
    });
  });

  describe('AppImage architecture gate (ELF e_machine)', () => {
    const validImage = (machine: number): Buffer =>
      Buffer.concat([elfIdent(0x02, machine), Buffer.alloc(32), superblock()]);

    it('accepts each architecture against its own e_machine', async () => {
      for (const [architecture, machine] of Object.entries(ELF_MACHINE)) {
        const file = await writeFixture(
          `DevBar-1.0.0-linux-${architecture}.AppImage`,
          validImage(machine),
        );
        expect(looksLikeAppImage(file, machine), architecture).toBe(true);
      }
    });

    it('rejects an x64 binary shipped under the arm64 artifact name', async () => {
      // The regression: format alone accepts it — only e_machine tells the
      // two apart, and only the x64 artifact is ever smoke-launched in CI.
      const file = await writeFixture(
        'DevBar-1.0.0-linux-arm64.AppImage',
        validImage(ELF_MACHINE.x64),
      );
      const result = checkAppImage(file, ELF_MACHINE.arm64);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('ELF e_machine 0x3e');
      expect(result.detail).toContain('expected 0xb7');
    });

    it('rejects an armv7 binary shipped under the arm64 artifact name', async () => {
      const file = await writeFixture(
        'DevBar-1.0.0-linux-arm64.AppImage',
        validImage(ELF_MACHINE.armv7),
      );
      expect(looksLikeAppImage(file, ELF_MACHINE.arm64)).toBe(false);
    });

    it('rejects a file truncated before e_machine', async () => {
      const file = await writeFixture(
        'short.AppImage',
        elfIdent(0x02).subarray(0, 18),
      );
      const result = checkAppImage(file, ELF_MACHINE.x64);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('e_machine');
    });
  });

  describe('artifactArchitecture', () => {
    it.each([
      ['DevBar-1.0.0-linux-x64.AppImage', 'x64'],
      ['DevBar-1.0.0-linux-arm64.AppImage', 'arm64'],
      ['DevBar-1.0.0-linux-armv7.AppImage', 'armv7'],
      ['DevBar-1.0.0-linux-x64.deb', 'x64'],
      ['DevBar-1.0.0-linux-armv7.deb', 'armv7'],
    ])('reads %s as %s', (name, architecture) => {
      expect(artifactArchitecture(name)).toBe(architecture);
    });

    it('refuses a name carrying no linux architecture segment', () => {
      expect(() => artifactArchitecture('DevBar-1.0.0-macos-x64.dmg')).toThrow(
        'cannot determine architecture from DevBar-1.0.0-macos-x64.dmg',
      );
    });

    it('refuses an architecture outside the release contract', () => {
      expect(() =>
        artifactArchitecture('DevBar-1.0.0-linux-riscv64.deb'),
      ).toThrow('cannot determine architecture from');
    });
  });

  describe('main', () => {
    const VERSION = '1.0.0';
    /** Debian `Architecture:` value a correctly built package declares. */
    const DEB_ARCHITECTURE: Record<string, string> = {
      x64: 'amd64',
      arm64: 'arm64',
      armv7: 'armhf',
    };
    const DESKTOP_ENTRY =
      '-rw-r--r-- root/root 231 2024-01-01 00:00 ./usr/share/applications/devbar.desktop\n';
    const ICON_256 =
      '-rw-r--r-- root/root 918 2024-01-01 00:00 ./usr/share/icons/hicolor/256x256/apps/devbar.png\n';
    const ICON_128 =
      '-rw-r--r-- root/root 412 2024-01-01 00:00 ./usr/share/icons/hicolor/128x128/apps/devbar.png\n';
    const DEB_LISTING = `${DESKTOP_ENTRY}${ICON_256}`;

    function declaredArchitecture(artifact: string): string {
      const architecture =
        /-linux-([a-z0-9]+)\.deb$/u.exec(artifact)?.[1] ?? '';
      return DEB_ARCHITECTURE[architecture] ?? '';
    }

    /**
     * A complete linux artifact set: an AppImage valid for its own
     * architecture plus a non-empty .deb per architecture. `overrides`
     * replaces one artifact's bytes by name.
     */
    async function artifactSet(
      overrides: Record<string, Buffer> = {},
    ): Promise<string> {
      const directory = await mkdtemp(path.join(tmpdir(), 'devbar-linux-set-'));
      temporaryDirectories.push(directory);
      for (const [architecture, machine] of Object.entries(ELF_MACHINE)) {
        const image = `DevBar-${VERSION}-linux-${architecture}.AppImage`;
        const deb = `DevBar-${VERSION}-linux-${architecture}.deb`;
        await writeFile(
          path.join(directory, image),
          overrides[image] ??
            Buffer.concat([
              elfIdent(0x02, machine),
              Buffer.alloc(32),
              superblock(),
            ]),
        );
        await writeFile(
          path.join(directory, deb),
          overrides[deb] ?? Buffer.from('!<arch>\ndebian-binary', 'latin1'),
        );
      }
      return directory;
    }

    interface DpkgCall {
      operation: string;
      artifact: string;
      field?: string;
    }

    /** A dpkg-deb stand-in that records what main() asked it for. */
    function recordingDpkg(
      options: {
        available?: boolean;
        architectureOf?: (artifact: string) => string;
        listingOf?: (artifact: string) => string;
      } = {},
    ): { calls: DpkgCall[]; reader: DpkgReader } {
      const calls: DpkgCall[] = [];
      const reader: DpkgReader = {
        available: () => options.available ?? true,
        field: (filePath, fieldName) => {
          const artifact = path.basename(filePath);
          calls.push({ operation: 'field', artifact, field: fieldName });
          return (options.architectureOf ?? declaredArchitecture)(artifact);
        },
        contents: (filePath) => {
          const artifact = path.basename(filePath);
          calls.push({ operation: 'contents', artifact });
          return (options.listingOf ?? (() => DEB_LISTING))(artifact);
        },
      };
      return { calls, reader };
    }

    function captureLogs(): string[] {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
      });
      return lines;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('verifies every AppImage and .deb of a complete set', async () => {
      const directory = await artifactSet();
      const { calls, reader } = recordingDpkg();
      const lines = captureLogs();

      await main({ directory, version: VERSION, dpkg: reader });

      expect(lines[0]).toBe(
        `Verified 6 linux artifacts for v1.0.0 in ${directory}`,
      );
      expect(lines.slice(1)).toEqual([
        'ok: DevBar-1.0.0-linux-x64.AppImage (AppImage structure: marker + container + filesystem, ELF x64)',
        'ok: DevBar-1.0.0-linux-arm64.AppImage (AppImage structure: marker + container + filesystem, ELF arm64)',
        'ok: DevBar-1.0.0-linux-armv7.AppImage (AppImage structure: marker + container + filesystem, ELF armv7)',
        'ok: DevBar-1.0.0-linux-x64.deb (dpkg -c: desktop entry + icon present, Architecture: amd64)',
        'ok: DevBar-1.0.0-linux-arm64.deb (dpkg -c: desktop entry + icon present, Architecture: arm64)',
        'ok: DevBar-1.0.0-linux-armv7.deb (dpkg -c: desktop entry + icon present, Architecture: armhf)',
      ]);
      expect(calls).toEqual([
        {
          operation: 'field',
          artifact: 'DevBar-1.0.0-linux-x64.deb',
          field: 'Architecture',
        },
        { operation: 'contents', artifact: 'DevBar-1.0.0-linux-x64.deb' },
        {
          operation: 'field',
          artifact: 'DevBar-1.0.0-linux-arm64.deb',
          field: 'Architecture',
        },
        { operation: 'contents', artifact: 'DevBar-1.0.0-linux-arm64.deb' },
        {
          operation: 'field',
          artifact: 'DevBar-1.0.0-linux-armv7.deb',
          field: 'Architecture',
        },
        { operation: 'contents', artifact: 'DevBar-1.0.0-linux-armv7.deb' },
      ]);
    });

    it('rejects an AppImage built for an architecture its name does not promise', async () => {
      const directory = await artifactSet({
        [`DevBar-${VERSION}-linux-arm64.AppImage`]: Buffer.concat([
          elfIdent(0x02, ELF_MACHINE.x64),
          Buffer.alloc(32),
          superblock(),
        ]),
      });
      captureLogs();

      await expect(
        main({ directory, version: VERSION, dpkg: recordingDpkg().reader }),
      ).rejects.toThrow(
        /^DevBar-1\.0\.0-linux-arm64\.AppImage is not a valid arm64 AppImage: ELF e_machine 0x3e/u,
      );
    });

    it('rejects a .deb that declares another architecture', async () => {
      const directory = await artifactSet();
      const { reader } = recordingDpkg({
        architectureOf: (artifact) =>
          artifact.includes('-x64.') ? 'i386' : declaredArchitecture(artifact),
      });
      captureLogs();

      await expect(
        main({ directory, version: VERSION, dpkg: reader }),
      ).rejects.toThrow(
        'DevBar-1.0.0-linux-x64.deb declares Architecture: i386, expected amd64',
      );
    });

    it('reports an absent Architecture field as <missing>', async () => {
      const directory = await artifactSet();
      const { reader } = recordingDpkg({ architectureOf: () => '' });
      captureLogs();

      await expect(
        main({ directory, version: VERSION, dpkg: reader }),
      ).rejects.toThrow(
        'DevBar-1.0.0-linux-x64.deb declares Architecture: <missing>, expected amd64',
      );
    });

    it('rejects a .deb without its .desktop entry', async () => {
      const directory = await artifactSet();
      const { reader } = recordingDpkg({ listingOf: () => ICON_256 });
      captureLogs();

      await expect(
        main({ directory, version: VERSION, dpkg: reader }),
      ).rejects.toThrow(
        'DevBar-1.0.0-linux-x64.deb is missing its .desktop entry',
      );
    });

    it('rejects a .deb whose only icon is the wrong size, listing what it found', async () => {
      const directory = await artifactSet();
      const { reader } = recordingDpkg({
        listingOf: () => `${DESKTOP_ENTRY}${ICON_128}`,
      });
      captureLogs();

      const failure = await main({
        directory,
        version: VERSION,
        dpkg: reader,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        'DevBar-1.0.0-linux-x64.deb is missing its 256px icon',
      );
      expect((failure as Error).message).toContain(
        './usr/share/icons/hicolor/128x128/apps/devbar.png',
      );
    });

    it('says (none) when the .deb carries no icon entries at all', async () => {
      const directory = await artifactSet();
      const { reader } = recordingDpkg({ listingOf: () => DESKTOP_ENTRY });
      captureLogs();

      const failure = await main({
        directory,
        version: VERSION,
        dpkg: reader,
      }).catch((error: unknown) => error);

      expect((failure as Error).message).toContain('missing its 256px icon');
      expect((failure as Error).message).toContain('(none)');
    });

    it('fails when dpkg-deb is unavailable and the check is required', async () => {
      const directory = await artifactSet();
      const { reader } = recordingDpkg({ available: false });
      captureLogs();

      await expect(
        main({ directory, version: VERSION, dpkg: reader, requireDpkg: true }),
      ).rejects.toThrow(
        'dpkg-deb is unavailable on this host, so the .deb content check cannot run: ' +
          'DevBar-1.0.0-linux-x64.deb, DevBar-1.0.0-linux-arm64.deb, DevBar-1.0.0-linux-armv7.deb',
      );
    });

    it('skips the .deb content check when dpkg-deb is unavailable and not required', async () => {
      const directory = await artifactSet();
      const { calls, reader } = recordingDpkg({ available: false });
      const lines = captureLogs();

      await main({ directory, version: VERSION, dpkg: reader });

      expect(calls).toEqual([]);
      expect(lines.filter((line) => line.startsWith('skip:'))).toEqual([
        'skip: DevBar-1.0.0-linux-x64.deb (dpkg-deb unavailable on this host)',
        'skip: DevBar-1.0.0-linux-arm64.deb (dpkg-deb unavailable on this host)',
        'skip: DevBar-1.0.0-linux-armv7.deb (dpkg-deb unavailable on this host)',
      ]);
    });

    it('fails before any content check when an expected artifact is missing', async () => {
      const directory = await artifactSet();
      await rm(path.join(directory, `DevBar-${VERSION}-linux-armv7.deb`));
      const { calls, reader } = recordingDpkg();
      const lines = captureLogs();

      await expect(
        main({ directory, version: VERSION, dpkg: reader }),
      ).rejects.toThrow('DevBar-1.0.0-linux-armv7.deb is missing or empty');
      expect(calls).toEqual([]);
      expect(lines).toEqual([]);
    });
  });
});
