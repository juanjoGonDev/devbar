import { describe, expect, it } from 'vitest';
import { createPairing } from '../src/main/remote/pairing.js';

const MINUTE = 60_000;

function harness() {
  let clock = 5_000_000;
  let bytes = 0;
  const pairing = createPairing({
    now: () => clock,
    // Distinct, deterministic bytes per call: every code/id differs.
    randomBytes: (size) => Buffer.alloc(size, ++bytes),
    randomInt: () => 482_913,
  });
  const ask = (code: string) =>
    pairing.request({
      code,
      name: 'iPhone',
      client: 'Safari · iOS',
      ip: '192.168.1.40',
    });
  return {
    pairing,
    ask,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function requestIdOf(result: ReturnType<ReturnType<typeof harness>['ask']>) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.request.requestId;
}

describe('src/main/remote/pairing.ts', () => {
  describe('startPairing', () => {
    it('issues a url-safe code that expires in five minutes', () => {
      const h = harness();

      const { code, expiresAt } = h.pairing.startPairing();

      expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(expiresAt).toBe(h.now() + 5 * MINUTE);
    });

    it('keeps only one active code: a new one retires the previous', () => {
      const h = harness();
      const first = h.pairing.startPairing();
      const second = h.pairing.startPairing();

      expect(h.ask(first.code)).toEqual({ ok: false, reason: 'expired' });
      expect(h.ask(second.code).ok).toBe(true);
    });
  });

  describe('request', () => {
    it('consumes the code and opens a 60 s request with a 6-digit check', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();

      const result = h.ask(code);

      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      const { requestId, ...rest } = result.request;
      expect(requestId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(rest).toEqual({
        verificationCode: '482913',
        name: 'iPhone',
        client: 'Safari · iOS',
        ip: '192.168.1.40',
        expiresAt: h.now() + MINUTE,
      });
      expect(h.ask(code)).toEqual({ ok: false, reason: 'used' });
    });

    it('pads a short verification number to six digits', () => {
      const pairing = createPairing({
        now: () => 0,
        randomBytes: (size) => Buffer.alloc(size, 7),
        randomInt: () => 42,
      });
      const { code } = pairing.startPairing();
      const result = pairing.request({ code, name: 'a', client: 'b', ip: 'c' });

      expect(result.ok && result.request.verificationCode).toBe('000042');
    });

    it('refuses an expired code', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      h.advance(5 * MINUTE);

      expect(h.ask(code)).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a cancelled or made-up code', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      h.pairing.cancelPairing();

      expect(h.ask(code)).toEqual({ ok: false, reason: 'expired' });
      expect(h.ask('made-up')).toEqual({ ok: false, reason: 'invalid' });
      expect(h.pairing.hasActiveCode()).toBe(false);
    });
  });

  describe('status and respond', () => {
    it('is pending until the desktop answers', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));

      expect(h.pairing.status(id)).toBe('pending');
      expect(h.pairing.respond(id, true)).toBe(true);
      expect(h.pairing.status(id)).toBe('accepted');
    });

    it('hands an accepted request over exactly once', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      h.pairing.respond(id, true);

      expect(h.pairing.takeAccepted(id)?.name).toBe('iPhone');
      expect(h.pairing.takeAccepted(id)).toBeNull();
      expect(h.pairing.status(id)).toBeNull();
    });

    it('never hands over a request that was not accepted', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));

      expect(h.pairing.takeAccepted(id)).toBeNull();
      h.pairing.respond(id, false);
      expect(h.pairing.status(id)).toBe('rejected');
      expect(h.pairing.takeAccepted(id)).toBeNull();
    });

    it('cannot answer twice, nor answer an unknown request', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      h.pairing.respond(id, false);

      expect(h.pairing.respond(id, true)).toBe(false);
      expect(h.pairing.status(id)).toBe('rejected');
      expect(h.pairing.respond('ghost', true)).toBe(false);
    });

    it('auto-rejects an unanswered request when it expires', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      h.advance(MINUTE);

      expect(h.pairing.status(id)).toBe('expired');
      expect(h.pairing.respond(id, true)).toBe(false);
    });

    it('reports the expiry once, for the timer that notifies the desktop', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));

      expect(h.pairing.expire(id)).toBe(false);
      h.advance(MINUTE);
      expect(h.pairing.expire(id)).toBe(true);
      expect(h.pairing.expire(id)).toBe(false);
    });

    it('forgets a settled request a minute after it settled', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      h.pairing.respond(id, false);
      h.advance(MINUTE);

      expect(h.pairing.status(id)).toBeNull();
    });

    it('keeps an accepted request readable past its deadline for a while', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      h.advance(MINUTE - 1);
      h.pairing.respond(id, true);
      h.advance(30_000);

      expect(h.pairing.status(id)).toBe('accepted');
    });
  });

  describe('withdraw', () => {
    it('forgets a pending request the phone cancelled', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));

      expect(h.pairing.withdraw(id)).toBe(true);
      expect(h.pairing.status(id)).toBeNull();
      expect(h.pairing.respond(id, true)).toBe(false);
    });

    it('cannot withdraw a request that is no longer pending', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      h.pairing.respond(id, true);

      expect(h.pairing.withdraw(id)).toBe(false);
      expect(h.pairing.withdraw('ghost')).toBe(false);
      expect(h.pairing.status(id)).toBe('accepted');
    });
  });

  describe('clear', () => {
    it('drops the code and every pending request, returning the pending ids', () => {
      const h = harness();
      const id = requestIdOf(h.ask(h.pairing.startPairing().code));
      const { code } = h.pairing.startPairing();

      expect(h.pairing.clear()).toEqual([id]);
      expect(h.pairing.status(id)).toBeNull();
      expect(h.ask(code).ok).toBe(false);
    });
  });
});
