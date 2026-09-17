import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  splitCommand,
  buildCmdline,
  buildCmdlineWindows,
  quoteWindowsArg,
  hasShellMeta,
} from '../src/parse-command.js';

describe('parse-command', () => {
  // ─── tokenize ───────────────────────────────────────────────────────
  describe('tokenize', () => {
    it('splits simple command by whitespace', () => {
      expect(tokenize('git commit -m msg')).toEqual([
        'git',
        'commit',
        '-m',
        'msg',
      ]);
    });

    it('preserves single-quoted strings as one token', () => {
      expect(tokenize("git commit -m 'hello world'")).toEqual([
        'git',
        'commit',
        '-m',
        'hello world',
      ]);
    });

    it('preserves double-quoted strings as one token', () => {
      expect(tokenize('git commit -m "hello world"')).toEqual([
        'git',
        'commit',
        '-m',
        'hello world',
      ]);
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
    it('detects pipe', () => {
      expect(hasShellMeta('cmd | grep foo')).toBe(true);
    });
    it('detects semicolon', () => {
      expect(hasShellMeta('a; b')).toBe(true);
    });
    it('detects redirect', () => {
      expect(hasShellMeta('cmd > out.txt')).toBe(true);
    });
    it('detects ampersand', () => {
      expect(hasShellMeta('cmd &')).toBe(true);
    });
    it('detects dollar', () => {
      expect(hasShellMeta('$VAR')).toBe(true);
    });
    it('detects backtick', () => {
      expect(hasShellMeta('`cmd`')).toBe(true);
    });
    it('detects glob', () => {
      expect(hasShellMeta('*.js')).toBe(true);
    });
    it('returns false for plain args', () => {
      expect(hasShellMeta('--flag')).toBe(false);
    });
    it('returns false for empty string', () => {
      expect(hasShellMeta('')).toBe(false);
    });
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
      expect(result).toContain('echo');
      expect(result).toContain(
        "it's alive".replace(/'/g, "'\\''") || "it's alive",
      );
    });
  });
  // --- quoteWindowsArg / buildCmdlineWindows -----------------------------------
  // The child is reached as: cmd.exe /d /s /c <line> - cmd parses
  // operators first, then the child applies CommandLineToArgvW rules.
  describe('quoteWindowsArg (cmd.exe + CommandLineToArgvW)', () => {
    it('passes plain args through unchanged', () => {
      expect(quoteWindowsArg('--port')).toBe('--port');
      expect(quoteWindowsArg('8080')).toBe('8080');
    });

    it('quotes args with whitespace (MSVCRT double quotes, not POSIX)', () => {
      expect(quoteWindowsArg('My App')).toBe('"My App"');
    });

    it('quotes empty args so the argument survives', () => {
      expect(quoteWindowsArg('')).toBe('""');
    });

    it('escapes embedded double quotes for the child parser', () => {
      expect(quoteWindowsArg('He said "hi"')).toBe('"He said \\"hi\\""');
    });

    it('doubles backslashes that precede the closing quote', () => {
      // The embedded quote forces wrapping; the trailing backslash
      // must be doubled so the child parser yields the original bytes.
      expect(quoteWindowsArg('a"b\\')).toBe('"a\\"b\\\\"');
    });

    it('escapes cmd operators with ^ when the arg stays unquoted', () => {
      expect(quoteWindowsArg('a&b')).toBe('a^&b');
      expect(quoteWindowsArg('c>d')).toBe('c^>d');
      expect(quoteWindowsArg('e|f')).toBe('e^|f');
      expect(quoteWindowsArg('g^h')).toBe('g^^h');
    });

    it('escapes percent signs so cmd does not expand environment references', () => {
      expect(quoteWindowsArg('%TEMP%')).toBe('^%TEMP^%');
      expect(quoteWindowsArg('in %TEMP% now')).toBe('"in "^%"TEMP"^%" now"');
    });

    it('wraps in quotes when whitespace and operators combine', () => {
      // operators are literal inside double quotes for cmd
      expect(quoteWindowsArg('My App & more')).toBe('"My App & more"');
    });
  });

  describe('buildCmdlineWindows', () => {
    it('returns the command untouched when it has no args', () => {
      expect(buildCmdlineWindows('npm run dev', [])).toBe('npm run dev');
    });

    it('keeps cmd syntax typed in the command (free-form shell string)', () => {
      expect(buildCmdlineWindows('cd /d C:\\x && npm run dev', [])).toBe(
        'cd /d C:\\x && npm run dev',
      );
    });

    it('quotes spaced args and escapes metacharacter args', () => {
      // 'a&b' stays unquoted -> ^ escape; '> log' has whitespace ->
      // quoted, and cmd treats > literally inside double quotes.
      expect(
        buildCmdlineWindows('node server.js', [
          '--title',
          'My App',
          'a&b',
          '> log',
        ]),
      ).toBe('node server.js --title "My App" a^&b "> log"');
    });

    it.runIf(process.platform === 'win32')(
      'round-trips literal percent signs through cmd.exe',
      () => {
        const helper = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          'fixtures',
          'print-argv.js',
        );
        const cmdline = buildCmdlineWindows(quoteWindowsArg(process.execPath), [
          helper,
          '%TEMP%',
        ]);
        const result = spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', cmdline],
          {
            encoding: 'utf8',
            env: { ...process.env, TEMP: 'expanded-by-cmd' },
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(['%TEMP%']);
      },
    );
  });
});
