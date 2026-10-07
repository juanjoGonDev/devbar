import { createRemoteClient, type Me } from './api.js';
import type { DeviceIdentity } from './context.js';
import type { RemoteEnv } from './env.js';
import { fillGlyphs } from './glyphs.js';
import {
  clearKeys,
  keyMaterial,
  readKeys,
  writeKeys,
  type DeviceKeys,
} from './keys.js';
import { startPanel, type Panel } from './panel.js';
import { createPairFlow } from './pair-flow.js';
import { fromB64, KEY_BYTES } from './rc-protocol.js';
import { verifyDevice, type VerifyFragment } from './verify-flow.js';
import { byId, showView } from './view.js';

export type { RemoteEnv } from './env.js';

/**
 * The phone page's flow. Everything travels over devbar-rc/1; what the page
 * shows depends on where it was opened and on the keys this device keeps:
 *
 *   /pair#c=…&k=…    → pairing, trusting the identity key of the QR
 *                      (renderer/remote/pair-flow.ts);
 *   /verify#k=…&d=…&p=…&t=…
 *                    → comparing a security code (verify-flow.ts);
 *   anything else    → with keys, a handshake against the pinned key, the
 *                      sign-in and the control panel; without, how to link.
 *
 * Both QR links carry everything in the fragment, read once and wiped from
 * the address bar at once. A pairing QR scanned by a phone this computer
 * already knows lands on the panel, saying so. A pinned key the desktop no longer presents stops
 * everything at «La clave de seguridad ha cambiado» until the user scans the
 * new code. The keys are forgotten only when a sign-in is refused because
 * the desktop does not know this device (onLost). The browser's globals
 * arrive as `RemoteEnv` (renderer/remote.ts), so every step can be driven
 * from a test.
 */

const ALREADY_LINKED = 'Este dispositivo ya está vinculado';

type Route =
  | { kind: 'home' }
  | { kind: 'pair'; code: string | null; key: Uint8Array | null }
  | ({ kind: 'verify' } & VerifyFragment);

function elements() {
  return {
    expiredNote: byId<HTMLElement>('expired-note', HTMLElement),
    pairTitle: byId<HTMLElement>('pair-title', HTMLElement),
    pairForm: byId<HTMLFormElement>('pair-form', HTMLFormElement),
    deviceName: byId<HTMLInputElement>('device-name', HTMLInputElement),
    pairError: byId<HTMLElement>('pair-error', HTMLElement),
    pairSubmit: byId<HTMLButtonElement>('pair-submit', HTMLButtonElement),
    verificationCode: byId<HTMLElement>('verification-code', HTMLElement),
    expiry: byId<HTMLElement>('pair-expiry', HTMLElement),
    expiryText: byId<HTMLElement>('pair-expiry-text', HTMLElement),
    expiryBar: byId<HTMLElement>('pair-expiry-bar', HTMLElement),
    pairCancel: byId<HTMLButtonElement>('pair-cancel', HTMLButtonElement),
    resultTitle: byId<HTMLElement>('result-title', HTMLElement),
    resultText: byId<HTMLElement>('result-text', HTMLElement),
    resultDone: byId<HTMLButtonElement>('result-done', HTMLButtonElement),
    retry: byId<HTMLButtonElement>('retry', HTMLButtonElement),
    keychangedTitle: byId<HTMLElement>('keychanged-title', HTMLElement),
    keychangedRetry: byId<HTMLButtonElement>(
      'keychanged-retry',
      HTMLButtonElement,
    ),
    verifiedNote: byId<HTMLElement>('verified-note', HTMLElement),
    verifiedDone: byId<HTMLButtonElement>('verified-done', HTMLButtonElement),
    mismatchDone: byId<HTMLButtonElement>('mismatch-done', HTMLButtonElement),
  };
}

