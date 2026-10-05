// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  fromB64,
  rotateMessage,
  safetyCode,
  verifySignature,
} from '../renderer/remote/rc-protocol.js';
import {
  LINKED,
  loadPage,
  pageHarness,
  settle,
  start,
  startLinked,
  state,
  tabButton,
  tap,
  tapId,
  text,
  type PageHarness,
} from './helpers/remote-page.js';

/**
 * Ajustes › «Seguridad» on the phone: the end-to-end encryption, a new key
 * per connection, this device's security code (the one the computer shows
 * for it), whether it was verified, and renewing this device's keys.
 */

async function openSecurity(): Promise<PageHarness> {
  const h = await startLinked();
  h.answer('settings.get', {
    status: 200,
    body: {
      autostart: false,
      notifySuccess: true,
      silenceWarnings: false,
      silenceErrors: false,
    },
  });
  tap(tabButton('settings'));
  await settle();
  return h;
}

/** The code the phone should show for the keys it holds right now. */
function expectedCode(h: PageHarness): string[] {
  const keys = h.keys() ?? {};
  return safetyCode(
    fromB64(keys.serverIdPub, 32) ?? new Uint8Array(),
    fromB64(keys.devicePub, 32) ?? new Uint8Array(),
  );
}

const shownCode = (): string[] =>
  [...(document.getElementById('security-code')?.children ?? [])].map(
    (group) => group.textContent ?? '',
  );

describe('renderer/remote/security-section.ts', () => {
  it('presents the encryption and the code of this device', async () => {
    const h = await openSecurity();

    const section = document.querySelector('.security-card');
    expect(section?.textContent).toContain('Cifrado de extremo a extremo');
    expect(section?.textContent).toContain('Clave nueva en cada conexión');
    expect(section?.querySelector('svg')).not.toBeNull();
    expect(shownCode()).toEqual(expectedCode(h));
    expect(shownCode()).toHaveLength(6);
    expect(text('security-status')).toBe('Sin verificar');
  });

  it('says «Verificado» once the code was scanned', async () => {
    loadPage();
    const h = pageHarness('/');
    h.seedKeys({ verified: true });
    h.answer('me', LINKED);
    h.answer('state', { status: 200, body: state() });
    h.answer('notices', { status: 200, body: { notices: [] } });
    h.answer('settings.get', new Error('offline'));
    await start(h);

    tap(tabButton('settings'));
    await settle();

    expect(text('security-status')).toBe('Verificado');
    expect(
      document
        .getElementById('security-status')
        ?.classList.contains('is-verified'),
    ).toBe(true);
  });

  it('renews the device keys after a confirmation, and is unverified again', async () => {
    const h = await openSecurity();
    const before = h.keys();
    h.answer('device.rotate', { status: 200, body: { ok: true } });

    tapId('rotate-keys');
    await settle();

    const [call] = h.callsTo('device.rotate');
    const sent = call?.body as { devicePub: string; sig: string };
    expect(h.confirms.at(-1)).toMatch(/Renovar las claves/);
    expect(sent.devicePub).toMatch(/^[\w-]{43}$/);
    expect(sent.devicePub).not.toBe(before?.devicePub);
    // The new key proves it is held, over this session's handshake.
    expect(
      verifySignature(
        fromB64(sent.devicePub, 32) ?? new Uint8Array(),
        rotateMessage(call?.transcript ?? new Uint8Array()),
        fromB64(sent.sig, 64) ?? new Uint8Array(),
      ),
    ).toBe(true);
    expect(h.keys()).toMatchObject({
      devicePub: sent.devicePub,
      verified: false,
      serverIdPub: before?.serverIdPub,
    });
    expect(h.keys()?.devicePriv).not.toBe(before?.devicePriv);
    expect(shownCode()).toEqual(expectedCode(h));
    expect(text('toast')).toBe(
      'Claves renovadas. Vuelve a verificar este dispositivo.',
    );
  });

  it('signs in with the new key on the next connection', async () => {
    const h = await openSecurity();
    h.answer('device.rotate', { status: 200, body: { ok: true } });
    tapId('rotate-keys');
    await settle();
    h.dropSessions();

    h.source().emit('error');
    // The toast's timer comes first, then the reconnect.
    await h.tick();
    await h.tick();

    expect(h.callsTo('auth')).toHaveLength(2);
    expect(h.sources).toHaveLength(2);
    expect(document.body.dataset.screen).toBe('linked');
  });

  it('keeps the old keys when the user changes their mind or DevBar refuses', async () => {
    const h = await openSecurity();
    const before = h.keys();
    h.refuseConfirm();
    tapId('rotate-keys');
    await settle();
    expect(h.callsTo('device.rotate')).toEqual([]);

    const again = await openSecurity();
    const keys = again.keys();
    again.answer('device.rotate', { status: 500, body: { error: 'x' } });
    tapId('rotate-keys');
    await settle();

    expect(again.keys()).toEqual(keys);
    expect(text('toast')).toBe('No se pudieron renovar las claves.');
    expect(before).not.toBeNull();
  });

  it('keeps every key on a 401 that a fresh sign-in does not confirm', async () => {
    const h = await openSecurity();
    const before = h.keys();
    h.answer('device.rotate', { status: 401, body: { error: 'unlinked' } });

    tapId('rotate-keys');
    await settle();

    expect(h.keys()).toEqual(before);
    expect(document.body.dataset.screen).toBe('linked');
    expect(text('toast')).toBe('Conexión perdida, inténtalo de nuevo.');
  });
});
