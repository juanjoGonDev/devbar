import { describe, expect, it } from 'vitest';
import type { RemoteStatus } from '../src/ipc-contract/remote-api.js';
import { fakeKeychain, settle } from './helpers/fake-keychain.js';
import { toB64 } from '../src/main/remote/rc-protocol.js';
import {
  harness,
  linkPhone,
  pairingLink,
} from './helpers/remote-control-harness.js';

/**
 * «Control remoto» while the OS keychain has not answered yet: on macOS a
 * build it does not know asks the user first («DevBar quiere usar
 * información confidencial…»), for as long as the prompt stays open. The
 * app must keep running meanwhile — the boot start returns at once, the
 * section says it is waiting — and whatever the user does in the meantime
 * (the switch twice, a new port, quitting, renewing the key) waits its
 * turn: one identity, one server, and the stored key never replaced.
 */

const KEY_ERROR =
  'No se pudo leer la clave de seguridad del llavero del sistema. Desbloquéalo y pulsa Reintentar.';

/** A run that left the switch on with its identity sealed in `keychain`. */
async function sealedRun(keychain = fakeKeychain()) {
  const first = harness(undefined, { secretBox: keychain });
  await first.remote.setEnabled(true);
  first.remote.close();
  keychain.calls.length = 0;
  return { keychain, state: structuredClone(first.stored()) };
}

/** The next launch, with the keychain prompt open (nobody answered yet). */
async function launchWaiting() {
  const { keychain, state } = await sealedRun();
  keychain.hold();
  const h = harness(state, { secretBox: keychain });
  return { h, keychain, state };
}

const pushed = (h: ReturnType<typeof harness>) =>
  h.lastOn('remote:changed') as RemoteStatus | undefined;
const starts = (h: ReturnType<typeof harness>) =>
  h.lifecycle.filter((step) => step.startsWith('start:'));

