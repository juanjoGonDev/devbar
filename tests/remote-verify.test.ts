// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSigningKey, toB64 } from '../renderer/remote/rc-protocol.js';
import {
  LINKED,
  loadPage,
  pageHarness,
  settle,
  start,
  state,
  visibleView,
} from './helpers/remote-page.js';

/**
 * `/verify#k=…&d=…&p=…&t=…`, the QR of a device's «Código de seguridad»
 * opened with the phone's camera: the phone compares the computer's key, its
 * own device id and its own key with what it holds — verifying the
 * connection, re-pinning a renewed computer key, or saying the code does not
 * match — and hands the one-time token `t` back so the computer can tell it
 * was scanned.
 */

const TOKEN = 'dG9rZW4tb2YtdGhlLXFyLTE';

function verifyPage(fragment: (keys: { k: string; p: string }) => string) {
  const h = pageHarness('/verify');
  const device = h.seedKeys();
  h.env.hash = `#${fragment({ k: h.serverKey(), p: toB64(device.publicKey) })}`;
  return h;
}

const other = (): string => toB64(generateSigningKey().publicKey);

describe('renderer/remote/verify-flow.ts', () => {
  beforeEach(() => {
    loadPage();
  });

  it('verifies a matching code, tells the computer and leaves the URL clean', async () => {
    const h = verifyPage(({ k, p }) => `k=${k}&d=d1&p=${p}&t=${TOKEN}`);
    h.answer('verify.done', { status: 200, body: { ok: true } });

    await start(h);

    expect(visibleView()).toBe('verified');
    expect(h.keys()?.verified).toBe(true);
    // The token of the QR goes back inside the sealed channel.
    expect(h.callsTo('verify.done').map((call) => call.body)).toEqual([
      { t: TOKEN },
    ]);
    expect(document.getElementById('verified-note')?.hidden).toBe(true);
    expect(h.urls[0]).toBe('/');
  });

  it('says the computer could not be told when it refuses the token', async () => {
    const h = verifyPage(({ k, p }) => `k=${k}&d=d1&p=${p}`);
    h.answer('verify.done', { status: 403, body: { error: 'invalid-token' } });

    await start(h);

    expect(visibleView()).toBe('verified');
    expect(h.callsTo('verify.done').map((call) => call.body)).toEqual([{}]);
    expect(document.getElementById('verified-note')?.hidden).toBe(false);
  });

  it('keeps it verified here even when the computer cannot be told', async () => {
    const h = verifyPage(({ k, p }) => `k=${k}&d=d1&p=${p}`);
    h.answer('verify.done', new Error('offline'));

    await start(h);

    expect(visibleView()).toBe('verified');
    expect(h.keys()?.verified).toBe(true);
    expect(document.getElementById('verified-note')?.hidden).toBe(false);
  });

  it.each([
    [
      'another device',
      ({ k, p }: { k: string; p: string }) => `k=${k}&d=d2&p=${p}`,
    ],
    [
      'another device key',
      ({ k }: { k: string; p: string }) => `k=${k}&d=d1&p=${other()}`,
    ],
    ['a garbled code', () => 'k=nope&d=d1&p=nope'],
    ['an empty fragment', () => ''],
  ])(
    'says the code does not match for %s, marking nothing',
    async (_name, fragment) => {
      const h = verifyPage(fragment);

      await start(h);

      expect(visibleView()).toBe('mismatch');
      expect(h.keys()?.verified).toBe(false);
      expect(h.hellos()).toBe(0);
    },
  );

  it('says the code does not match on a phone with no keys at all', async () => {
    const h = pageHarness('/verify');
    h.env.hash = `#k=${h.serverKey()}&d=d1&p=${other()}`;

    await start(h);

    expect(visibleView()).toBe('mismatch');
  });

  it('re-pins a renewed computer key once DevBar proves it holds it', async () => {
    const h = verifyPage(({ p }) => `d=d1&p=${p}`);
    const before = h.keys()?.serverIdPub;
    h.renewIdentity();
    h.env.hash = `${h.env.hash}&k=${h.serverKey()}`;
    h.answer('verify.done', { status: 200, body: { ok: true } });

    await start(h);

    expect(visibleView()).toBe('verified');
    expect(h.keys()).toMatchObject({
      serverIdPub: h.serverKey(),
      verified: true,
    });
    expect(h.keys()?.serverIdPub).not.toBe(before);
    expect(h.callsTo('verify.done')).toHaveLength(1);
  });

  it('never re-pins a key the computer does not hold', async () => {
    const h = verifyPage(({ p }) => `k=${other()}&d=d1&p=${p}`);
    const before = h.keys();

    await start(h);

    expect(visibleView()).toBe('mismatch');
    expect(h.keys()).toEqual(before);
    expect(h.callsTo('verify.done')).toEqual([]);
  });

  it('forgets a device the computer no longer knows', async () => {
    const h = verifyPage(({ k, p }) => `k=${k}&d=d1&p=${p}`);
    h.forgetDevice();

    await start(h);

    expect(visibleView()).toBe('unlinked');
    expect(h.keys()).toBeNull();
  });

  it('goes on to the panel from the success screen', async () => {
    const h = verifyPage(({ k, p }) => `k=${k}&d=d1&p=${p}`);
    h.answer('verify.done', { status: 200, body: { ok: true } });
    h.answer('me', LINKED);
    h.answer('state', { status: 200, body: state() });
    h.answer('notices', { status: 200, body: { notices: [] } });
    await start(h);

    document.getElementById('verified-done')?.click();
    await settle();

    expect(visibleView()).toBe('linked');
  });
});
