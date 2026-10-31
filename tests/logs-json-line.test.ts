import { describe, expect, it } from 'vitest';

import {
  MAX_JSON_CHARS,
  compactJson,
  jsonTokens,
  parseJsonLine,
} from '../renderer/logs/json-line.js';

describe('renderer/logs/json-line.ts', () => {
  describe('parseJsonLine', () => {
    it('reads a line that is a JSON object', () => {
      expect(parseJsonLine('{"level":"info","ms":42}')).toEqual({
        prefix: '',
        value: { level: 'info', ms: 42 },
      });
    });

    it('keeps a bracketed prefix such as a pid out of the parse', () => {
      expect(parseJsonLine('[1234] [api] {"ok":true}')).toEqual({
        prefix: '[1234] [api] ',
        value: { ok: true },
      });
    });

    it('reads through ANSI colour and surrounding whitespace', () => {
      expect(parseJsonLine('\u001b[90m  {"a":1}  \u001b[0m')?.value).toEqual({
        a: 1,
      });
    });

    it.each([
      'plain text',
      '[1, 2, 3]',
      '{"broken": }',
      '{} trailing',
      'null',
      '"just a string"',
    ])('leaves %j as text', (text) => {
      expect(parseJsonLine(text)).toBeNull();
    });

    it('does not even try a line past the size cap', () => {
      const huge = `{"a":"${'x'.repeat(MAX_JSON_CHARS)}"}`;
      expect(parseJsonLine(huge)).toBeNull();
    });
  });

  describe('compactJson', () => {
    it('lays the object out on one spaced line', () => {
      expect(compactJson({ level: 'info', ms: 42 }, 200)).toEqual({
        text: '{ "level": "info", "ms": 42 }',
        truncated: false,
      });
    });

    it('stops at a whole member once the budget is spent, and says so', () => {
      const out = compactJson({ a: 'x'.repeat(10), b: 'y'.repeat(10) }, 20);
      expect(out).toEqual({
        text: '{ "a": "xxxxxxxxxx", … }',
        truncated: true,
      });
    });

    it('always shows at least the first member', () => {
      expect(compactJson({ a: 'x'.repeat(50) }, 5).text).toContain('"a"');
    });

    it('draws an empty object as such', () => {
      expect(compactJson({}, 10).text).toBe('{}');
    });
  });

  describe('jsonTokens', () => {
    it('tells keys, strings, numbers and literals apart', () => {
      expect(
        jsonTokens('{ "k": "v", "n": -1.5e3, "b": true, "z": null }'),
      ).toEqual([
        { kind: 'punct', text: '{ ' },
        { kind: 'key', text: '"k"' },
        { kind: 'punct', text: ': ' },
        { kind: 'str', text: '"v"' },
        { kind: 'punct', text: ', ' },
        { kind: 'key', text: '"n"' },
        { kind: 'punct', text: ': ' },
        { kind: 'num', text: '-1.5e3' },
        { kind: 'punct', text: ', ' },
        { kind: 'key', text: '"b"' },
        { kind: 'punct', text: ': ' },
        { kind: 'lit', text: 'true' },
        { kind: 'punct', text: ', ' },
        { kind: 'key', text: '"z"' },
        { kind: 'punct', text: ': ' },
        { kind: 'lit', text: 'null' },
        { kind: 'punct', text: ' }' },
      ]);
    });

    it('keeps escaped quotes inside one string', () => {
      expect(jsonTokens('"a\\"b"')).toEqual([{ kind: 'str', text: '"a\\"b"' }]);
    });

    it('loses no character, whatever the input', () => {
      const text = '{\n  "a": [1, {"b": "c"}],\n  "d": false\n}';
      expect(
        jsonTokens(text)
          .map((token) => token.text)
          .join(''),
      ).toBe(text);
    });
  });
});
