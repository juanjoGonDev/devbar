import { describe, it, expect } from 'vitest';
import { tokenize, splitCommand, buildCmdline, hasShellMeta } from '../src/parse-command.js';

describe('parse-command', () => {
  // ─── tokenize ───────────────────────────────────────────────────────
  describe('tokenize', () => {
    it('splits simple command by whitespace', () => {
      expect(tokenize('git commit -m msg')).toEqual(['git', 'commit', '-m', 'msg']);
    });

    it('preserves single-quoted strings as one token', () => {
      expect(tokenize("git commit -m 'hello world'")).toEqual(['git', 'commit', '-m', 'hello world']);
    });

    it('preserves double-quoted strings as one token', () => {
      expect(tokenize('git commit -m "hello world"')).toEqual(['git', 'commit', '-m', 'hello world']);
    });

    it('handles escaped spaces inside unquoted', () => {
      expect(tokenize('git commit\\ -m')).toEqual(['git', 'commit -m']);
    });

    it('handles empty string', () => {
      expect(tokenize('')).toEqual([]);
    });

    it('handles multiple consecutive spaces', () => {
      expect(tokenize('a   b')).toEqual(['a', 'b']);
    });

    it('handles tab separators', () => {
      expect(tokenize('a\tb')).toEqual(['a', 'b']);
    });
  });

  // ─── hasShellMeta ────────────────────────────────────────────────────
  describe('hasShellMeta', () => {
    it('detects pipe', () => { expect(hasShellMeta('cmd | grep foo')).toBe(true); });
    it('detects semicolon', () => { expect(hasShellMeta('a; b')).toBe(true); });
    it('detects redirect', () => { expect(hasShellMeta('cmd > out.txt')).toBe(true); });
    it('detects ampersand', () => { expect(hasShellMeta('cmd &')).toBe(true); });
    it('detects dollar', () => { expect(hasShellMeta('$VAR')).toBe(true); });
    it('detects backtick', () => { expect(hasShellMeta('`cmd`')).toBe(true); });
    it('detects glob', () => { expect(hasShellMeta('*.js')).toBe(true); });
    it('returns false for plain args', () => { expect(hasShellMeta('--flag')).toBe(false); });
    it('returns false for empty string', () => { expect(hasShellMeta('')).toBe(false); });
  });

  // ─── splitCommand ────────────────────────────────────────────────────
  describe('splitCommand', () => {
    it('leaves shell-meta command as single token', () => {
      const r = splitCommand('pnpm install && pnpm test', []);
      expect(r.command).toBe('pnpm install && pnpm test');
      expect(r.args).toEqual([]);
    });

    it('splits simple command into command + args', () => {
      const r = splitCommand('pnpm dev:student', []);
      expect(r.command).toBe('pnpm');
      expect(r.args).toEqual(['dev:student']);
    });

    it('returns command with args when args array is non-empty', () => {
      const r = splitCommand('pnpm', ['dev']);
      expect(r.command).toBe('pnpm');
      expect(r.args).toEqual(['dev']);
    });

    it('handles single-word command', () => {
      const r = splitCommand('node', []);
      expect(r.command).toBe('node');
      expect(r.args).toEqual([]);
    });

    it('handles empty command', () => {
      const r = splitCommand('', []);
      expect(r.command).toBe('');
    });
  });

  // ─── buildCmdline ────────────────────────────────────────────────────
  describe('buildCmdline', () => {
    it('returns command only when no args', () => {
      expect(buildCmdline('pnpm', [])).toBe('pnpm');
    });

    it('builds simple cmdline', () => {
      expect(buildCmdline('pnpm', ['dev'])).toBe('pnpm dev');
    });

    it('quotes args with spaces', () => {
      expect(buildCmdline('echo', ['hello world'])).toBe("echo 'hello world'");
    });

    it('passes args with shell-meta unquoted (raw join)', () => {
      // When any arg has shell-meta, do NOT quote — join raw
      const result = buildCmdline('cmd', ['--arg', '> out.txt']);
      expect(result).toBe('cmd --arg > out.txt');
    });

    it('handles empty args array', () => {
      expect(buildCmdline('node', [])).toBe('node');
    });

    it('handles shell-meta in the command itself (no args)', () => {
      const cmd = 'pnpm install && pnpm test';
      expect(buildCmdline(cmd, [])).toBe(cmd);
    });

    it('quotes args containing single quotes', () => {
      // Single quote is escaped with '\\'' pattern
      const result = buildCmdline('echo', ["it's alive"]);
      expect(result).toContain("echo");
      expect(result).toContain("it's alive".replace(/'/g, "'\\''") || "it's alive");
    });
  });
});
