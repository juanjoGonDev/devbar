import type { RemotePairRequest } from '../../src/ipc-contract/remote-api.js';
import type { RemoteElements } from './remote-elements.js';
import { formatCountdown, formatVerificationCode } from './remote-format.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «¿Vincular este dispositivo?»: the desktop half of the handshake. Linking
 * always needs this explicit «Vincular»; any other way out — «Rechazar», Esc,
 * closing — answers no. Main auto-rejects at the deadline and says so, which
 * closes the dialog without an answer.
 */

export interface RequestDialog {
  show(request: RemotePairRequest): void;
  /** Main closed the request (answered, expired or cancelled). */
  closed(requestId: string): void;
}

export function createRequestDialog(
  els: RemoteElements['request'],
  showToast: ShowToast,
): RequestDialog {
  let current: RemotePairRequest | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    if (!current) return;
    const remaining = current.expiresAt - Date.now();
    els.countdown.textContent = `Se rechazará automáticamente en ${formatCountdown(remaining)}`;
  };

  const finish = (): void => {
    current = null;
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    if (els.dialog.open) els.dialog.close();
  };

  async function answer(accept: boolean): Promise<void> {
    const request = current;
    if (!request) return;
    // Cleared first: closing the dialog below must not answer a second time.
    current = null;
    els.accept.disabled = true;
    els.reject.disabled = true;
    try {
      const result = await window.api.respondRemotePairing(
        request.requestId,
        accept,
      );
      if (!result.ok)
        showToast(
          result.error ?? 'No se pudo responder a la solicitud.',
          'error',
        );
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
    } finally {
      els.accept.disabled = false;
      els.reject.disabled = false;
      finish();
    }
  }

  els.accept.addEventListener('click', () => void answer(true));
  els.reject.addEventListener('click', () => void answer(false));
  els.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void answer(false);
  });
  els.dialog.addEventListener('close', () => void answer(false));

  return {
    show: (request) => {
      current = request;
      els.name.textContent = request.name;
      els.meta.textContent = `${request.client} · ${request.ip}`;
      els.code.textContent = formatVerificationCode(request.verificationCode);
      tick();
      if (ticker === null) ticker = setInterval(tick, 1000);
      if (!els.dialog.open) els.dialog.showModal();
    },
    closed: (requestId) => {
      if (current?.requestId === requestId) finish();
    },
  };
}
