import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  looksLikeWindowsExe,
  PE_MACHINE,
} from '../scripts/verify-win-release.js';

const temporaryDirectories: string[] = [];

async function writeFixture(name: string, contents: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devbar-verify-win-'));
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

/**
 * Minimal 70-byte PE: 64-byte DOS header (MZ + e_lfanew → 64) followed
 * by the PE signature and the 2-byte COFF Machine field.
 */
function peFixture(machine: number, peOffset = 64): Buffer {
  const buf = Buffer.alloc(peOffset + 6);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'latin1');
  buf.writeUInt16LE(machine, peOffset + 4);
  return buf;
}

describe('PE_MACHINE', () => {
  it('carries the COFF machine codes for the release architectures', () => {
    expect(PE_MACHINE.x64).toBe(0x8664); // IMAGE_FILE_MACHINE_AMD64
    expect(PE_MACHINE.arm64).toBe(0xaa64); // IMAGE_FILE_MACHINE_ARM64
  });
});

describe('looksLikeWindowsExe', () => {
  it('accepts an exe whose Machine field matches the expected architecture', async () => {
    const x64 = await writeFixture('x64.exe', peFixture(PE_MACHINE.x64));
    const arm64 = await writeFixture('arm64.exe', peFixture(PE_MACHINE.arm64));
    expect(looksLikeWindowsExe(x64, PE_MACHINE.x64)).toBe(true);
    expect(looksLikeWindowsExe(arm64, PE_MACHINE.arm64)).toBe(true);
  });

  it('rejects a VALID exe of the wrong architecture', async () => {
    // The regression: an x64 installer shipped as the arm64 artifact is
    // structurally a perfect PE — only the Machine field tells them
    // apart, and nothing else in the pipeline would catch it.
    const x64 = await writeFixture('x64.exe', peFixture(PE_MACHINE.x64));
    const arm64 = await writeFixture('arm64.exe', peFixture(PE_MACHINE.arm64));
    expect(looksLikeWindowsExe(x64, PE_MACHINE.arm64)).toBe(false);
    expect(looksLikeWindowsExe(arm64, PE_MACHINE.x64)).toBe(false);
  });

  it('rejects a file with MZ but no PE signature at e_lfanew', async () => {
    const buf = peFixture(PE_MACHINE.x64);
    buf.write('XXXX', 64, 'latin1'); // clobber the PE signature
    const filePath = await writeFixture('broken.exe', buf);
    expect(looksLikeWindowsExe(filePath, PE_MACHINE.x64)).toBe(false);
  });

  it('rejects a garbage e_lfanew pointing past EOF', async () => {
    const buf = peFixture(PE_MACHINE.x64);
    buf.writeUInt32LE(0x7fffffff, 0x3c);
    const filePath = await writeFixture('garbage.exe', buf);
    expect(looksLikeWindowsExe(filePath, PE_MACHINE.x64)).toBe(false);
  });

  it('rejects a truncated PE header (signature present, Machine missing)', async () => {
    // The PE header sits at the very end of the file: the 4-byte
    // signature reads, but the Machine field is past EOF.
    const buf = Buffer.alloc(64 + 4);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(64, 0x3c);
    buf.write('PE\0\0', 64, 'latin1');
    const filePath = await writeFixture('truncated.exe', buf);
    expect(looksLikeWindowsExe(filePath, PE_MACHINE.x64)).toBe(false);
  });

  it('rejects non-PE files (HTML error page, short file)', async () => {
    const html = await writeFixture(
      'page.html',
      Buffer.from('<html>502 Bad Gateway</html>'),
    );
    expect(looksLikeWindowsExe(html, PE_MACHINE.x64)).toBe(false);
    const short = await writeFixture('short.bin', Buffer.from('MZ'));
    expect(looksLikeWindowsExe(short, PE_MACHINE.x64)).toBe(false);
  });
});
