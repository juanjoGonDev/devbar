import { spawnSync } from 'node:child_process';
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
      // The span closes before the literal quote (the state machine
      // cannot emit `\"` from inside a child span) and the argument
      // ends with its span left open — the child parser accepts that.
      expect(quoteWindowsArg('He said "hi"')).toBe('"He said "\\"hi\\"');
    });

    it('keeps a trailing backslash literal at end of argument', () => {
      // No closing quote is emitted, so the trailing backslash needs no
      // doubling — the simulated round-trip below asserts the bytes.
      expect(quoteWindowsArg('a"b\\')).toBe('"a"\\"b\\');
    });

    it('escapes cmd operators with ^ when the arg stays unquoted', () => {
      expect(quoteWindowsArg('a&b')).toBe('a^&b');
      expect(quoteWindowsArg('c>d')).toBe('c^>d');
      expect(quoteWindowsArg('e|f')).toBe('e^|f');
      expect(quoteWindowsArg('g^h')).toBe('g^^h');
      // Parentheses are cmd compound-statement grouping: unescaped,
      // foo(bar) would open a compound command, not reach the child.
      expect(quoteWindowsArg('foo(bar)')).toBe('foo^(bar^)');
      expect(quoteWindowsArg('a)b')).toBe('a^)b');
    });

    it('escapes percent signs so cmd does not expand environment references', () => {
      expect(quoteWindowsArg('%TEMP%')).toBe('^%TEMP^%');
      // The % span must run until the next SPACE (not just the %): with a
      // break right after each %, the child's parser would split the
      // argument at the following unquoted space.
      expect(quoteWindowsArg('in %TEMP% now')).toBe('"in "^%TEMP^%" now"');
      // After a % the cmd span is CLOSED, so following operators would be
      // command syntax to cmd.exe — they must be ^-escaped (the simulated
      // round-trip cannot catch this: operators don't alter the string).
      expect(quoteWindowsArg('x %& whoami')).toBe('"x "^%^&" whoami"');
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
        // No fixture file: node -p prints its own argv, which keeps this
        // inside the TypeScript-only source policy. The program and the
        // shell are static literals (node and cmd.exe both resolve from
        // PATH), so the command line carries no uncontrolled data — only
        // the escaper's output for the args under test.
        const cmdline = buildCmdlineWindows(
          'node -p "JSON.stringify(process.argv.slice(1))"',
          ['%TEMP%', 'in %TEMP% now'],
        );
        const result = spawnSync('cmd.exe', ['/d', '/s', '/c', cmdline], {
          encoding: 'utf8',
          env: { ...process.env, TEMP: 'expanded-by-cmd' },
        });

        expect(result.status, result.stderr).toBe(0);
        // An unescaped % would arrive as 'expanded-by-cmd'.
        expect(JSON.parse(result.stdout)).toEqual(['%TEMP%', 'in %TEMP% now']);
      },
    );

    it.runIf(process.platform === 'win32')(
      'round-trips parentheses through cmd.exe (unquoted and in a span)',
      () => {
        // No fixture file: node -p prints its own argv, which keeps this
        // inside the TypeScript-only source policy. The program and the
        // shell are static literals (node and cmd.exe both resolve from
        // PATH), so the command line carries no uncontrolled data — only
        // the escaper's output for the args under test.
        const cmdline = buildCmdlineWindows(
          'node -p "JSON.stringify(process.argv.slice(1))"',
          ['foo(bar)', 'a)b', 'keep ( ) in a span'],
        );
        const result = spawnSync('cmd.exe', ['/d', '/s', '/c', cmdline], {
          encoding: 'utf8',
        });

        expect(result.status, result.stderr).toBe(0);
        // An unescaped ( ) would make cmd treat the rest as compound
        // command syntax — the child would never receive these argv.
        expect(JSON.parse(result.stdout)).toEqual([
          'foo(bar)',
          'a)b',
          'keep ( ) in a span',
        ]);
      },
    );
  });

  // ─── reference-parser round-trip ────────────────────────────────────
  // Simulates the two real parsers (cmd.exe escape/expansion, then the
  // child's CommandLineToArgvW) so the quoting can be verified on every
  // OS, not only by the win32-only cmd.exe test below.
  describe('quoteWindowsArg round-trip through simulated parsers', () => {
    // cmd.exe layer: ^ escapes the next character (caret consumed);
    // %NAME% expands from the env (a bare % reaching here is a quoting
    // bug, so expansion uses a sentinel that fails the round-trip).
    function cmdSimulate(line: string, env: Record<string, string>): string {
      let out = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        // cmd passes " and ^ through literally INSIDE double quotes;
        // only outside them is ^ the escape character. %VAR% expands
        // inside AND outside quotes — that is the hazard the escaper
        // must defeat.
        if (ch === '"') {
          inQuotes = !inQuotes;
          out += ch;
          continue;
        }
        if (ch === '^' && !inQuotes) {
          i++;
          out += line[i] ?? '';
          continue;
        }
        if (ch === '%') {
          const close = line.indexOf('%', i + 1);
          if (close > i) {
            out += env[line.slice(i + 1, close)] ?? '%UNDEFINED%';
            i = close;
            continue;
          }
        }
        out += ch;
      }
      return out;
    }
    // MSVCRT CommandLineToArgvW: quotes toggle, backslash runs encode
    // quotes, an unquoted space ends the current argument; a quoted span
    // with no content still yields an (empty) argument.
    function childParse(line: string): string[] {
      const args: string[] = [];
      let arg = '';
      let inQuotes = false;
      let touched = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
          touched = true;
          continue;
        }
        if (ch === '\\') {
          let n = 1;
          while (i + n < line.length && line[i + n] === '\\') n++;
          if (i + n < line.length && line[i + n] === '"') {
            arg += '\\'.repeat(Math.floor(n / 2));
            if (n % 2 === 1) {
              arg += '"';
            } else {
              // an even run encodes n/2 literal backslashes and the
              // quote still TOGGLES the quoted state
              inQuotes = !inQuotes;
            }
            i += n;
            touched = true;
          } else {
            arg += '\\'.repeat(n);
            i += n - 1;
            touched = true;
          }
          continue;
        }
        if ((ch === ' ' || ch === '\t') && !inQuotes) {
          if (touched) {
            args.push(arg);
            arg = '';
            touched = false;
          }
          continue;
        }
        arg += ch;
        touched = true;
      }
      if (touched) args.push(arg);
      return args;
    }

    const ENV = { TEMP: 'expanded-by-cmd', HOMEDRIVE: 'C:' };
    const BATTERY: string[] = [
      'plain',
      '--flag',
      'a b',
      '',
      '%TEMP%',
      'in %TEMP% now',
      '% foo',
      'foo %',
      'a% b',
      'a%% b',
      '100% (done)',
      '%UNC\\share\\file',
      "a%'b",
      'say "hi" now',
      'C:\\',
      'C:\\ new',
      'a\\b c',
      'a\\\\b c',
      'path\\to "x" end',
      'mixed & | < > ^ % " \\',
      'a%\\\" b',
      'a%\\ b',
      'a%\\\\\" b',
      'C%\\\\x\\" y',
      '%HOMEDRIVE:%\dir',
      'a^b c',
      'trailing space ',
      '  leading',
      '%%',
      '%',
      '100%',
      'a b%',
      '%"%',
      '%\\',
      'a\tb % c',
      '%a%b% c',
      'He said "hi"',
      'a"b\\',
      // a % can close the cmd span; the operators after it must be
      // ^-escaped or cmd would chain/pipe/redirect instead of pass
      'x %& whoami',
      'a %|b c',
      'd %< e',
      'f %>g h',
      'i %^j k',
      '%&',
    ];

    it.each(BATTERY)(
      'round-trips %s through cmd.exe + CommandLineToArgvW',
      (value) => {
        const raw = quoteWindowsArg(value);
        const afterCmd = cmdSimulate(raw, ENV);
        expect(
          childParse(afterCmd),
          `value=${JSON.stringify(value)} raw=${JSON.stringify(raw)}`,
        ).toEqual([value]);
      },
    );
  });
});
