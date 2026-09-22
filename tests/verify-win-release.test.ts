import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { looksLikeWindowsExe, main } from '../scripts/verify-win-release.js';

const temporaryDirectories: string[] = [];

async function writeFixture(name: string, contents: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devbar-verify-win-'));
  temporaryDirectories.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents);
  return filePath;
}

describe('scripts/verify-win-release.ts', () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const dir = temporaryDirectories.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Minimal PE: 64-byte DOS header (MZ + e_lfanew → peOffset) followed by
   * the PE signature. The check is deliberately architecture-independent —
   * both win targets are NSIS stubs, PE32 for every target arch.
   */
  function peFixture(peOffset = 64): Buffer {
    const buf = Buffer.alloc(peOffset + 4);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(peOffset, 0x3c);
    buf.write('PE\0\0', peOffset, 'latin1');
    return buf;
  }

  describe('looksLikeWindowsExe', () => {
    it('accepts a PE with the signature at e_lfanew', async () => {
      const filePath = await writeFixture('setup.exe', peFixture());
      expect(looksLikeWindowsExe(filePath)).toBe(true);
    });

    it('rejects a file with MZ but no PE signature at e_lfanew', async () => {
      const buf = peFixture();
      buf.write('XXXX', 64, 'latin1'); // clobber the PE signature
      const filePath = await writeFixture('broken.exe', buf);
      expect(looksLikeWindowsExe(filePath)).toBe(false);
    });

    it('rejects a garbage e_lfanew pointing past EOF', async () => {
      const buf = peFixture();
      buf.writeUInt32LE(0x7fffffff, 0x3c);
      const filePath = await writeFixture('garbage.exe', buf);
      expect(looksLikeWindowsExe(filePath)).toBe(false);
    });

    it('rejects non-PE files (HTML error page, short file)', async () => {
      const html = await writeFixture(
        'page.html',
        Buffer.from('<html>502 Bad Gateway</html>'),
      );
      expect(looksLikeWindowsExe(html)).toBe(false);
      const short = await writeFixture('short.bin', Buffer.from('MZ'));
      expect(looksLikeWindowsExe(short)).toBe(false);
    });
  });

  describe('main', () => {
    const VERSION = '1.0.0';
    const WIN_ARTIFACTS = [
      `DevBar-${VERSION}-win-x64-setup.exe`,
      `DevBar-${VERSION}-win-x64-portable.exe`,
      `DevBar-${VERSION}-win-arm64-setup.exe`,
      `DevBar-${VERSION}-win-arm64-portable.exe`,
    ];

    /**
     * A complete win artifact set, every file a real PE. `overrides`
     * replaces one artifact's bytes by name.
     */
    async function artifactSet(
      overrides: Record<string, Buffer> = {},
    ): Promise<string> {
      const directory = await mkdtemp(path.join(tmpdir(), 'devbar-win-set-'));
      temporaryDirectories.push(directory);
      for (const name of WIN_ARTIFACTS) {
        await writeFile(
          path.join(directory, name),
          overrides[name] ?? peFixture(),
        );
      }
      return directory;
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

    it('verifies every artifact of a complete set', async () => {
      const directory = await artifactSet();
      const lines = captureLogs();

      await main({ directory, version: VERSION });

      expect(lines[0]).toBe(
        `Verified 4 win artifacts for v1.0.0 in ${directory}`,
      );
      expect(lines.slice(1)).toEqual([
        'ok: DevBar-1.0.0-win-x64-setup.exe (MZ header)',
        'ok: DevBar-1.0.0-win-x64-portable.exe (MZ header)',
        'ok: DevBar-1.0.0-win-arm64-setup.exe (MZ header)',
        'ok: DevBar-1.0.0-win-arm64-portable.exe (MZ header)',
      ]);
    });

    it('rejects a set in which one artifact is not a PE executable', async () => {
      // A downloaded error page is non-empty, so the artifact-set contract
      // alone accepts it; only the PE check catches it.
      const directory = await artifactSet({
        [`DevBar-${VERSION}-win-arm64-portable.exe`]: Buffer.from(
          '<html>502 Bad Gateway</html>',
        ),
      });
      const lines = captureLogs();

      await expect(main({ directory, version: VERSION })).rejects.toThrow(
        'DevBar-1.0.0-win-arm64-portable.exe is not a valid Windows executable',
      );
      // The three artifacts before it were accepted, so the failure is the
      // per-file check and not an aborted set.
      expect(lines.slice(1)).toEqual([
        'ok: DevBar-1.0.0-win-x64-setup.exe (MZ header)',
        'ok: DevBar-1.0.0-win-x64-portable.exe (MZ header)',
        'ok: DevBar-1.0.0-win-arm64-setup.exe (MZ header)',
      ]);
    });

    it('fails before any content check when an expected artifact is missing', async () => {
      const directory = await artifactSet();
      await rm(path.join(directory, `DevBar-${VERSION}-win-arm64-setup.exe`));
      const lines = captureLogs();

      await expect(main({ directory, version: VERSION })).rejects.toThrow(
        'DevBar-1.0.0-win-arm64-setup.exe is missing or empty',
      );
      expect(lines).toEqual([]);
    });

    it('refuses a version that is not a stable release version', async () => {
      const directory = await artifactSet();

      await expect(main({ directory, version: '1.0.0-rc.1' })).rejects.toThrow(
        'Invalid stable release version: 1.0.0-rc.1',
      );
    });
  });
});
