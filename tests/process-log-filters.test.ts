import { describe, expect, it } from 'vitest';
import {
  isShellNoise,
  matchesPattern,
  safeRegex,
  stripAnsi,
} from '../src/process/log-filters.js';

/** ESC[…m and friends, written so the escape byte is unmistakable. */
const ESC = '\u001b';

describe('src/process/log-filters.ts', () => {
  describe('stripAnsi', () => {
    it('removes a colour sequence and keeps the text around it', () => {
      expect(stripAnsi(`${ESC}[31mred${ESC}[0m text`)).toBe('red text');
    });

    it('removes cursor-movement sequences too, not just colours', () => {
      expect(stripAnsi(`${ESC}[2Kline${ESC}[1A`)).toBe('line');
    });

    it('leaves a line without escapes byte-identical', () => {
      expect(stripAnsi('plain output')).toBe('plain output');
    });
  });

  describe('isShellNoise', () => {
    it('recognizes the zsh job-control warning the -ic login shell prints', () => {
      expect(isShellNoise('zsh: no job control in this shell')).toBe(true);
    });

    it('recognizes the two bash job-control warnings the -ic shell prints', () => {
      // bash without a controlling terminal (the packaged app spawns with a
      // pipe on stdin) emits this pair before every command — Debian and
      // Raspberry Pi OS at least. The command itself still runs.
      expect(
        isShellNoise(
          'bash: cannot set terminal process group (-1): Inappropriate ioctl for device',
        ),
      ).toBe(true);
      expect(isShellNoise('bash: no job control in this shell')).toBe(true);
    });

    it('recognizes a gitstatus failure banner', () => {
      expect(isShellNoise('[ERROR]: gitstatus failed to initialize')).toBe(
        true,
      );
    });

    it('sees through ANSI colouring, which the rc files add', () => {
      expect(isShellNoise(`${ESC}[33mexec zsh${ESC}[0m`)).toBe(true);
    });

    it('keeps a real service line', () => {
      expect(isShellNoise('Server listening on :3000')).toBe(false);
    });

    it('keeps a line that merely contains a noise phrase', () => {
      // The patterns are anchored: a service logging about the shell is the
      // service's own output, not the shell's chatter.
      expect(isShellNoise('note: zsh: no job control in this shell')).toBe(
        false,
      );
    });

    it('does not classify a blank line as noise', () => {
      // The start-up window in ProcessManager.start decides about blanks;
      // this filter must not claim them, or that window becomes unreachable.
      expect(isShellNoise('   ')).toBe(false);
      expect(isShellNoise('')).toBe(false);
    });
  });

  describe('safeRegex', () => {
    it('compiles a source case-insensitively', () => {
      const regex = safeRegex('warn');
      expect(regex).not.toBeNull();
      expect(regex?.test('WARNING: disk almost full')).toBe(true);
    });

    it('answers null for an empty, null or undefined source', () => {
      expect(safeRegex('')).toBeNull();
      expect(safeRegex(null)).toBeNull();
      expect(safeRegex(undefined)).toBeNull();
    });

    it('answers null instead of throwing on a source that does not compile', () => {
      // A user-authored regex reaches this from the config form; throwing
      // here would take the whole manager down on a stray paren.
      expect(safeRegex('([unclosed')).toBeNull();
    });
  });

  describe('matchesPattern', () => {
    it('never matches on an empty pattern', () => {
      // `''` is what an untouched silence field stores; treating it as a
      // substring would silence every line of the service.
      expect(matchesPattern('', 'anything at all')).toBe(false);
    });

    it('treats a backslash-free pattern as a plain substring', () => {
      expect(matchesPattern('ECONNREFUSED', 'Error: ECONNREFUSED :5432')).toBe(
        true,
      );
      expect(matchesPattern('ECONNREFUSED', 'Error: ETIMEDOUT')).toBe(false);
    });

    it('does not treat a backslash-free pattern as a regex', () => {
      // `.` is a literal here: the "silence this line" button stores raw
      // text, so a dot in a hostname must not match every character.
      expect(matchesPattern('a.c', 'abc')).toBe(false);
      expect(matchesPattern('a.c', 'a.c')).toBe(true);
    });

    it('treats a pattern containing a backslash as a regex', () => {
      expect(matchesPattern('\\d+ warnings', '17 warnings')).toBe(true);
      expect(matchesPattern('\\d+ warnings', 'some warnings')).toBe(false);
    });

    it('falls back to a substring match when that regex does not compile', () => {
      // A lone backslash has a backslash (so it takes the regex branch) and
      // does not compile — it must still behave as the literal text it is.
      expect(matchesPattern('\\', 'C:\\Users\\dev')).toBe(true);
      expect(matchesPattern('\\', 'no backslash here')).toBe(false);
    });
  });
});
