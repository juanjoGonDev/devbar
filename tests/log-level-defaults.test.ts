import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
  LEGACY_DEFAULT_ERROR_REGEX,
  LEGACY_DEFAULT_WARN_REGEX,
  upgradeLegacyDefaultRegex,
} from '../src/log-level-defaults.js';
import { safeRegex } from '../src/process/log-filters.js';

/** Compiled exactly as the process manager compiles a stored detector. */
function detector(source: string): RegExp {
  const regex = safeRegex(source);
  if (!regex) throw new Error(`default regex does not compile: ${source}`);
  return regex;
}

const ERROR_LINES = [
  'Error: socket hang up',
  'TypeError: x is not a function',
  'ERROR something',
  '[error] boom',
  'level=error msg=x',
  'npm ERR! code E404',
  'error TS2304: Cannot find name',
  "throw er; // Unhandled 'error' event",
  'FATAL: db down',
  'Uncaught Exception: x',
  'Found 3 errors',
];

const NOT_ERROR_LINES = [
  'Successfully compiled src/services/analytics/error-handler.ts',
  'GET /api/errors/list 200',
  'loading error.js',
  'errorHandler registered',
  'Found 0 errors',
  'No errors found',
  'compiled without errors',
  'error_count=0',
];

const WARN_LINES = [
  'warn: deprecated',
  'WARNING something',
  '[warn] x',
  '(node:1) DeprecationWarning: Buffer()',
  'npm WARN deprecated',
  'level=warn',
  '2 warnings',
];

const NOT_WARN_LINES = [
  'node --no-warnings app.js',
  'src/warnings/index.ts',
  '0 warnings',
  'no warnings',
  'warnOnce helper',
];

describe('src/log-level-defaults.ts', () => {
  describe('DEFAULT_ERROR_REGEX', () => {
    it.each(ERROR_LINES)('flags %j as an error', (line) => {
      expect(detector(DEFAULT_ERROR_REGEX).test(line)).toBe(true);
    });

    it.each(NOT_ERROR_LINES)('does not flag %j as an error', (line) => {
      expect(detector(DEFAULT_ERROR_REGEX).test(line)).toBe(false);
    });
  });

  describe('DEFAULT_WARN_REGEX', () => {
    it.each(WARN_LINES)('flags %j as a warning', (line) => {
      expect(detector(DEFAULT_WARN_REGEX).test(line)).toBe(true);
    });

    it.each(NOT_WARN_LINES)('does not flag %j as a warning', (line) => {
      expect(detector(DEFAULT_WARN_REGEX).test(line)).toBe(false);
    });
  });

  describe('upgradeLegacyDefaultRegex', () => {
    it('replaces the exact old warn default with the new one', () => {
      expect(upgradeLegacyDefaultRegex(LEGACY_DEFAULT_WARN_REGEX)).toBe(
        DEFAULT_WARN_REGEX,
      );
    });

    it('replaces the exact old error default with the new one', () => {
      expect(upgradeLegacyDefaultRegex(LEGACY_DEFAULT_ERROR_REGEX)).toBe(
        DEFAULT_ERROR_REGEX,
      );
    });

    it('keeps the old defaults pinned to the strings earlier versions stored', () => {
      expect(LEGACY_DEFAULT_WARN_REGEX).toBe('\\bwarn(ing)?s?\\b');
      expect(LEGACY_DEFAULT_ERROR_REGEX).toBe('\\berror(s)?\\b');
    });

    it.each(['\\bwarn(ing)?s?\\b ', 'WARN', '\\berror\\b', ''])(
      'leaves the custom regex %j untouched',
      (custom) => {
        expect(upgradeLegacyDefaultRegex(custom)).toBe(custom);
      },
    );
  });
});
