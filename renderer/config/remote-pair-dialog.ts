import type { RemotePairRequestClosed } from '../../src/ipc-contract/remote-api.js';
import { wireModal } from '../modal.js';
import type { RemoteElements } from './remote-elements.js';
import { formatCountdown } from './remote-format.js';
import { qrSvg } from './remote-qr.js';
import { errorMessage } from './toast.js';

/**
 * «Vincular dispositivo»: the QR of THE pairing code, with its countdown.
 * When the code runs out the dialog asks for a new one by itself; closing it
 * — the ✕, «Cancelar», Esc or the backdrop — cancels the code in main, so a
 * QR left on screen in a photo is worthless once the dialog is gone. A page
 * that goes away with the dialog still open (a reload) cancels it too; main
 * does the same when the whole window closes.
 */

/** Main issues every code for 5 minutes (src/main/remote/pairing.ts). */
const CODE_TTL_MS = 5 * 60_000;

export interface PairDialog {
  open(): void;
  /** The server went down: no code can be redeemed any more. */
  close(): void;
  /** A phone redeemed the code: it is spent, stop counting. */
  codeUsed(): void;
  requestClosed(outcome: RemotePairRequestClosed['outcome']): void;
}

export function createPairDialog(els: RemoteElements['pair']): PairDialog {
  let expiresAt = 0;
  let used = false;
  let issuing = false;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const showError = (message: string): void => {
    els.error.textContent = message;
    els.error.hidden = false;
  };

  async function issue(): Promise<void> {
    issuing = true;
    els.error.hidden = true;
    let result;
    try {
      result = await window.api.startRemotePairing();
    } catch (err) {
      showError(errorMessage(err));
      return;
    } finally {
      issuing = false;
    }
    // Closed while main was issuing it: that code must not stay redeemable.
    if (!els.dialog.open) {
      void window.api.cancelRemotePairing();
      return;
    }
    if (!result.ok) {
      showError(result.error);
      return;
    }
    used = false;
    expiresAt = result.expiresAt;
    els.qr.classList.remove('is-used');
    els.qr.replaceChildren(qrSvg(result.qr));
    tick();
  }

  function tick(): void {
    if (used || issuing || !expiresAt) return;
    const remaining = expiresAt - Date.now();
    els.countdown.textContent = `Caduca en ${formatCountdown(remaining)} · se renueva solo`;
    const share = Math.min(1, Math.max(0, remaining / CODE_TTL_MS));
    els.progress.style.width = `${Math.round(share * 100)}%`;
    if (remaining <= 0) void issue();
  }

  wireModal(els.dialog);
  window.addEventListener('pagehide', () => {
    if (els.dialog.open && els.dialog.isConnected)
      void window.api.cancelRemotePairing();
  });
  els.dialog.addEventListener('close', () => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    expiresAt = 0;
    void window.api.cancelRemotePairing();
  });

  return {
    open: () => {
      expiresAt = 0;
      used = false;
      els.qr.replaceChildren();
      els.qr.classList.remove('is-used');
      els.countdown.textContent = 'Generando código…';
      els.progress.style.width = '100%';
      els.dialog.showModal();
      ticker = setInterval(tick, 1000);
      void issue();
    },
    close: () => {
      if (els.dialog.open) els.dialog.close();
    },
    codeUsed: () => {
      if (!els.dialog.open) return;
      used = true;
      els.qr.classList.add('is-used');
      els.countdown.textContent = 'Código usado: responde a la solicitud.';
    },
    requestClosed: (outcome) => {
      if (!els.dialog.open) return;
      if (outcome === 'accepted') els.dialog.close();
      else void issue();
    },
  };
}
