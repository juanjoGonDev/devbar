import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { absoluteEnvDir, isEntrypoint } from '../scripts/lib/script-runtime.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function withEnvVar<T>(
  name: string,
  value: string | undefined,
  fn: () => T,
): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function withArgv1<T>(value: string | undefined, fn: () => T): T {
  const previous = process.argv[1];
  if (value === undefined) process.argv.splice(1, 1);
  else process.argv[1] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) process.argv.splice(1, 1);
    else process.argv[1] = previous;
  }
}

describe('scripts/lib/script-runtime.ts', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  describe('absoluteEnvDir', () => {
    const fallback = path.join(path.sep, 'home', 'u', '.local', 'share');

    it('uses a non-empty absolute value', () => {
      const absolute = path.join(path.sep, 'custom', 'data');
      withEnvVar('DEVBAR_TEST_DIR', absolute, () => {
        expect(absoluteEnvDir('DEVBAR_TEST_DIR', fallback)).toBe(absolute);
      });
    });

    it('falls back when the variable is EMPTY', () => {
      // `??` only guards undefined: an empty string survives and
      // path.join('', 'Programs') yields a RELATIVE path resolved against
      // the process CWD — the installer would then wipe and populate a
      // directory inside the checkout while reporting success.
      withEnvVar('DEVBAR_TEST_DIR', '', () => {
        expect(absoluteEnvDir('DEVBAR_TEST_DIR', fallback)).toBe(fallback);
      });
    });

    it('falls back when the variable is whitespace only', () => {
      withEnvVar('DEVBAR_TEST_DIR', '   ', () => {
        expect(absoluteEnvDir('DEVBAR_TEST_DIR', fallback)).toBe(fallback);
      });
    });

    it('falls back when the variable is RELATIVE', () => {
      withEnvVar('DEVBAR_TEST_DIR', path.join('relative', 'data'), () => {
        expect(absoluteEnvDir('DEVBAR_TEST_DIR', fallback)).toBe(fallback);
      });
    });

    it('falls back when the variable is unset', () => {
      withEnvVar('DEVBAR_TEST_DIR', undefined, () => {
        expect(absoluteEnvDir('DEVBAR_TEST_DIR', fallback)).toBe(fallback);
      });
    });
  });

  describe('isEntrypoint', () => {
    it('matches when argv[1] is the module itself', () => {
      const directory = temporaryDirectory('devbar-entrypoint-');
      const script = path.join(directory, 'script.ts');
      writeFileSync(script, '', 'utf8');
      withArgv1(script, () => {
        expect(isEntrypoint(pathToFileURL(script).href)).toBe(true);
      });
    });

    it('matches through a SYMLINKED checkout directory', () => {
      // import.meta.url is realpath-resolved by Node, process.argv[1] is
      // not: reached through a symlinked directory (a linked ~/workspace,
      // anything under /tmp on macOS) a raw comparison is false and the
      // script's main() silently never runs.
      const parent = temporaryDirectory('devbar-entrypoint-');
      const realDirectory = path.join(parent, 'realdir');
      const linkDirectory = path.join(parent, 'linkdir');
      mkdirSync(realDirectory);
      const script = path.join(realDirectory, 'script.ts');
      writeFileSync(script, '', 'utf8');
      symlinkSync(realDirectory, linkDirectory, 'dir');

      withArgv1(path.join(linkDirectory, 'script.ts'), () => {
        expect(isEntrypoint(pathToFileURL(script).href)).toBe(true);
      });
    });

    it('does not match a different module', () => {
      const directory = temporaryDirectory('devbar-entrypoint-');
      const script = path.join(directory, 'script.ts');
      const other = path.join(directory, 'other.ts');
      writeFileSync(script, '', 'utf8');
      writeFileSync(other, '', 'utf8');
      withArgv1(other, () => {
        expect(isEntrypoint(pathToFileURL(script).href)).toBe(false);
      });
    });

    it('returns false when argv[1] cannot be resolved', () => {
      const directory = temporaryDirectory('devbar-entrypoint-');
      const script = path.join(directory, 'script.ts');
      writeFileSync(script, '', 'utf8');
      withArgv1(path.join(directory, 'missing.ts'), () => {
        expect(isEntrypoint(pathToFileURL(script).href)).toBe(false);
      });
    });

    it('returns false when there is no argv[1]', () => {
      const directory = temporaryDirectory('devbar-entrypoint-');
      const script = path.join(directory, 'script.ts');
      writeFileSync(script, '', 'utf8');
      withArgv1(undefined, () => {
        expect(isEntrypoint(pathToFileURL(script).href)).toBe(false);
      });
    });
  });
});
