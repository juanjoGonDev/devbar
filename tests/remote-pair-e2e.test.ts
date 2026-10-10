// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { startRemoteApp, type RemoteEnv } from '../renderer/remote/app.js';
import type { RemotePairRequest } from '../src/ipc-contract/remote-api.js';
import { harness, type Harness } from './helpers/remote-control-harness.js';
import { loadPage, settle, text, visibleView } from './helpers/remote-page.js';

/**
 * The phone page (renderer/remote/app.ts and pair-flow.ts) scanning pairing
 * QRs of the real «Control remoto» (src/main/remote/remote-control.ts), the
 * two talking devbar-rc/1 through tests/helpers/rc-bridge.ts — so what is
 * counted here is the devices the computer really ends up with.
 */

interface Timer {
  fn: () => void;
  cleared: boolean;
}

/** One page load of the phone, at `url`, over this phone's own storage. */
function phonePage(h: Harness, url: string, storage: Map<string, string>) {
  const parsed = new URL(url);
  const timeouts: Timer[] = [];
  const env: RemoteEnv = {
    fetch: h.net.fetch,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    hostname: parsed.hostname,
    replaceUrl: () => undefined,
    confirm: () => true,
    setTimeout: (fn) => {
      const timer = { fn, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      if (handle) (handle as Timer).cleared = true;
    },
    setInterval: () => ({}),
    clearInterval: () => undefined,
    now: () => Date.now(),
    // The panel's stream stays quiet: only the devices are counted here.
    openEvents: () => ({
      addEventListener: () => undefined,
      close: () => undefined,
    }),
    storage: () => ({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    }),
    reload: () => undefined,
  };
  return {
    /** Runs the next poll of the pairing request. */
    poll: async (): Promise<void> => {
      const timer = timeouts.find((each) => !each.cleared);
      if (!timer) throw new Error('nothing scheduled');
      timer.cleared = true;
      timer.fn();
      await settleFully();
    },
    start: async (): Promise<void> => {
      void startRemoteApp(env);
      await settleFully();
    },
  };
}

/** A few rounds: every call crosses a handshake on both implementations. */
async function settleFully(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
}

/** The phone scans the QR the computer shows right now. */
async function scan(h: Harness, storage: Map<string, string>) {
  loadPage();
  const pairing = h.remote.startPairing();
  if (!pairing.ok) throw new Error(pairing.error);
  const page = phonePage(h, pairing.url, storage);
  await page.start();
  return page;
}

/** «Vincular» on the phone, then its six digits typed on the computer. */
async function pairOnPage(
  h: Harness,
  page: ReturnType<typeof phonePage>,
): Promise<void> {
  document
    .getElementById('pair-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settleFully();
  const request = h.lastOn('remote:pairRequest') as RemotePairRequest;
  const accepted = h.remote.respondPairing(
    request.requestId,
    true,
    text('verification-code'),
  );
  if (!accepted.ok) throw new Error(accepted.error);
  await page.poll();
}

const deviceIdIn = (storage: Map<string, string>): unknown =>
  (
    JSON.parse(storage.get('devbar.remote.keys') ?? '{}') as {
      deviceId?: unknown;
    }
  ).deviceId;

describe('pairing the same phone twice, end to end', () => {
  let h: Harness;
  /** The phone's localStorage, across its page loads. */
  let storage: Map<string, string>;

  beforeEach(async () => {
    h = harness();
    storage = new Map();
    await h.remote.setEnabled(true);
    await pairOnPage(h, await scan(h, storage));
  });

  it('links the phone once', () => {
    expect(visibleView()).toBe('linked');
    expect(h.remote.status().devices).toHaveLength(1);
  });

  it('opens the panel of a linked phone that scans again, adding no device', async () => {
    await scan(h, storage);

    expect(visibleView()).toBe('linked');
    expect(text('toast')).toBe('Este dispositivo ya está vinculado');
    expect(h.remote.status().devices).toHaveLength(1);
    // Its code was never spent: the QR on the computer is still good.
    expect(
      h.channels().filter((name) => name === 'remote:pairCodeClaimed'),
    ).toHaveLength(1);
  });

  it('replaces the old device when the computer renewed its key', async () => {
    const [before] = h.remote.status().devices;
    await h.remote.renewIdentity();

    const page = await scan(h, storage);
    expect(visibleView()).toBe('pair');
    await pairOnPage(h, page);

    expect(visibleView()).toBe('linked');
    const after = h.remote.status().devices;
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before?.id);
    expect(deviceIdIn(storage)).toBe(after[0]?.id);
  });
});
