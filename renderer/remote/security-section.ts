import type { PanelContext } from './context.js';
import { attempt, LOST, signedOut } from './context.js';
import type { PanelElements } from './elements.js';
import { keyMaterial } from './keys.js';
import { generateSigningKey, safetyCode, toB64 } from './rc-protocol.js';
import { el } from './view.js';

/**
 * Ajustes › «Seguridad»: that everything travels end-to-end encrypted with a
 * new key per connection, this device's security code (the same six groups
 * the computer shows for it), whether the user verified it by scanning the
 * computer's QR, and «Renovar claves de este dispositivo» — a new key pair,
 * which leaves the device unverified until it is scanned again.
 */

export interface SecuritySection {
  paint(): void;
}

export function createSecuritySection(
  els: PanelElements['settings'],
  ctx: PanelContext,
): SecuritySection {
  function paint(): void {
    const keys = ctx.identity.keys();
    const material = keyMaterial(keys);
    const groups = material
      ? safetyCode(material.serverKey, material.devicePub)
      : [];
    els.securityCode.replaceChildren(
      ...groups.map((group) => el('span', '', group)),
    );
    els.securityStatus.textContent = keys.verified
      ? 'Verificado'
      : 'Sin verificar';
    els.securityStatus.classList.toggle('is-verified', keys.verified);
  }

  async function rotate(): Promise<void> {
    if (
      !ctx.env.confirm(
        '¿Renovar las claves de este dispositivo? Tendrás que volver a verificar su código de seguridad desde el ordenador.',
      )
    )
      return;
    // The desktop must not learn a key this browser then fails to keep.
    if (!ctx.identity.writable()) {
      ctx.toast('Este navegador no deja guardar claves nuevas.');
      return;
    }
    els.rotateKeys.disabled = true;
    const next = generateSigningKey();
    // The new key signs this session's handshake: it proves it is held.
    const { answer, failure } = await attempt(ctx.client.rotateKey(next));
    els.rotateKeys.disabled = false;
    if (answer?.status === 200) {
      ctx.identity.replace({
        ...ctx.identity.keys(),
        devicePriv: toB64(next.secretKey),
        devicePub: toB64(next.publicKey),
        verified: false,
      });
      paint();
      ctx.toast('Claves renovadas. Vuelve a verificar este dispositivo.');
    } else if (signedOut(answer)) {
      if (await ctx.recheck()) ctx.toast(LOST);
    } else ctx.toast(answer ? 'No se pudieron renovar las claves.' : failure);
  }

  els.rotateKeys.addEventListener('click', () => void rotate());
  paint();
  return { paint };
}
