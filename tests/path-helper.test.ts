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
});