/** Where the page was opened; the fragment is cleared from the URL at once. */
function takeRoute(env: RemoteEnv): Route {
  const fragment = new URLSearchParams(env.hash.replace(/^#/, ''));
  const qr = env.pathname === '/verify' || env.pathname === '/pair';
  if (env.hash) env.replaceUrl(qr ? '/' : `${env.pathname}${env.search}`);
  if (env.pathname === '/verify')
    return {
      kind: 'verify',
      k: fragment.get('k'),
      d: fragment.get('d'),
      p: fragment.get('p'),
      t: fragment.get('t'),
    };
  if (env.pathname === '/pair')
    return {
      kind: 'pair',
      code: fragment.get('c'),
      key: fromB64(fragment.get('k'), KEY_BYTES),
    };
  return { kind: 'home' };
}

export async function startRemoteApp(env: RemoteEnv): Promise<void> {
  const els = elements();
  fillGlyphs(document);
  /** Only the panel's own calls may decide that trust is lost. */
  let mode: 'device' | 'flow' = 'device';
  let keys: DeviceKeys | null = null;
  let panel: Panel | null = null;
  const client = createRemoteClient(env.fetch, {
    onLost: (reason) => {
      if (mode !== 'device') return;
      if (reason === 'unlinked') showUnlinked(false, true);
      else showKeyChanged();
    },
  });

  const trustKeys = (next: DeviceKeys): boolean => {
    const material = keyMaterial(next);
    if (!material) return false;
    keys = next;
    client.trust({
      serverKey: material.serverKey,
      device: { id: next.deviceId, secretKey: material.secretKey },
    });
    return true;
  };

  const identity: DeviceIdentity = {
    keys: () => {
      if (!keys) throw new Error('no device keys');
      return keys;
    },
    writable: () => keys !== null && writeKeys(env, keys),
    replace: (next) => writeKeys(env, next) && trustKeys(next),
  };

  function leaveFlows(): void {
    pairing.stop();
    panel?.stop();
  }

  function showUnlinked(fromStaleCode: boolean, forget = false): void {
    leaveFlows();
    if (forget) {
      clearKeys(env);
      keys = null;
    }
    els.expiredNote.classList.toggle('is-emphasised', fromStaleCode);
    showView('unlinked');
  }

  function showResult(title: string, body: string): void {
    leaveFlows();
    els.resultTitle.textContent = title;
    els.resultText.textContent = body;
    showView('result');
  }

  function showKeyChanged(): void {
    leaveFlows();
    const host = keys?.hostName || 'este ordenador';
    els.keychangedTitle.textContent = `La clave de seguridad de ${host} ha cambiado`;
    showView('keychanged');
  }

  /** `notice`: a line to show once the panel is up. */
  const showLinked = (me: Me, notice?: string): void => {
    // The panel wires listeners on the page itself: one per page load. Any
    // later "linked" (a retry) starts from a fresh page instead.
    if (panel) {
      env.reload();
      return;
    }
    showView('linked');
    panel = startPanel({ env, client, me, identity });
    if (notice) panel.toast(notice);
  };

  const pairing = createPairFlow({
    env,
    client,
    els,
    linked: (next) => {
      if (!writeKeys(env, next)) {
        showResult(
          'No se pudo guardar la vinculación',
          'Este navegador no ha dejado guardar las claves de esta página. Desvincula el dispositivo en el ordenador y vuelve a vincularlo fuera del modo privado.',
        );
        return;
      }
      void boot();
    },
    alreadyLinked: () => void boot(ALREADY_LINKED),
    showUnlinked: (stale) => showUnlinked(stale),
    showResult,
  });

  async function boot(notice?: string): Promise<void> {
    mode = 'device';
    pairing.stop();
    showView('loading');
    const stored = readKeys(env);
    if (!stored || !trustKeys(stored)) {
      showUnlinked(false);
      return;
    }
    let me: Me;
    try {
      await client.reconnect();
      me = await client.me();
    } catch {
      // A lost trust already switched the view (onLost).
      if (document.body.dataset.screen === 'loading') showView('error');
      return;
    }
    if (me.linked) {
      showLinked(me, notice);
      return;
    }
    // Signed in, yet not linked: a sign-in decides (onLost forgets).
    await client.confirmLinked();
    if (document.body.dataset.screen === 'loading') showView('error');
  }

  async function run(route: Route): Promise<void> {
    if (route.kind === 'home') return boot();
    mode = 'flow';
    if (route.kind === 'pair') {
      if (route.code && route.key) return pairing.start(route.code, route.key);
      // A link without its code or key (an old QR, a typed address): not
      // trusted.
      env.replaceUrl('/');
      showUnlinked(true);
      return;
    }
    return verifyDevice(
      {
        env,
        client,
        note: els.verifiedNote,
        kept: (next) => {
          keys = next;
        },
        unlinked: () => showUnlinked(false, true),
      },
      route,
    );
  }

  const route = takeRoute(env);
  els.resultDone.addEventListener('click', () => showUnlinked(false));
  els.retry.addEventListener('click', () => void run(route));
  for (const button of [
    els.keychangedRetry,
    els.verifiedDone,
    els.mismatchDone,
  ])
    button.addEventListener('click', () => void boot());

  await run(route);
}
