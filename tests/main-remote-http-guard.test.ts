import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  checkMutation,
  clearedSessionCookie,
  readJsonBody,
  readSessionToken,
  sessionCookie,
} from '../src/main/remote/http-guard.js';

const TOKEN = 'A'.repeat(43);
const POST_HEADERS = {
  host: '192.168.1.20:47821',
  'content-type': 'application/json',
  'x-devbar-request': '1',
};

describe('src/main/remote/http-guard.ts', () => {
  describe('session cookie', () => {
    it('is HttpOnly, SameSite=Strict, site-wide and long-lived', () => {
      expect(sessionCookie(TOKEN)).toBe(
        `devbar_session=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`,
      );
    });

    it('is cleared with the same attributes and no lifetime', () => {
      expect(clearedSessionCookie()).toBe(
        'devbar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      );
    });

    it('reads the token back from a Cookie header among others', () => {
      expect(readSessionToken(`theme=dark; devbar_session=${TOKEN}`)).toBe(
        TOKEN,
      );
    });

    it('ignores a missing, empty or malformed session cookie', () => {
      expect(readSessionToken(undefined)).toBeNull();
      expect(readSessionToken('devbar_session=')).toBeNull();
      expect(readSessionToken('devbar_session=../../etc')).toBeNull();
      expect(readSessionToken('other=1')).toBeNull();
    });
  });

  describe('checkMutation', () => {
    it('lets a same-origin JSON request with the DevBar header through', () => {
      expect(checkMutation(POST_HEADERS)).toEqual({ ok: true });
      expect(
        checkMutation({
          ...POST_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          origin: 'http://192.168.1.20:47821',
        }),
      ).toEqual({ ok: true });
    });

    it('refuses a form-style content type (the shape a CSRF form can send)', () => {
      expect(
        checkMutation({ ...POST_HEADERS, 'content-type': 'text/plain' }),
      ).toMatchObject({ ok: false, status: 403 });
      const { 'content-type': _ct, ...noType } = POST_HEADERS;
      expect(checkMutation(noType)).toMatchObject({ ok: false, status: 403 });
    });

    it('refuses a request without the DevBar header', () => {
      const { 'x-devbar-request': _h, ...headers } = POST_HEADERS;
      expect(checkMutation(headers)).toMatchObject({ ok: false, status: 403 });
      expect(
        checkMutation({ ...POST_HEADERS, 'x-devbar-request': '0' }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    it('refuses a cross-origin request', () => {
      expect(
        checkMutation({ ...POST_HEADERS, origin: 'http://evil.example' }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(checkMutation({ ...POST_HEADERS, origin: 'null' })).toMatchObject({
        ok: false,
        status: 403,
      });
    });
  });

  describe('readJsonBody', () => {
    const body = (text: string) => Readable.from([Buffer.from(text)]);

    it('parses a JSON body', async () => {
      await expect(readJsonBody(body('{"a":1}'), undefined)).resolves.toEqual({
        ok: true,
        value: { a: 1 },
      });
    });

    it('answers 400 for malformed JSON', async () => {
      await expect(readJsonBody(body('{nope'), undefined)).resolves.toEqual({
        ok: false,
        status: 400,
      });
    });

    it('answers 413 when the declared length is over 16 KB', async () => {
      await expect(
        readJsonBody(body('{}'), String(16 * 1024 + 1)),
      ).resolves.toEqual({ ok: false, status: 413 });
    });

    it('answers 413 when the body streams past 16 KB without declaring it', async () => {
      const chunk = Buffer.alloc(8 * 1024, 0x20);
      const stream = Readable.from([chunk, chunk, chunk]);

      await expect(readJsonBody(stream, undefined)).resolves.toEqual({
        ok: false,
        status: 413,
      });
    });
  });
});
