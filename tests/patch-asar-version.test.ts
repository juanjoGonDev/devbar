import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  patchAsarVersion,
  readAsarVersion,
} from '../src/dev/patch-asar-version.js';

/**
 * `src/dev/patch-asar-version.ts` edits a packaged `app.asar` IN PLACE, without
 * repacking it: an asar is a header of offsets followed by a payload, so any
 * change in length would move every file after it. These tests build real
 * little archives and assert the two invariants that keeps: the file's bytes
 * outside the patched slot never move, and the header re-serialises to exactly
 * the length it had.
 */
interface AsarFile {
  name: string;
  content: string;
  integrityBlocks?: number;
}

/**
 * Write a minimal but genuine asar. The four leading UInt32s are the pickle
 * framing electron reads: 4, then the sizes that put the JSON header at byte
 * 16 and the payload right after its 4-byte-aligned end.
 */
function writeAsar(target: string, files: AsarFile[]): void {
  const entries: Record<string, unknown> = {};
  let offset = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content);
    const entry: Record<string, unknown> = { size, offset: String(offset) };
    if (file.integrityBlocks) {
      const hash = createHash('sha256')
        .update(Buffer.from(file.content))
        .digest('hex');
      entry['integrity'] = {
        hash,
        blocks: Array.from({ length: file.integrityBlocks }, () => hash),
      };
    }
    entries[file.name] = entry;
    offset += size;
  }
  const header = JSON.stringify({ files: entries });
  const headerLength = Buffer.byteLength(header);
  const padded = Math.ceil(headerLength / 4) * 4;

  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(padded + 8, 4);
  prefix.writeUInt32LE(padded + 4, 8);
  prefix.writeUInt32LE(headerLength, 12);

  const headerBuf = Buffer.alloc(padded);
  headerBuf.write(header, 0, 'utf8');
  fs.writeFileSync(
    target,
    Buffer.concat([
      prefix,
      headerBuf,
      Buffer.from(files.map((file) => file.content).join(''), 'utf8'),
    ]),
  );
}

/** A pretty-printed package.json, padded so a minified one has room. */
function packageJson(version: string, extra = ''): string {
  return JSON.stringify(
    { name: 'devbar', version, main: 'main.js', extra },
    null,
    2,
  );
}

function readHeaderBytes(asarPath: string): Buffer {
  const file = fs.readFileSync(asarPath);
  return file.subarray(16, 16 + file.readUInt32LE(12));
}

interface AsarHeader {
  files: Record<
    string,
    { size: number; integrity?: { hash: string; blocks: string[] } }
  >;
}

function headerOf(asarPath: string): AsarHeader {
  return JSON.parse(readHeaderBytes(asarPath).toString('utf8')) as AsarHeader;
}

