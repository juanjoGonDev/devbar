import { describe, it, expect, vi } from 'vitest';
import os from 'os';

// Spy on os.homedir so tests are not coupled to the real user's home dir
vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');

import { expandTilde } from '../src/path-helper.js';

describe('path-helper', () => {
  describe('expandTilde', () => {
    it('expands bare ~ to homedir', () => {
      expect(expandTilde('~')).toBe('/home/testuser');
    });

    it('expands ~/subpath to homedir/subpath', () => {
      expect(expandTilde('~/projects/devbar')).toBe('/home/testuser/projects/devbar');
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
});
