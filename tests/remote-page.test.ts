// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fromB64,
  generateSigningKey,
  pairMessage,
  toB64,
  verifySignature,
} from '../renderer/remote/rc-protocol.js';
import {
  LINKED,
  loadPage,
  pageHarness,
  pairingHarness,
  settle,
  start,
  startLinked,
  state,
  text,
  UNLINKED,
  visibleView,
} from './helpers/remote-page.js';

/**
 * The phone page (`renderer/remote.html` + `renderer/remote/app.ts`) against
 * a real devbar-rc/1 server (tests/helpers/remote-page.ts): which view a
 * browser lands on for the keys it holds and where it was opened — the
 * panel, pairing from a QR, a changed computer key — and what it sends.
 * Verifying a security code is tests/remote-verify.test.ts; the linked
 * panel has suites of its own (tests/remote-*.test.ts).
 */

const harness = pageHarness;
const input = (id: string): HTMLInputElement =>
  document.getElementById(id) as HTMLInputElement;
const click = (id: string): void => {
  document
    .getElementById(id)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const submit = (): void => {
  document
    .getElementById('pair-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};
const linkedAnswers = (h: ReturnType<typeof harness>): void => {
  h.answer('me', LINKED);
  h.answer('state', { status: 200, body: state() });
  h.answer('notices', { status: 200, body: { notices: [] } });
};

describe('renderer/remote/app.ts', () => {
  beforeEach(() => {
    loadPage();
  });

  describe('first load', () => {
    it('explains how to link a browser with no keys, asking DevBar nothing', async () => {
      const h = harness();

      await start(h);

      expect(visibleView()).toBe('unlinked');
      expect(text('unlinked-title')).toBe('Este dispositivo no está vinculado');
      expect(
        document
          .getElementById('expired-note')
          ?.classList.contains('is-emphasised'),
      ).toBe(false);
      expect([h.hellos(), h.calls.length]).toEqual([0, 0]);
    });

    it('shakes hands with the pinned key, signs in and shows the panel', async () => {
      const h = harness();
      h.seedKeys();
      linkedAnswers(h);

      await start(h);

      expect(visibleView()).toBe('linked');
      expect(text('host-name')).toBe('Mac-de-Ana');
      expect(h.hellos()).toBe(1);
      expect(h.calls.map((c) => c.op).slice(0, 2)).toEqual(['auth', 'me']);
      // The sid names the session; `n` and `ct` prove the phone holds its keys.
      expect(h.source().url).toMatch(
        /^\/api\/events\?sid=[\w-]{22}&n=\d+&ct=[\w-]+$/,
      );
    });

    it('never hides the page itself while it switches views', async () => {
      const h = harness();
      h.seedKeys();
      linkedAnswers(h);

      await start(h);

      expect(document.body.hidden).toBe(false);
      expect(document.body.dataset.screen).toBe('linked');
    });

    it('offers a retry when DevBar cannot be reached', async () => {
      const h = harness();
      h.seedKeys();
      h.answer('me', new Error('offline'));
      linkedAnswers(h);

      await start(h);
      expect(visibleView()).toBe('error');

      click('retry');
      await settle();
      expect(visibleView()).toBe('linked');
    });

    it('treats an unexpected answer as unreachable', async () => {
      const h = harness();
      h.seedKeys();
      h.answer('me', { status: 500, body: { error: 'internal' } });

      await start(h);

      expect(visibleView()).toBe('error');
    });

    it('forgets its keys when the computer no longer knows it', async () => {
      const h = harness();
      h.seedKeys();
      h.forgetDevice();

      await start(h);

      expect(visibleView()).toBe('unlinked');
      expect(h.keys()).toBeNull();
    });

    it('lands on «not linked» when the browser refuses localStorage', async () => {
      const h = harness('/', { storage: 'broken' });
      h.storage?.clear();

      await start(h);

      expect(visibleView()).toBe('unlinked');
    });
  });

  describe('a changed computer key', () => {
    it('stops before sending anything, and says whose key changed', async () => {
      const h = harness();
      h.seedKeys();
      h.renewIdentity();

      await start(h);

      expect(visibleView()).toBe('keychanged');
      expect(text('keychanged-title')).toBe(
        'La clave de seguridad de Mac-de-Ana ha cambiado',
      );
      expect(h.calls).toEqual([]);
      // The keys stay: scanning the new code is how the phone gets back.
      expect(h.keys()).not.toBeNull();

      click('keychanged-retry');
      await settle();
      expect(visibleView()).toBe('keychanged');
      expect(h.calls).toEqual([]);
    });

    it('stops there too when a reconnect meets the new key', async () => {
      const h = await startLinked();
      h.renewIdentity();

      h.source().emit('error');
      await h.tick();

      expect(visibleView()).toBe('keychanged');
      expect(h.pending()).toBe(0);
    });
  });

  describe('a session DevBar forgot', () => {
    const stop = async (): Promise<void> => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Detener API"]')
        ?.click();
      await settle();
    };

    it('never resends a command on its own: it may have run already', async () => {
      const h = await startLinked();
      h.answer('process.stop', { status: 200, body: { ok: true } });
      h.dropSessions();

      await stop();

      expect(h.callsTo('process.stop')).toHaveLength(0);
      expect(text('toast')).toBe('Conexión perdida, inténtalo de nuevo.');
      expect(visibleView()).toBe('linked');
      // Trying again goes out on a fresh session.
      await stop();
      expect(h.callsTo('process.stop')).toHaveLength(1);
      expect(h.hellos()).toBe(2);
    });

    it('re-reads the state on a fresh session, transparently', async () => {
      const h = await startLinked();
      h.dropSessions();
      const before = h.callsTo('state').length;

      h.source().emit('error');
      await h.tick();

      expect(h.callsTo('state').length).toBeGreaterThanOrEqual(before);
      expect(visibleView()).toBe('linked');
    });
  });

  describe('being told it is unlinked', () => {
    it('keeps its keys while a fresh sign-in still works (a stray answer)', async () => {
      const h = await startLinked();
      const keys = h.keys();

      h.source().emit('unlinked');
      await settle();

      expect(h.keys()).toEqual(keys);
      expect(h.callsTo('auth')).toHaveLength(2);
      expect(h.reloads()).toBe(1);
    });

    it('forgets them once a fresh sign-in says the device is unknown', async () => {
      const h = await startLinked();
      h.forgetDevice();

      h.source().emit('unlinked');
      await settle();

      expect(visibleView()).toBe('unlinked');
      expect(h.keys()).toBeNull();
    });

    it('keeps them when a command answers 401 but the sign-in still works', async () => {
      const h = await startLinked();
      const keys = h.keys();
      h.answer('process.stop', { status: 401, body: { error: 'unlinked' } });

      document
        .querySelector<HTMLButtonElement>('[aria-label="Detener API"]')
        ?.click();
      await settle();

      expect(visibleView()).toBe('linked');
      expect(h.keys()).toEqual(keys);
      expect(text('toast')).toBe('Conexión perdida, inténtalo de nuevo.');
    });
  });

  describe('pairing', () => {
    async function pairing(
      options: Parameters<typeof pairingHarness>[1] = {},
    ): Promise<ReturnType<typeof harness>> {
      const h = pairingHarness('CODE123', options);
      h.answer('me', UNLINKED);
      await start(h);
      return h;
    }

    it('takes the code and the key out of the address bar at once', async () => {
      const h = await pairing();

      expect(h.urls[0]).toBe('/');
    });

    it('asks for a name, prefilled from the device', async () => {
      await pairing();

      expect(visibleView()).toBe('pair');
      expect(text('pair-title')).toBe('Vincular con Mac-de-Ana');
      expect(input('device-name').value).toBe('iPhone');
    });

    it('sends the code, the name and a fresh device key, sealed', async () => {
      const h = await pairing();
      h.answer('pair.request', {
        status: 200,
        body: { requestId: 'r1', verificationCode: '482913', expiresAt: 1 },
      });
      input('device-name').value = '  iPhone de Ana ';

      submit();
      await settle();

      const sent = h.callsTo('pair.request')[0]?.body as Record<string, string>;
      expect(sent).toEqual({
        code: 'CODE123',
        name: 'iPhone de Ana',
        devicePub: expect.stringMatching(/^[\w-]{43}$/) as unknown,
        sig: expect.stringMatching(/^[\w-]{86}$/) as unknown,
      });
      expect(visibleView()).toBe('waiting');
      expect(text('verification-code')).toBe('482 913');
      expect(
        document.querySelector('[data-view="waiting"]')?.textContent,
      ).toContain('Escribe este código en el ordenador');
      // The spent code leaves the address bar: a reload must not reuse it.
      expect(h.urls.at(-1)).toBe('/');
    });

    it('proves it holds the key it asks to be paired with', async () => {
      const h = await pairing();
      h.answer('pair.request', {
        status: 200,
        body: { requestId: 'r1', verificationCode: '482913', expiresAt: 1 },
      });

      submit();
      await settle();

      const [call] = h.callsTo('pair.request');
      const sent = call?.body as Record<string, string>;
      const key = fromB64(sent.devicePub, 32) ?? new Uint8Array();
      const sig = fromB64(sent.sig, 64) ?? new Uint8Array();
      const t = call?.transcript ?? new Uint8Array();
      // Signed by the new key over this very session's handshake.
      expect(verifySignature(key, pairMessage(t), sig)).toBe(true);
      expect(
        verifySignature(key, pairMessage(new Uint8Array(t.length)), sig),
      ).toBe(false);
    });

    it('refuses an empty name without asking the server', async () => {
      const h = await pairing();
      input('device-name').value = '   ';

      submit();
      await settle();

      expect(h.callsTo('pair.request')).toEqual([]);
      expect(text('pair-error')).toBe('Ponle un nombre de 1 a 40 caracteres.');
    });

    it('will not pair a browser that cannot keep the keys', async () => {
      const h = await pairing({ storage: 'broken' });

      submit();
      await settle();

      expect(h.callsTo('pair.request')).toEqual([]);
      expect(text('pair-error')).toMatch(/no deja guardar datos/);
    });

    it('refuses to pair with a DevBar that does not hold the key of the QR', async () => {
      const h = pageHarness('/pair');
      h.env.hash = `#c=CODE123&k=${toB64(generateSigningKey().publicKey)}`;

      await start(h);

      expect(visibleView()).toBe('result');
      expect(text('result-title')).toBe('No se pudo verificar el ordenador');
      expect(h.calls).toEqual([]);
    });

    it.each([
      ['an old link, the code in the query', '/pair?c=CODE123', ''],
      ['a code without its key', '/pair', '#c=CODE123'],
      ['a key without its code', '/pair', '#k=AAAA'],
    ])('trusts no QR link with %s', async (_name, url, hash) => {
      const h = pageHarness(url);
      h.env.hash = hash;

      await start(h);

      expect(visibleView()).toBe('unlinked');
      expect(
        document
          .getElementById('expired-note')
          ?.classList.contains('is-emphasised'),
      ).toBe(true);
      expect(h.hellos()).toBe(0);
    });

    it('sends a stale code back to the explanation, with the QR note stressed', async () => {
      const h = await pairing();
      h.answer('pair.request', { status: 410, body: { error: 'expired' } });

      submit();
      await settle();

      expect(visibleView()).toBe('unlinked');
      expect(
        document
          .getElementById('expired-note')
          ?.classList.contains('is-emphasised'),
      ).toBe(true);
    });

    it.each([
      [
        429,
        { error: 'rate-limited' },
        'Demasiados intentos. Espera un minuto y vuelve a probar.',
      ],
      [400, { error: 'invalid-name' }, 'Ponle un nombre de 1 a 40 caracteres.'],
      [
        500,
        { error: 'internal' },
        'No se pudo conectar con DevBar. Inténtalo de nuevo.',
      ],
    ])('explains a %i answer on the form', async (status, body, message) => {
      const h = await pairing();
      h.answer('pair.request', { status, body });

      submit();
      await settle();

      expect(visibleView()).toBe('pair');
      expect(text('pair-error')).toBe(message);
      expect(
        (document.getElementById('pair-submit') as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    describe('waiting for the computer', () => {
      async function waiting(): Promise<ReturnType<typeof harness>> {
        const h = await pairing();
        h.answer('pair.request', {
          status: 200,
          body: { requestId: 'r1', verificationCode: '482913', expiresAt: 1 },
        });
        submit();
        await settle();
        return h;
      }

      it('polls every second until accepted, keeps the keys, signs in and shows linked', async () => {
        const h = await waiting();
        const devicePub = String(
          (h.callsTo('pair.request')[0]?.body as { devicePub: string })
            .devicePub,
        );
        h.knowDevice('d1', devicePub);
        h.answer(
          'pair.status',
          { status: 200, body: { status: 'pending' } },
          { status: 200, body: { status: 'accepted', deviceId: 'd1' } },
        );
        linkedAnswers(h);

        await h.tick();
        expect(visibleView()).toBe('waiting');
        await h.tick();

        expect(h.callsTo('pair.status').map((c) => c.body)).toEqual([
          { requestId: 'r1' },
          { requestId: 'r1' },
        ]);
        expect(h.keys()).toMatchObject({
          serverIdPub: h.serverKey(),
          deviceId: 'd1',
          devicePub,
          verified: false,
          hostName: 'Mac-de-Ana',
        });
        expect(h.callsTo('auth')).toHaveLength(1);
        expect(visibleView()).toBe('linked');
      });

      it('says so when the computer rejects it', async () => {
        const h = await waiting();
        h.answer('pair.status', { status: 200, body: { status: 'rejected' } });

        await h.tick();

        expect(visibleView()).toBe('result');
        expect(text('result-title')).toBe('Vinculación rechazada');
        expect(h.pending()).toBe(0);
        expect(h.keys()).toBeNull();
      });

      it('says so when nobody answers in time', async () => {
        const h = await waiting();
        h.answer('pair.status', {
          status: 404,
          body: { error: 'unknown-request' },
        });

        await h.tick();

        expect(visibleView()).toBe('result');
        expect(text('result-title')).toBe('La solicitud ha caducado');

        click('result-done');
        expect(visibleView()).toBe('unlinked');
      });

      it('keeps polling through a dropped request, then gives up', async () => {
        const h = await waiting();
        h.answer('pair.status', new Error('wifi blip'));

        for (let i = 0; i < 4; i++) await h.tick();
        expect(visibleView()).toBe('waiting');
        await h.tick();

        expect(visibleView()).toBe('error');
        expect(h.pending()).toBe(0);
      });

      it('stops waiting on «Cancelar», and tells the computer', async () => {
        const h = await waiting();
        h.answer('pair.cancel', { status: 200, body: { ok: true } });

        click('pair-cancel');
        await settle();

        expect(visibleView()).toBe('unlinked');
        expect(h.callsTo('pair.cancel')[0]?.body).toEqual({ requestId: 'r1' });
        // The poll is cancelled, not merely ignored.
        expect(h.pending()).toBe(0);
      });
    });
  });
});

/** jsdom has no EventSource; the page only needs one that stays quiet. */
class FakeEventSource {
  static opened: string[] = [];
  constructor(url: string) {
    FakeEventSource.opened.push(url);
  }
  addEventListener(): void {}
  close(): void {}
}

describe('renderer/remote.ts', () => {
  /** Serves the real page with the browser's own globals stubbed. */
  async function boot(
    url: string,
    prepare: (h: ReturnType<typeof harness>) => void,
  ) {
    loadPage();
    window.history.replaceState(null, '', url);
    const h = pageHarness(url);
    prepare(h);
    const keys = h.storage?.get('devbar.remote.keys');
    if (keys) window.localStorage.setItem('devbar.remote.keys', keys);
    vi.stubGlobal('fetch', h.env.fetch);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.resetModules();
    await import('../renderer/remote.js');
    await settle();
    return h;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    FakeEventSource.opened = [];
  });

  it('boots against the browser globals and clears the code and key from the URL', async () => {
    const h = await boot('/pair', (fake) => {
      window.history.replaceState(
        null,
        '',
        `/pair#c=CODE&k=${fake.serverKey()}`,
      );
      fake.answer('me', UNLINKED);
      fake.answer('pair.request', {
        status: 200,
        body: { requestId: 'r1', verificationCode: '123456', expiresAt: 1 },
      });
    });
    const clearTimer = vi.spyOn(window, 'clearTimeout');

    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/');
    expect(visibleView()).toBe('pair');
    submit();
    await settle();

    expect(h.callsTo('pair.request')).toHaveLength(1);
    expect(visibleView()).toBe('waiting');
    expect(window.location.pathname + window.location.search).toBe('/');
    expect(window.localStorage.getItem('devbar.remote.probe')).toBeNull();
    click('pair-cancel');
    expect(clearTimer).toHaveBeenCalled();
  });

  it('asks the browser to confirm before unlinking', async () => {
    await boot('/', (fake) => {
      fake.seedKeys();
      linkedAnswers(fake);
    });
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);

    click('unlink');

    expect(asked).toHaveBeenCalledOnce();
    expect(visibleView()).toBe('linked');
    expect(FakeEventSource.opened).toHaveLength(1);
    expect(FakeEventSource.opened[0]).toMatch(/^\/api\/events\?sid=/);
  });

  it('stops its clock once the device is unlinked, and forgets its keys', async () => {
    await boot('/', (fake) => {
      fake.seedKeys();
      linkedAnswers(fake);
      fake.answer('unlink', { status: 200, body: { ok: true } });
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const stopClock = vi.spyOn(window, 'clearInterval');

    click('unlink');
    await settle();

    expect(visibleView()).toBe('unlinked');
    expect(stopClock).toHaveBeenCalled();
    expect(window.localStorage.getItem('devbar.remote.keys')).toBeNull();
  });
});
