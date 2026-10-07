// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fromB64,
  generateSigningKey,
  replaceMessage,
  toB64,
  verifySignature,
} from '../renderer/remote/rc-protocol.js';
import {
  LINKED,
  loadPage,
  pairingHarness,
  settle,
  start,
  state,
  text,
  UNLINKED,
  visibleView,
  type PageHarness,
} from './helpers/remote-page.js';

/**
 * Pairing from the QR, on the phone (renderer/remote/pair-flow.ts), beyond
 * the basics of tests/remote-page.test.ts: the countdown of a request the
 * computer has not answered yet, and a phone that scans a QR while it is
 * still linked — or holds the keys of an earlier link it can no longer use.
 */

const SECOND = 1000;
const CLAIMED = { status: 200, body: { expiresAt: 1 } };

const submit = (): void => {
  document
    .getElementById('pair-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};
const click = (id: string): void => {
  document
    .getElementById(id)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const linkedAnswers = (h: PageHarness): void => {
  h.answer('me', LINKED);
  h.answer('state', { status: 200, body: state() });
  h.answer('notices', { status: 200, body: { notices: [] } });
};
const element = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found;
};
const barWidth = (): string => element('pair-expiry-bar').style.width;

/** A QR scanned on a phone with no keys, the code claimed, the form up. */
async function atTheForm(prepare: (h: PageHarness) => void = () => undefined) {
  const h = pairingHarness('CODE123');
  prepare(h);
  h.answer('me', UNLINKED);
  h.answer('pair.claim', CLAIMED);
  await start(h);
  return h;
}

/** The form sent; DevBar answered `body` to the request. */
async function waiting(
  body: Record<string, unknown> = { expiresInMs: 60 * SECOND },
  prepare: (h: PageHarness) => void = () => undefined,
) {
  const h = await atTheForm(prepare);
  h.answer('pair.request', {
    status: 200,
    body: { requestId: 'r1', verificationCode: '482913', ...body },
  });
  submit();
  await settle();
  return h;
}

describe('renderer/remote/pair-flow.ts', () => {
  beforeEach(() => {
    loadPage();
  });

  describe('the countdown while the computer decides', () => {
    it('starts from the time left the computer sent', async () => {
      await waiting();

      expect(visibleView()).toBe('waiting');
      expect(text('pair-expiry-text')).toBe('Caduca en 1:00');
      expect(barWidth()).toBe('100%');
      expect(element('pair-expiry').hidden).toBe(false);
    });

    it('ticks down on the phone clock, every second', async () => {
      const h = await waiting();

      h.advance(18 * SECOND);
      h.beat();

      expect(text('pair-expiry-text')).toBe('Caduca en 0:42');
      expect(barWidth()).toBe('70%');
      expect(element('pair-expiry').classList.contains('is-ending')).toBe(
        false,
      );
      h.advance(41 * SECOND);
      h.beat();
      expect(text('pair-expiry-text')).toBe('Caduca en 0:01');
      expect(element('pair-expiry').classList.contains('is-ending')).toBe(true);
    });

    it('ignores how far off the phone clock is, and any deadline', async () => {
      // Hours apart: only the time left, measured here, counts.
      const h = await waiting(
        { expiresInMs: 30 * SECOND, expiresAt: 1 },
        (fake) => fake.advance(5 * 60 * 60 * SECOND),
      );

      expect(text('pair-expiry-text')).toBe('Caduca en 0:30');
      h.advance(10 * SECOND);
      h.beat();
      expect(text('pair-expiry-text')).toBe('Caduca en 0:20');
    });

    describe('at zero, a few seconds more for the computer to have the last word', () => {
      /** Waiting, the phone's minute just run out. */
      async function atZero(): Promise<PageHarness> {
        const h = await waiting();
        h.advance(60 * SECOND);
        h.beat();
        return h;
      }

      it('says it is checking, and keeps asking the computer', async () => {
        const h = await atZero();

        expect(visibleView()).toBe('waiting');
        expect(text('pair-expiry-text')).toBe('Comprobando…');
        expect(barWidth()).toBe('0%');
        expect([h.running(), h.pending()]).toEqual([1, 1]);
      });

      it('still links the device the computer accepted at the last second', async () => {
        const h = await atZero();
        const devicePub = String(
          (h.callsTo('pair.request')[0]?.body as { devicePub: string })
            .devicePub,
        );
        h.knowDevice('d1', devicePub);
        h.answer('pair.status', {
          status: 200,
          body: { status: 'accepted', deviceId: 'd1' },
        });
        linkedAnswers(h);
        h.advance(SECOND);

        await h.tick();

        expect(visibleView()).toBe('linked');
        expect(h.keys()).toMatchObject({ deviceId: 'd1', devicePub });
      });

      it('shows a rejection the computer reports meanwhile', async () => {
        const h = await atZero();
        h.answer('pair.status', { status: 200, body: { status: 'rejected' } });

        await h.tick();

        expect(text('result-title')).toBe('Vinculación rechazada');
        expect([h.running(), h.pending()]).toEqual([0, 0]);
      });

      it("takes the computer's word that it expired, at once", async () => {
        const h = await atZero();
        h.answer('pair.status', { status: 200, body: { status: 'expired' } });

        await h.tick();

        expect(text('result-title')).toBe('La solicitud ha caducado');
        expect([h.running(), h.pending()]).toEqual([0, 0]);
      });

      it('shows the expired request once five seconds pass with no answer', async () => {
        const h = await atZero();
        h.answer('pair.status', { status: 200, body: { status: 'pending' } });
        await h.tick();

        h.advance(4 * SECOND);
        h.beat();
        expect(visibleView()).toBe('waiting');
        h.advance(SECOND);
        h.beat();

        expect(visibleView()).toBe('result');
        expect(text('result-title')).toBe('La solicitud ha caducado');
        expect([h.running(), h.pending()]).toEqual([0, 0]);
      });
    });

    it('never announces the ticking number', async () => {
      await waiting();

      const expiry = element('pair-expiry');
      expect(
        expiry.closest('[aria-live], [role="status"], [role="alert"]'),
      ).toBe(null);
      expect(expiry.querySelector('[aria-live]')).toBeNull();
      expect(
        element('pair-expiry-bar').closest('[aria-hidden="true"]'),
      ).not.toBeNull();
    });

    it('shows no countdown when the computer sent no time left', async () => {
      const h = await waiting({});

      expect(visibleView()).toBe('waiting');
      expect(element('pair-expiry').hidden).toBe(true);
      expect(h.running()).toBe(0);
    });

    it('stops once the computer accepts', async () => {
      const h = await waiting();
      const devicePub = String(
        (h.callsTo('pair.request')[0]?.body as { devicePub: string }).devicePub,
      );
      h.knowDevice('d1', devicePub);
      h.answer('pair.status', {
        status: 200,
        body: { status: 'accepted', deviceId: 'd1' },
      });
      linkedAnswers(h);

      await h.tick();

      expect(visibleView()).toBe('linked');
      // The panel's own 1 s clock is the only interval left.
      expect(h.running()).toBe(1);
    });

    it('stops once the computer rejects', async () => {
      const h = await waiting();
      h.answer('pair.status', { status: 200, body: { status: 'rejected' } });

      await h.tick();

      expect(text('result-title')).toBe('Vinculación rechazada');
      expect(h.running()).toBe(0);
    });

    it('stops when the phone leaves the screen («Cancelar»)', async () => {
      const h = await waiting();
      h.answer('pair.cancel', { status: 200, body: { ok: true } });

      click('pair-cancel');
      await settle();

      expect(visibleView()).toBe('unlinked');
      expect(h.running()).toBe(0);
    });
  });

  describe('a phone that is still linked', () => {
    it('signs in with its keys and goes to the panel without spending the code', async () => {
      const h = pairingHarness('CODE123');
      h.seedKeys();
      linkedAnswers(h);

      await start(h);

      expect(h.calls.map((c) => c.op)).not.toContain('pair.claim');
      expect(h.callsTo('auth').length).toBeGreaterThan(0);
      expect(visibleView()).toBe('linked');
      expect(text('toast')).toBe('Este dispositivo ya está vinculado');
      expect(element('toast').hidden).toBe(false);
      expect(h.urls[0]).toBe('/');
      expect(h.keys()).toMatchObject({ deviceId: 'd1' });
    });

    it('forgets keys the computer no longer knows, and pairs as new', async () => {
      const h = pairingHarness('CODE123');
      h.seedKeys();
      h.forgetDevice();
      h.answer('me', UNLINKED);
      h.answer('pair.claim', CLAIMED);

      await start(h);

      expect(h.keys()).toBeNull();
      expect(h.calls.map((c) => c.op)).toEqual(['auth', 'me', 'pair.claim']);
      expect(visibleView()).toBe('pair');
    });

    it('sends no previous device once its keys were forgotten', async () => {
      const h = pairingHarness('CODE123');
      h.seedKeys();
      h.forgetDevice();
      h.answer('me', UNLINKED);
      h.answer('pair.claim', CLAIMED);
      h.answer('pair.request', {
        status: 200,
        body: { requestId: 'r1', verificationCode: '482913' },
      });
      await start(h);

      submit();
      await settle();

      expect(h.callsTo('pair.request')[0]?.body).not.toHaveProperty('previous');
    });

    it('offers a retry, and pairs nothing, when the sign-in fails otherwise', async () => {
      const h = pairingHarness('CODE123');
      h.seedKeys();
      // Another key for d1 on the computer: the proof does not verify.
      h.knowDevice('d1', toB64(generateSigningKey().publicKey));

      await start(h);

      expect(visibleView()).toBe('error');
      expect(h.calls.map((c) => c.op)).toEqual(['auth']);
      expect(h.keys()).toMatchObject({ deviceId: 'd1' });
    });
  });

  describe('a phone whose computer renewed its key', () => {
    it('pairs again, proving with its old key which device it replaces', async () => {
      const old = generateSigningKey();
      const h = await waiting({ expiresInMs: 60 * SECOND }, (fake) => {
        fake.seedKeys({
          serverIdPub: toB64(generateSigningKey().publicKey),
          devicePriv: toB64(old.secretKey),
          devicePub: toB64(old.publicKey),
        });
      });

      const [call] = h.callsTo('pair.request');
      const { previous } = call?.body as {
        previous: { deviceId: string; proof: string };
      };
      expect(previous.deviceId).toBe('d1');
      const proof = fromB64(previous.proof, 64) ?? new Uint8Array();
      const t = call?.transcript ?? new Uint8Array();
      expect(verifySignature(old.publicKey, replaceMessage(t), proof)).toBe(
        true,
      );
      // It never tried to sign in with keys pinned to another key.
      expect(h.callsTo('auth')).toEqual([]);
    });

    it('keeps the new keys once accepted', async () => {
      const h = await waiting({ expiresInMs: 60 * SECOND }, (fake) => {
        fake.seedKeys({ serverIdPub: toB64(generateSigningKey().publicKey) });
      });
      const devicePub = String(
        (h.callsTo('pair.request')[0]?.body as { devicePub: string }).devicePub,
      );
      h.knowDevice('d2', devicePub);
      h.answer('pair.status', {
        status: 200,
        body: { status: 'accepted', deviceId: 'd2' },
      });
      linkedAnswers(h);

      await h.tick();

      expect(h.keys()).toMatchObject({
        serverIdPub: h.serverKey(),
        deviceId: 'd2',
        devicePub,
      });
    });
  });
});
