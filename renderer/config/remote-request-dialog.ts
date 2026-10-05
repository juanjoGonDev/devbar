import type { RemotePairRequest } from '../../src/ipc-contract/remote-api.js';
import type { RemoteElements } from './remote-elements.js';
import { formatCountdown } from './remote-format.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «¿Vincular este dispositivo?»: the desktop half of the handshake. The six
 * digits are shown on the phone only; the user types them here and main
 * compares them (in constant time — this window only learns whether they
 * matched). «Vincular» stays off until they do, and main checks them again
 * when it is pressed. A wrong code is cleared and says how many tries are
 * left; the third rejects the request, which main closes.
 *
 * Any other way out — «Rechazar», Esc, closing — answers no. Main
 * auto-rejects at the deadline and says so, which closes the dialog without
 * an answer.
 */

const DIGITS = 6;

export interface RequestDialog {
  show(request: RemotePairRequest): void;
  /** Main closed the request (answered, expired or cancelled). */
  closed(requestId: string): void;
}

const triesLeft = (left: number): string =>
  left === 1 ? 'Te queda 1 intento.' : `Te quedan ${left} intentos.`;

export function createRequestDialog(
  els: RemoteElements['request'],
  showToast: ShowToast,
): RequestDialog {
  let current: RemotePairRequest | null = null;
  /** The digits main said match, while the field still holds them. */
  let matched: string | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const typed = (): string =>
    els.code.value.replace(/\D/g, '').slice(0, DIGITS);

  const codeError = (message: string): void => {
    els.codeError.textContent = message;
    els.codeError.hidden = message === '';
  };

  const tick = (): void => {
    if (!current) return;
    const remaining = current.expiresAt - Date.now();
    els.countdown.textContent = `Se rechazará automáticamente en ${formatCountdown(remaining)}`;
  };

  const finish = (): void => {
    current = null;
    matched = null;
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    if (els.dialog.open) els.dialog.close();
  };

  async function answer(accept: boolean): Promise<void> {
    const request = current;
    if (!request) return;
    const code = accept ? matched : '';
    if (code === null) return;
    // Cleared first: closing the dialog below must not answer a second time.
    current = null;
    els.accept.disabled = true;
    els.reject.disabled = true;
    try {
      const result = await window.api.respondRemotePairing(
        request.requestId,
        accept,
        code,
      );
      if (!result.ok)
        showToast(
          result.error ?? 'No se pudo responder a la solicitud.',
          'error',
        );
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
    } finally {
      els.reject.disabled = false;
      finish();
    }
  }

  async function check(): Promise<void> {
    const request = current;
    const digits = typed();
    matched = null;
    els.accept.disabled = true;
    if (!request || digits.length < DIGITS) return;
    let result;
    try {
      result = await window.api.checkRemotePairCode(request.requestId, digits);
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
      return;
    }
    // The user kept typing, or the request is gone: this answer is stale.
    if (current !== request || typed() !== digits) return;
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    if (result.match) {
      matched = digits;
      els.accept.disabled = false;
      codeError('');
      return;
    }
    els.code.value = '';
    codeError(
      result.attemptsLeft > 0
        ? `El código no coincide. ${triesLeft(result.attemptsLeft)}`
        : 'El código no coincide.',
    );
  }

  els.code.addEventListener('input', () => void check());
  els.code.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (matched !== null && matched === typed()) void answer(true);
  });
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
      matched = null;
      els.name.textContent = request.name;
      els.meta.textContent = `${request.client} · ${request.ip}`;
      els.code.value = '';
      els.accept.disabled = true;
      codeError('');
      tick();
      if (ticker === null) ticker = setInterval(tick, 1000);
      if (!els.dialog.open) els.dialog.showModal();
      els.code.focus();
    },
    closed: (requestId) => {
      if (current?.requestId === requestId) finish();
    },
  };
}