describe('src/dev/patch-asar-version.ts', () => {
  let dir: string;
  let asar: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-asar-'));
    asar = path.join(dir, 'app.asar');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('readAsarVersion', () => {
    it('reports what a packaged app would claim for itself', () => {
      writeAsar(asar, [
        { name: 'package.json', content: packageJson('1.2.3') },
      ]);
      expect(readAsarVersion(asar)).toBe('1.2.3');
    });

    it('finds the entry past the files stored before it', () => {
      writeAsar(asar, [
        { name: 'main.js', content: 'console.log("hola");' },
        { name: 'package.json', content: packageJson('4.5.6') },
      ]);
      expect(readAsarVersion(asar)).toBe('4.5.6');
    });

    it('refuses an archive with no package.json at the root', () => {
      writeAsar(asar, [{ name: 'main.js', content: 'x' }]);
      expect(() => readAsarVersion(asar)).toThrow(
        'el asar no tiene package.json en la raíz',
      );
    });
  });

  describe('patchAsarVersion', () => {
    it('moves the version the app reads for itself', () => {
      writeAsar(asar, [
        { name: 'package.json', content: packageJson('1.2.3') },
      ]);
      patchAsarVersion(asar, '9.9.9');
      expect(readAsarVersion(asar)).toBe('9.9.9');
    });

    it('keeps every other field of the manifest', () => {
      writeAsar(asar, [
        { name: 'package.json', content: packageJson('1.2.3') },
      ]);
      patchAsarVersion(asar, '9.9.9');
      const file = fs.readFileSync(asar);
      const entry = headerOf(asar).files['package.json'];
      const slot = file.subarray(file.length - (entry?.size ?? 0));
      expect(JSON.parse(slot.toString('utf8'))).toEqual({
        name: 'devbar',
        version: '9.9.9',
        main: 'main.js',
        extra: '',
      });
    });

    it('moves nothing: same file length, same bytes for its neighbours', () => {
      // Nothing is repacked, so a change in length would shift every file
      // stored after this one out from under its own offset.
      writeAsar(asar, [
        { name: 'package.json', content: packageJson('1.2.3') },
        { name: 'main.js', content: 'console.log("no me toques");' },
      ]);
      const before = fs.readFileSync(asar);
      patchAsarVersion(asar, '9.9.9');
      const after = fs.readFileSync(asar);
      expect(after.length).toBe(before.length);
      const tail = 'console.log("no me toques");'.length;
      expect(after.subarray(after.length - tail).toString('utf8')).toBe(
        'console.log("no me toques");',
      );
    });

    it('pads the slot so its declared size still holds', () => {
      writeAsar(asar, [
        { name: 'package.json', content: packageJson('1.2.3') },
      ]);
      const declared = headerOf(asar).files['package.json']?.size ?? 0;
      patchAsarVersion(asar, '9.9.9');
      const file = fs.readFileSync(asar);
      const slot = file.subarray(file.length - declared);
      expect(slot).toHaveLength(declared);
      // JSON ignores trailing whitespace, which is what leaves room to pad.
      expect(slot.toString('utf8')).toMatch(/ $/u);
    });

    it('hands back the hash of the header it wrote', () => {
      // Info.plist's ElectronAsarIntegrity claims exactly this, so the caller
      // can keep the bundle's own claim about the archive true.
      writeAsar(asar, [
        {
          name: 'package.json',
          content: packageJson('1.2.3'),
          integrityBlocks: 1,
        },
      ]);
      const returned = patchAsarVersion(asar, '9.9.9');
      expect(returned).toMatch(/^[0-9a-f]{64}$/u);
      expect(returned).toBe(
        createHash('sha256').update(readHeaderBytes(asar)).digest('hex'),
      );
    });

    it('reseals the entry so the patched bytes are what it vouches for', () => {
      writeAsar(asar, [
        {
          name: 'package.json',
          content: packageJson('1.2.3'),
          integrityBlocks: 1,
        },
      ]);
      const stale = headerOf(asar).files['package.json']?.integrity?.blocks[0];
      patchAsarVersion(asar, '9.9.9');
      const integrity = headerOf(asar).files['package.json']?.integrity;
      const file = fs.readFileSync(asar);
      const declared = headerOf(asar).files['package.json']?.size ?? 0;
      const slot = file.subarray(file.length - declared);
      const fresh = createHash('sha256').update(slot).digest('hex');
      expect(integrity?.hash).toBe(fresh);
      expect(integrity?.blocks).toEqual([fresh]);
      expect(fresh).not.toBe(stale);
    });

    it('leaves an older bundle that claims nothing alone', () => {
      writeAsar(asar, [
        { name: 'package.json', content: packageJson('1.2.3') },
      ]);
      patchAsarVersion(asar, '9.9.9');
      expect(headerOf(asar).files['package.json']?.integrity).toBeUndefined();
    });

    it('refuses an archive with no package.json at the root', () => {
      writeAsar(asar, [{ name: 'main.js', content: 'x' }]);
      expect(() => patchAsarVersion(asar, '9.9.9')).toThrow(
        'el asar no tiene package.json en la raíz',
      );
    });

    it('refuses to overflow the slot it has to write back into', () => {
      // A manifest already at its minimum has no whitespace left to spend.
      writeAsar(asar, [
        { name: 'package.json', content: '{"version":"1.2.3"}' },
      ]);
      expect(() => patchAsarVersion(asar, '10.20.30-rc.1')).toThrow(
        'el package.json parcheado no cabe en su hueco',
      );
    });

    it('refuses when resealing would change the header length', () => {
      // One block per 4 MB, and a package.json is always the first and only
      // one — an archive claiming more would re-serialise shorter.
      writeAsar(asar, [
        {
          name: 'package.json',
          content: packageJson('1.2.3'),
          integrityBlocks: 2,
        },
      ]);
      expect(() => patchAsarVersion(asar, '9.9.9')).toThrow(
        'el header del asar cambió de tamaño',
      );
    });

    it('leaves the archive readable after a refusal', () => {
      writeAsar(asar, [
        {
          name: 'package.json',
          content: packageJson('1.2.3'),
          integrityBlocks: 2,
        },
      ]);
      expect(() => patchAsarVersion(asar, '9.9.9')).toThrow();
      expect(readAsarVersion(asar)).toBe('1.2.3');
    });
  });
});
