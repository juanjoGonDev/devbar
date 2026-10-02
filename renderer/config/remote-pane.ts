import type { RemoteStatus } from '../../src/ipc-contract/remote-api.js';
import { createDeviceList } from './remote-devices.js';
import type { RemoteElements } from './remote-elements.js';
import { createPairDialog } from './remote-pair-dialog.js';
import { createRequestDialog } from './remote-request-dialog.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «Control remoto»: the switch, the linked devices and auto-unlink. Main
 * owns the state; this paints whatever `RemoteStatus` it last reported
 * (answers and `remote:changed` pushes alike) and forwards the clicks.
 */

/** Repaint cadence, so «Última conexión hace …» keeps counting. */
const PRESENCE_REFRESH_MS = 30_000;

export function createRemotePane(
  els: RemoteElements,
  showToast: ShowToast,
): void {
  let status: RemoteStatus | null = null;

  const devices = createDeviceList(els.devices, {
    showToast,
    onIdle: () => render(),
  });
  const pair = createPairDialog(els.pair);
  const request = createRequestDialog(els.request, showToast);

  function render(): void {
    if (!status) return;
    const address = status.addresses[0];
    els.enabled.checked = status.enabled;
    els.enabled.disabled = false;
    els.autoUnlink.checked = status.autoUnlink;
    els.autoUnlink.disabled = false;
    els.endpoint.hidden = !status.enabled;
    els.state.textContent = status.listening ? 'Activo' : 'Desactivado';
    els.state.classList.toggle('is-on', status.listening);
    els.address.textContent = address
      ? `${address}:${status.port}`
      : 'Sin red local';
    els.error.hidden = !status.error;
    els.error.textContent = status.error ?? '';
    els.addDevice.disabled = !status.listening || !address;
    if (!status.listening) pair.close();
    els.deviceCount.textContent = String(status.devices.length);
    els.devicesEmpty.hidden = status.devices.length > 0;
    devices.render(status.devices, Date.now());
  }

  const apply = (next: RemoteStatus): void => {
    status = next;
    render();
  };

  /** A switch that saves through main and shows what main answered. */
  const wireSwitch = (
    input: HTMLInputElement,
    save: (on: boolean) => Promise<RemoteStatus>,
  ): void => {
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        apply(await save(input.checked));
      } catch (err) {
        showToast(`Error: ${errorMessage(err)}`, 'error');
        render();
      } finally {
        input.disabled = false;
      }
    });
  };
  wireSwitch(els.enabled, (on) => window.api.setRemoteEnabled(on));
  wireSwitch(els.autoUnlink, (on) => window.api.setRemoteAutoUnlink(on));

  els.addDevice.addEventListener('click', () => pair.open());

  window.api.onRemoteChanged(apply);
  window.api.onRemotePairRequest((incoming) => {
    pair.codeUsed();
    request.show(incoming);
  });
  window.api.onRemotePairRequestClosed(({ requestId, outcome }) => {
    request.closed(requestId);
    pair.requestClosed(outcome);
  });
  setInterval(render, PRESENCE_REFRESH_MS);

  window.api
    .getRemoteStatus()
    .then(apply)
    .catch((err: unknown) =>
      showToast(
        `Error al leer el control remoto: ${errorMessage(err)}`,
        'error',
      ),
    );
}
