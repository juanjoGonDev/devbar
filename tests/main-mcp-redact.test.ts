import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  knownSecrets,
  MASK,
  NO_REDACTION,
} from '../src/main/mcp/redact.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makePreScript,
} from './helpers/main-fakes.js';

const redact = createRedactor([]);

describe('src/main/mcp/redact.ts', () => {
  it.each([
    ['Authorization: Bearer abcdef1234567890', `Authorization: Bearer ${MASK}`],
    ['DB_PASSWORD=hunter2', `DB_PASSWORD=${MASK}`],
    ['"api_key": "abcdef"', `"api_key": "${MASK}"`],
    ['key AKIAABCDEFGHIJKLMNOP used', `key ${MASK} used`],
    [`ghp_${'a'.repeat(36)}`, MASK],
    [`sk-${'b'.repeat(32)}`, MASK],
    ['jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', `jwt ${MASK}`],
    [
      'postgres://admin:s3cret@localhost:5432/db',
      `postgres://admin:${MASK}@localhost:5432/db`,
    ],
  ])('masks %s', (input, expected) => {
    expect(redact.text(input)).toBe(expected);
  });

  it('leaves ordinary log lines alone', () => {
    const line = 'VITE v5.0.0 ready in 300 ms → http://localhost:5173/';

    expect(redact.text(line)).toBe(line);
  });

  it('masks every env value DevBar knows, longest first', () => {
    const groups = [
      makeGroup({
        env: [{ key: 'A', value: 'abcdef', enabled: true }],
        commands: [
          makeCommand({
            env: [{ key: 'B', value: 'abcdefgh', enabled: true }],
          }),
        ],
        actions: [
          makeAction({ env: [{ key: 'C', value: 'x', enabled: true }] }),
        ],
        preScripts: [
          makePreScript({
            env: [{ key: 'D', value: 'zzzzzz.+', enabled: true }],
          }),
        ],
      }),
    ];

    const secrets = knownSecrets(groups);

    expect(secrets).toEqual(['abcdefgh', 'zzzzzz.+', 'abcdef']);
    expect(createRedactor(secrets).text('got abcdefgh and zzzzzz.+ x')).toBe(
      `got ${MASK} and ${MASK} x`,
    );
  });

  it('masks env values but keeps their keys and switches', () => {
    expect(
      redact.env([
        { key: 'TOKEN', value: 'abc', enabled: false },
        { key: 'EMPTY', value: '', enabled: true },
      ]),
    ).toEqual([
      { key: 'TOKEN', value: MASK, enabled: false },
      { key: 'EMPTY', value: '', enabled: true },
    ]);
  });

  it('passes everything through for a client that reads in the clear', () => {
    const env = [{ key: 'TOKEN', value: 'abc', enabled: true }];

    expect(NO_REDACTION.text('password=abc')).toBe('password=abc');
    expect(NO_REDACTION.env(env)).toEqual(env);
    expect(NO_REDACTION.env(env)[0]).not.toBe(env[0]);
  });
});
