import type { RemoteStatus } from '../../src/ipc-contract/remote-api.js';
import { isRemotePort, remotePortError } from '../../src/remote-port.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * The «Puerto» field of the switch card. It is rarely touched, so it lives in
 * a strip under the card's header that the gear shows and hides. Editable
 * whether the server is on or off: «Aplicar» or Enter sends it, and «Aplicar»
 * stays off while the value is the current port or out of range. An
 * out-of-range value is explained under the field when it is committed; a
 * port another app holds is a listen failure, reported by the status like any
 * other.
 */

export interface PortElements {
  /** The gear in the card's header: shows and hides `strip`. */
  toggle: HTMLButtonElement;
  strip: HTMLElement;
  input: HTMLInputElement;
  apply: HTMLButtonElement;
  error: HTMLElement;
}

export interface PortField {
  /** Paints main's port, unless the user typed a different one. */
  render(port: number): void;
  /** Shows the strip: a failed listen is almost always the port. */
  reveal(): void;
}

export function createPortField(
  els: PortElements,
  deps: { showToast: ShowToast; onApplied(status: RemoteStatus): void },
): PortField {
  /** The port main last reported; null until the first status. */
  let current: number | null = null;
  let busy = false;

  const typed = (): number => {
    const raw = els.input.value.trim();
    return raw === '' ? Number.NaN : Number(raw);
  };
  const showError = (message: string | null): void => {
    els.error.hidden = message === null;
    els.error.textContent = message ?? '';
    if (message === null) els.input.removeAttribute('aria-invalid');
    else els.input.setAttribute('aria-invalid', 'true');
  };
  const refresh = (): void => {
    const port = typed();
    els.apply.disabled =
      busy || current === null || port === current || !isRemotePort(port);
  };

  async function apply(): Promise<void> {
    const port = typed();
    const invalid = remotePortError(port);
    if (invalid !== null) {
      showError(invalid);
      return;
    }
    if (busy || port === current) return;
    busy = true;
    refresh();
    try {
      const result = await window.api.setRemotePort(port);
      if (result.ok) deps.onApplied(result.status);
      else showError(result.error);
    } catch (err) {
      deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    } finally {
      busy = false;
      refresh();
    }
  }

  els.input.addEventListener('input', () => {
    showError(null);
    refresh();
  });
  els.input.addEventListener('change', () =>
    showError(remotePortError(typed())),
  );
  els.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    void apply();
  });
  els.apply.addEventListener('click', () => void apply());

  const setOpen = (open: boolean): void => {
    els.strip.hidden = !open;
    els.toggle.setAttribute('aria-expanded', String(open));
  };
  els.toggle.addEventListener('click', () => {
    const opening = els.strip.hidden !== false;
    setOpen(opening);
    if (opening) els.input.focus();
  });

  return {
    render: (port) => {
      const untouched = current === null || els.input.value === String(current);
      if (untouched) els.input.value = String(port);
      current = port;
      els.input.disabled = false;
      refresh();
    },
    reveal: () => setOpen(true),
  };
}
