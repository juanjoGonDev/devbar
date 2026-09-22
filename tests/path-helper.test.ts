import { describe, it, expect, vi } from 'vitest';
import os from 'os';

// Spy on os.homedir so tests are not coupled to the real user's home dir
vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');

import { expandTilde, ensureStandardPaths } from '../src/path-helper.js';

describe('path-helper', () => {
  describe('expandTilde', () => {
    it('expands bare ~ to homedir', () => {
      expect(expandTilde('~')).toBe('/home/testuser');
    });

    it('expands ~/subpath to homedir/subpath', () => {
      expect(expandTilde('~/projects/devbar')).toBe(
        '/home/testuser/projects/devbar',
      );
    });

    it('leaves absolute paths unchanged', () => {
      expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
    });

    it('leaves relative paths unchanged', () => {
      expect(expandTilde('relative/path')).toBe('relative/path');
    });

    it('returns empty string for empty string', () => {
      // expandTilde returns the input as-is when falsy (empty string is falsy)
      expect(expandTilde('')).toBeFalsy();
    });

    it('returns null for null input', () => {
      expect(expandTilde(null)).toBeNull();
    });

    it('returns undefined for undefined input', () => {
      expect(expandTilde(undefined)).toBeUndefined();
    });

    it('handles ~/  (trailing slash after tilde) — path.join normalizes trailing slash', () => {
      // path.join('~/'.slice(2)) = path.join('') normalizes to homedir without trailing slash
      expect(expandTilde('~/')).toBe('/home/testuser');
    });

    it('does not expand ~ in the middle of a path', () => {
      expect(expandTilde('/foo/~/bar')).toBe('/foo/~/bar');
    });
  });

  describe('ensureStandardPaths', () => {
    it('appends /usr/local/bin when missing (the Docker CLI case)', () => {
      // Reproduces the real DevBar bug: a GUI-launched PATH lacking /usr/local/bin.
      const input =
        '/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
      const result = ensureStandardPaths(input);
      expect(result.split(':')).toContain('/usr/local/bin');
    });

    it('does NOT reorder or duplicate existing entries', () => {
      // Input already contains every standard dir → output must be identical.
      const input =
        '/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin';
      const result = ensureStandardPaths(input);
      expect(result).toBe(input);
    });

    it("preserves the precedence of the user's own entries (only appends)", () => {
      const input = '/Users/me/.volta/bin:/usr/bin';
      const parts = ensureStandardPaths(input).split(':');
      // user entries stay first, in original order
      expect(parts[0]).toBe('/Users/me/.volta/bin');
      expect(parts[1]).toBe('/usr/bin');
      // missing standard dirs are appended after
      expect(parts).toContain('/usr/local/bin');
      expect(parts).toContain('/opt/homebrew/bin');
    });

    it('adds all standard dirs when given an empty PATH', () => {
      const parts = ensureStandardPaths('').split(':');
      for (const dir of [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]) {
        expect(parts).toContain(dir);
      }
    });

    it('handles null/undefined by returning the standard dirs', () => {
      expect(ensureStandardPaths(null).split(':')).toContain('/usr/local/bin');
      expect(ensureStandardPaths(undefined).split(':')).toContain(
        '/usr/local/bin',
      );
    });

    it('drops empty segments from a malformed PATH', () => {
      const result = ensureStandardPaths('/usr/bin::/bin:');
      expect(result.split(':')).not.toContain('');
    });
  });

  describe('enhancedEnv on Windows', () => {
    /**
     * Windows spells the variable `Path`, JavaScript object keys are
     * case-sensitive, and only one of two PATH-like keys can reach the child
     * — so a group's or target's override must be merged into the single
     * canonical key rather than left competing with the generated one.
     *
     * platform.ts reads process.platform at module load, so the Windows
     * branch needs resetModules + a dynamic import (same shape as
     * tests/process-spawn.test.ts). The spies are restored here instead of
     * with restoreAllMocks: this file installs a module-scope os.homedir spy
     * that the other tests still depend on.
     */
    async function winEnhancedEnv(
      extra: NodeJS.ProcessEnv,
    ): Promise<NodeJS.ProcessEnv> {
      const platform = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue('win32');
      // Both are read at call time on the Windows branch; pin them so the
      // assertions describe the code, not the contributor's machine. `Path`
      // is the spelling Windows itself exports — on a POSIX runner it lands
      // as a SECOND key, which is exactly the collision under test.
      vi.stubEnv('SystemRoot', 'C:\\Windows');
      vi.stubEnv('Path', 'C:\\inherited');
      vi.stubEnv('PATH', 'C:\\inherited');
      try {
        vi.resetModules();
        const mod = await import('../src/path-helper.js');
        return mod.enhancedEnv(extra);
      } finally {
        platform.mockRestore();
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    }

    const pathKeys = (env: NodeJS.ProcessEnv): string[] =>
      Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');

    it('merges a `Path` override into the one canonical PATH key', async () => {
      const env = await winEnhancedEnv({ Path: 'C:\\tools\\bin' });
      // Two competing keys would both be handed to spawn, where only one of
      // them survives — and it can be the generated one, dropping the
      // override the user configured.
      expect(pathKeys(env)).toEqual(['PATH']);
      const parts = env.PATH?.split(';') ?? [];
      // The override is the BASE; the standard dirs are topped up after it.
      expect(parts[0]).toBe('C:\\tools\\bin');
      expect(parts).toContain('C:\\Windows\\system32');
      expect(parts).not.toContain('C:\\inherited');
    });

    it('collapses the inherited `Path` when the caller overrides nothing', async () => {
      const env = await winEnhancedEnv({});
      expect(pathKeys(env)).toEqual(['PATH']);
      expect(env.PATH?.split(';')[0]).toBe('C:\\inherited');
    });
  });
});
