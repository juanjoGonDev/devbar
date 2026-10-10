import type { RemoteClient } from './api.js';
import { RemoteError } from './channel.js';
import type { RemoteEnv } from './env.js';
import { keyMaterial, readKeys, writeKeys, type DeviceKeys } from './keys.js';
import { fromB64, KEY_BYTES, sameBytes, toB64 } from './rc-protocol.js';
import { showView } from './view.js';

/**
 * `/verify#k=<identity key>&d=<device id>&p=<device key>&t=<token>`: the QR
 * of a device's «Código de seguridad» on the computer, opened by the phone's
 * own camera. The phone compares the first three with what it holds:
 *
 *   all match       → verified here, `verify.done` tells the computer;
 *   d and p match, k is new
 *                   → the computer renewed its key: the phone re-pins it,
 *                     but only once a DevBar proves it holds the new key;
 *   anything else   → «El código no coincide», and nothing is marked.
 *
 * `verify.done` carries `t`, the one-time token only that screen showed:
 * without it the computer does not take the phone's word for it.
 */

export interface VerifyFragment {
  k: string | null;
  d: string | null;
  p: string | null;
  t: string | null;
}

export interface VerifyDeps {
  env: RemoteEnv;
  client: RemoteClient;
  /** The «couldn't tell the computer» line of the success view. */
  note: HTMLElement;
  /** The keys changed (verified, or a new identity pinned). */
  kept(keys: DeviceKeys): void;
  /** The computer no longer knows this device. */
  unlinked(): void;
}

function matches(stored: DeviceKeys, fragment: VerifyFragment) {
  const material = keyMaterial(stored);
  const k = fromB64(fragment.k, KEY_BYTES);
  const p = fromB64(fragment.p, KEY_BYTES);
  if (!material || !k || !p || fragment.d !== stored.deviceId) return null;
  if (!sameBytes(p, material.devicePub)) return null;
  return { material, k, repin: !sameBytes(k, material.serverKey) };
}

export async function verifyDevice(
  deps: VerifyDeps,
  fragment: VerifyFragment,
): Promise<void> {
  const { env, client } = deps;
  const stored = readKeys(env);
  const match = stored ? matches(stored, fragment) : null;
  if (!stored || !match) {
    showView('mismatch');
    return;
  }
  const verified: DeviceKeys = {
    ...stored,
    serverIdPub: toB64(match.k),
    verified: true,
  };
  // Same key: the comparison itself is the verification, network or not.
  if (!match.repin && writeKeys(env, verified)) deps.kept(verified);
  showView('loading');
  client.trust({
    serverKey: match.k,
    device: { id: stored.deviceId, secretKey: match.material.secretKey },
  });
  try {
    await client.reconnect();
  } catch (error) {
    if (error instanceof RemoteError && error.code === 'unlinked')
      deps.unlinked();
    else if (match.repin)
      showView(
        error instanceof RemoteError && error.code === 'changed'
          ? 'mismatch'
          : 'error',
      );
    else showVerified(deps, false);
    return;
  }
  // A new identity is pinned only now, proven by a handshake signed with it.
  if (match.repin) {
    if (!writeKeys(env, verified)) {
      showView('error');
      return;
    }
    deps.kept(verified);
  }
  const proof = fragment.t ? { t: fragment.t } : {};
  const told = await client.call('verify.done', proof).then(
    (answer) => answer.status === 200,
    () => false,
  );
  showVerified(deps, told);
}

function showVerified(deps: VerifyDeps, told: boolean): void {
  deps.note.hidden = told;
  showView('verified');
}
