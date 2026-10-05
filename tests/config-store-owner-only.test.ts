import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ONLY, restrictToOwner } from '../src/config-store/owner-only.js';

/**
 * The config file holds «Control remoto»'s identity seed as it is, so it is
 * kept readable and writable by its user only, like a key in ~/.ssh.
 */

describe('src/config-store/owner-only.ts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A file anyone on this computer can read, as conf used to write it. */
  function looseFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-owner-'));
    dirs.push(dir);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o644);
    return file;
  }

  it.skipIf(process.platform === 'win32')(
    'makes a file readable and writable by its user only',
    () => {
      const file = looseFile();

      restrictToOwner(file, 'darwin');

      expect(fs.statSync(file).mode & 0o777).toBe(OWNER_ONLY);
    },
  );

  it('leaves the file alone on Windows, where POSIX modes do not apply', () => {
    const file = looseFile();
    const chmod = vi.spyOn(fs, 'chmodSync');

    restrictToOwner(file, 'win32');

    expect(chmod).not.toHaveBeenCalled();
  });

  it('logs, and never throws, when the file cannot be changed', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const missing = path.join(os.tmpdir(), 'devbar-owner-missing', 'none.json');

    expect(() => restrictToOwner(missing, 'linux')).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(missing);
  });
});
