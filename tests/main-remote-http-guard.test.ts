import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  checkMutation,
  readJsonBody,
  readSessionId,
} from '../src/main/remote/http-guard.js';

/** A 16-byte session id in base64url: 22 characters. */
const SID = 'A'.repeat(21) + 'g';
const POST_HEADERS = {
  host: '192.168.1.20:47821',
  'content-type': 'application/json',
  'x-devbar-request': '1',
};

describe('src/main/remote/http-guard.ts', () => {
  describe('readSessionId', () => {
    it('reads a well-formed session id from the X-DevBar-Session header', () => {
      expect(readSessionId(SID)).toBe(SID);
    });

    it('ignores a missing, repeated or malformed header', () => {
      expect(readSessionId(undefined)).toBeNull();
      expect(readSessionId('')).toBeNull();
      expect(readSessionId([SID, SID])).toBeNull();
      expect(readSessionId('../../etc/passwd')).toBeNull();
      expect(readSessionId(`${SID}A`)).toBeNull();
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
