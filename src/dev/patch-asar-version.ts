import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Rewrite the version inside a packaged `app.asar`, in place.
 *
 * This exists because `app.getVersion()` reads the app's own package.json, not
 * `CFBundleShortVersionString`. A real release never notices — the packaging
 * script builds from a package.json that is already bumped, so the two agree —
 * but a simulated update built by editing an installed bundle has to move both
 * or it swaps in a build that still calls itself the old version.
 *
 * Nothing is repacked. An asar is a header of offsets followed by a payload,
 * so any change in length would move every file after it. Instead the new
 * package.json is minified and padded back to the exact byte count it had
 * (JSON ignores trailing whitespace), and the header — which re-serialises
 * byte-identically — only ever gets same-length hex swapped into it.
 */
export function patchAsarVersion(asarPath: string, version: string): string {
  const fd = fs.openSync(asarPath, 'r+');
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const headerLength = prefix.readUInt32LE(12);
    const payloadBase = 8 + prefix.readUInt32LE(4);

    const headerBuf = Buffer.alloc(headerLength);
    fs.readSync(fd, headerBuf, 0, headerLength, 16);
    const rawHeader = headerBuf.toString('utf8');
    const header = JSON.parse(rawHeader) as {
      files: Record<
        string,
        {
          size: number;
          offset: string;
          integrity?: { hash: string; blocks: string[] };
        }
      >;
    };

    const entry = header.files['package.json'];
    if (!entry) throw new Error('el asar no tiene package.json en la raíz');
    const at = payloadBase + Number(entry.offset);

    const current = Buffer.alloc(entry.size);
    fs.readSync(fd, current, 0, entry.size, at);
    const pkg = JSON.parse(current.toString('utf8')) as Record<
      string,
      unknown
    > & { version: string };
    pkg.version = version;

    // Minified is comfortably shorter than the pretty-printed original, which
    // is what leaves room to pad back to the same byte count.
    const minified = JSON.stringify(pkg);
    if (Buffer.byteLength(minified) > entry.size)
      throw new Error('el package.json parcheado no cabe en su hueco');
    const replacement = Buffer.alloc(entry.size, ' ');
    replacement.write(minified, 0, 'utf8');

    if (entry.integrity) {
      const hash = createHash('sha256').update(replacement).digest('hex');
      entry.integrity.hash = hash;
      // One block per 4 MB; a package.json is always the first and only one.
      entry.integrity.blocks = [hash];
    }

    const nextHeader = JSON.stringify(header);
    if (Buffer.byteLength(nextHeader) !== headerLength)
      throw new Error('el header del asar cambió de tamaño');

    fs.writeSync(fd, Buffer.from(nextHeader, 'utf8'), 0, headerLength, 16);
    fs.writeSync(fd, replacement, 0, entry.size, at);

    // What Info.plist's ElectronAsarIntegrity covers, so the caller can keep
    // the bundle's own claim about this archive true.
    return createHash('sha256')
      .update(Buffer.from(nextHeader, 'utf8'))
      .digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/** What a packaged app would report for itself — the claim that has to move. */
export function readAsarVersion(asarPath: string): string {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const headerBuf = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 16);
    const header = JSON.parse(headerBuf.toString('utf8')) as {
      files: Record<string, { size: number; offset: string }>;
    };
    const entry = header.files['package.json'];
    if (!entry) throw new Error('el asar no tiene package.json en la raíz');
    const buf = Buffer.alloc(entry.size);
    fs.readSync(
      fd,
      buf,
      0,
      entry.size,
      8 + prefix.readUInt32LE(4) + Number(entry.offset),
    );
    return (JSON.parse(buf.toString('utf8')) as { version: string }).version;
  } finally {
    fs.closeSync(fd);
  }
}