describe('src/main/remote/remote-control.ts', () => {
  describe('waiting on the keychain', () => {
    it('returns from the boot start while the keychain prompt is still open', async () => {
      const { h, keychain } = await launchWaiting();
      let finished = false;

      const boot = h.remote.startIfEnabled().then(() => {
        finished = true;
      });
      await settle();

      expect(keychain.pending()).toBe(1);
      expect(finished).toBe(false);
      expect(h.lifecycle).toEqual([]);
      await keychain.release();
      await boot;
      expect(finished).toBe(true);
    });

    it('says it is waiting, which is not an error, and pushes that to the windows', async () => {
      const { h, keychain } = await launchWaiting();

      void h.remote.startIfEnabled();
      await settle();

      expect(h.remote.status()).toMatchObject({
        enabled: true,
        listening: false,
        keyPending: true,
        keyError: null,
        error: null,
      });
      expect(pushed(h)).toMatchObject({ keyPending: true, listening: false });
      await keychain.release();
    });

    it('starts the server once the keychain answers, and pushes it', async () => {
      const { h, keychain, state } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      await settle();

      await keychain.release();
      await boot;

      expect(starts(h)).toEqual(['start:47821']);
      expect(h.remote.status()).toMatchObject({
        listening: true,
        keyPending: false,
        keyError: null,
      });
      expect(pushed(h)).toMatchObject({ listening: true, keyPending: false });
      expect(h.stored()?.identity).toEqual(state?.identity);
    });

    it('fails closed when the prompt is denied: no server, the key untouched, «Reintentar»', async () => {
      const { h, keychain, state } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      await settle();

      keychain.setLocked(true);
      await keychain.release();
      await boot;

      expect(h.lifecycle).toEqual([]);
      expect(h.remote.status()).toMatchObject({
        listening: false,
        keyPending: false,
        keyError: KEY_ERROR,
      });
      expect(pushed(h)).toMatchObject({
        keyPending: false,
        keyError: KEY_ERROR,
      });
      expect(h.stored()?.identity).toEqual(state?.identity);
    });

    it('says nothing about waiting while the switch is off', async () => {
      const { h, keychain } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      await settle();

      const off = h.remote.setEnabled(false);

      expect(h.remote.status()).toMatchObject({
        enabled: false,
        keyPending: false,
      });
      await keychain.release();
      await Promise.all([boot, off]);
    });

    it('says nothing about waiting once the key is in memory', async () => {
      const h = harness(undefined, { secretBox: fakeKeychain() });
      await h.remote.setEnabled(true);
      await h.remote.setEnabled(false);
      const before = h.sent.length;

      await h.remote.setEnabled(true);

      const since = h.sent.slice(before).map((entry) => entry.payload);
      expect(since).not.toContainEqual(
        expect.objectContaining({ keyPending: true }),
      );
    });
  });

  describe('one start at a time', () => {
    it('creates one identity and one server when the switch is pressed twice while waiting', async () => {
      const keychain = fakeKeychain();
      keychain.hold();
      const h = harness(undefined, { secretBox: keychain });

      const once = h.remote.setEnabled(true);
      const twice = h.remote.setEnabled(true);
      await settle();
      await keychain.release();
      await Promise.all([once, twice]);

      expect(keychain.calls.filter((call) => call === 'encrypt')).toHaveLength(
        1,
      );
      expect(starts(h)).toEqual(['start:47821']);
      expect(h.remote.status()).toMatchObject({ listening: true });
    });

    it('moves to a port changed while waiting only after the start it waited for', async () => {
      const { h, keychain } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      const moved = h.remote.setPort(50123);
      await settle();

      expect(h.lifecycle).toEqual([]);
      await keychain.release();
      await boot;

      await expect(moved).resolves.toMatchObject({
        ok: true,
        status: { port: 50123, listening: true },
      });
      expect(h.lifecycle).toEqual(['start:47821', 'stop', 'start:50123']);
      expect(keychain.calls.filter((call) => call === 'decrypt')).toHaveLength(
        1,
      );
    });

    it('starts nothing when the switch went off while waiting', async () => {
      const { h, keychain } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      const off = h.remote.setEnabled(false);
      await settle();

      await keychain.release();
      await Promise.all([boot, off]);

      expect(starts(h)).toEqual([]);
      expect(h.remote.status()).toMatchObject({
        enabled: false,
        listening: false,
      });
    });

    it('starts nothing once the app quit while waiting', async () => {
      const { h, keychain } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      await settle();

      h.remote.close();
      await keychain.release();
      await boot;

      expect(starts(h)).toEqual([]);
    });

    it('renews the key only after the answer it was waiting for, never bringing the old one back', async () => {
      const { h, keychain, state } = await launchWaiting();
      const boot = h.remote.startIfEnabled();
      const renewed = h.remote.renewIdentity();
      await settle();
      expect(h.stored()?.identity).toEqual(state?.identity);

      await keychain.release();
      await boot;

      await expect(renewed).resolves.toEqual({ ok: true });
      const fresh = h.stored()?.identity?.publicKey;
      expect(fresh).not.toBe(state?.identity?.publicKey);
      // What the server signs with is the renewed key, not the one loaded.
      const pairing = h.remote.startPairing();
      if (!pairing.ok) throw new Error(pairing.error);
      expect(toB64(pairingLink(pairing.url).key)).toBe(fresh);
    });
  });

  describe('the security code, with the server off', () => {
    it('reads the key from the keychain for it, failing closed when it cannot', async () => {
      const keychain = fakeKeychain();
      const first = harness(undefined, { secretBox: keychain });
      await first.remote.setEnabled(true);
      const phone = await linkPhone(first);
      await first.remote.setEnabled(false);
      first.remote.close();
      keychain.setLocked(true);
      const h = harness(structuredClone(first.stored()), {
        secretBox: keychain,
      });

      await expect(h.remote.securityCode(phone.deviceId)).resolves.toEqual({
        ok: false,
        error: KEY_ERROR,
      });
      keychain.setLocked(false);

      await expect(
        h.remote.securityCode(phone.deviceId),
      ).resolves.toMatchObject({ ok: true, url: null, qr: null });
      expect(h.stored()?.identity).toEqual(first.stored()?.identity);
    });
  });
});
