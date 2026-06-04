import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildSilencePattern, regexEscape } = require('../src/silence-pattern');

describe('regexEscape', () => {
  it('plain text is identity', () => {
    expect(regexEscape('hello world')).toBe('hello world');
  });

  it('escapes regex special characters', () => {
    expect(regexEscape('a.b')).toBe('a\\.b');
    expect(regexEscape('foo (bar) [baz]')).toBe('foo \\(bar\\) \\[baz\\]');
    expect(regexEscape('a*b+c?')).toBe('a\\*b\\+c\\?');
    expect(regexEscape('a^b$c')).toBe('a\\^b\\$c');
    expect(regexEscape('a{1}b|c')).toBe('a\\{1\\}b\\|c');
    expect(regexEscape('a\\b')).toBe('a\\\\b');
  });
});

describe('buildSilencePattern', () => {
  it('returns empty string for null', () => {
    expect(buildSilencePattern(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(buildSilencePattern('')).toBe('');
  });

  it('returns empty string for whitespace-only', () => {
    expect(buildSilencePattern('   ')).toBe('');
    expect(buildSilencePattern('\t\n')).toBe('');
  });

  it('escapes regex specials', () => {
    expect(buildSilencePattern('a.b')).toBe('a\\.b');
    expect(buildSilencePattern('foo (bar) [baz]')).toBe('foo \\(bar\\) \\[baz\\]');
  });

  it('replaces digit runs >= 2 with \\d+', () => {
    expect(buildSilencePattern('12:34')).toBe('\\d+:\\d+');
    expect(buildSilencePattern('12:34:56')).toBe('\\d+:\\d+:\\d+');
    expect(buildSilencePattern('Request 8472931 failed with code 500'))
      .toBe('Request \\d+ failed with code \\d+');
  });

  it('keeps single digits literal', () => {
    expect(buildSilencePattern('v2 foo')).toBe('v2 foo');
    expect(buildSilencePattern('H1 header')).toBe('H1 header');
  });

  it('combined realistic case — timestamp with level', () => {
    expect(buildSilencePattern('[12:34:56] WARN deprecated foo'))
      .toBe('\\[\\d+:\\d+:\\d+\\] WARN deprecated foo');
  });

  it('produced pattern matches a sibling line with a different timestamp', () => {
    const p = buildSilencePattern('[12:34:56] WARN deprecated foo');
    const re = new RegExp(p, 'i');
    expect(re.test('[12:35:01] WARN deprecated foo')).toBe(true);
    expect(re.test('[09:00:00] WARN deprecated foo')).toBe(true);
  });

  it('produced pattern does NOT match a different message', () => {
    const p = buildSilencePattern('[12:34:56] WARN deprecated foo');
    const re = new RegExp(p, 'i');
    expect(re.test('OTHER warn line')).toBe(false);
    expect(re.test('[12:34:56] INFO deprecated foo')).toBe(false);
  });

  it('combined: large request id', () => {
    const p = buildSilencePattern('Request 8472931 failed with code 500');
    const re = new RegExp(p, 'i');
    expect(re.test('Request 1234 failed with code 404')).toBe(true);
    expect(re.test('Request 8472931 failed with code 500')).toBe(true);
    expect(re.test('Something completely different')).toBe(false);
  });
});
