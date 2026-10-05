import type { RemoteStatus } from '../../src/ipc-contract/remote-api.js';
import { createDeviceList } from './remote-devices.js';
import type { RemoteElements } from './remote-elements.js';
import { createPairDialog } from './remote-pair-dialog.js';
import { createPortField } from './remote-port.js';
import { createRequestDialog } from './remote-request-dialog.js';
import { createSafetyDialog } from './remote-safety-dialog.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «Control remoto»: the switch, the port, the linked devices (with their
 * security codes) and the Seguridad card — auto-unlink, the connection
 * notice and renewing this computer's key.
 * Main owns the state; this paints whatever `RemoteStatus` it last reported
 * (answers and `remote:changed` pushes alike) and forwards the clicks.
 *
 * When this computer's key cannot be read (a locked keychain), main keeps
 * the server off and says why: «Reintentar» asks it to start again, and
 * «Renovar clave del equipo» is the only way to replace the key. While the
 * keychain has yet to answer (a macOS permission prompt still open), the
 * section only notes that it is waiting: not an error, just not listening.
 */

/** Repaint cadence, so «Última conexión hace …» keeps counting. */
const PRESENCE_REFRESH_MS = 30_000;

export function createRemotePane(
  els: RemoteElements,
  showToast: ShowToast,
): void {
  let status: RemoteStatus | null = null;

  const safety = createSafetyDialog(els.safety, showToast);
  const devices = createDeviceList(els.devices, {
    showToast,
    onIdle: () => render(),
    onSecurityCode: (device) => void safety.open(device),
  });
  const pair = createPairDialog(els.pair);
  const request = createRequestDialog(els.request, showToast);
  const portField = createPortField(els.port, {
    showToast,
    onApplied: (next) => apply(next),
  });

  function render(): void {
    if (!status) return;
    const address = status.addresses[0];
    els.enabled.checked = status.enabled;
    els.enabled.disabled = false;
    els.autoUnlink.checked = status.autoUnlink;
    els.autoUnlink.disabled = false;
    els.notifyConnections.checked = status.notifyConnections;
    els.notifyConnections.disabled = false;
    els.endpoint.hidden = !status.enabled;
    els.state.textContent = status.listening ? 'Activo' : 'Desactivado';
    els.state.classList.toggle('is-on', status.listening);
    els.address.textContent = address
      ? `${address}:${status.port}`
      : 'Sin red local';
    els.error.hidden = !status.error;
    els.error.textContent = status.error ?? '';
    els.keyPending.hidden = !status.keyPending;
    els.keyError.hidden = !status.keyError;
    els.keyErrorText.textContent = status.keyError ?? '';
    els.keyUnsealed.hidden = !status.keyUnsealed;
    // A failed listen is almost always the port: show where to change it.
    if (status.error) els.portSettings.open = true;
    portField.render(status.port);
    els.addDevice.disabled = !status.listening || !address;
    if (!status.listening) pair.close();
    els.deviceCount.textContent = String(status.devices.length);
    els.devicesEmpty.hidden = status.devices.length > 0;
    devices.render(status.devices, Date.now());
    safety.update(status.devices);
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
  wireSwitch(els.notifyConnections, (on) =>
    window.api.setRemoteNotifyConnections(on),
  );

  els.renewIdentity.addEventListener('click', async () => {
    if (
      !confirm(
        '¿Renovar la clave del equipo? Los móviles vinculados dejarán de conectarse hasta que escanees otra vez su código de seguridad.',
      )
    )
      return;
    els.renewIdentity.disabled = true;
    try {
      const result = await window.api.renewRemoteIdentity();
      if (result.ok)
        showToast(
          'Clave del equipo renovada. Verifica de nuevo cada dispositivo.',
          'ok',
        );
      else showToast(result.error ?? 'No se pudo renovar la clave.', 'error');
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
    } finally {
      els.renewIdentity.disabled = false;
    }
  });

  els.keyRetry.addEventListener('click', async () => {
    els.keyRetry.disabled = true;
    try {
      apply(await window.api.setRemoteEnabled(true));
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
    } finally {
      els.keyRetry.disabled = false;
    }
  });

  els.addDevice.addEventListener('click', () => pair.open());

  window.api.onRemoteChanged(apply);
  window.api.onRemotePairCodeClaimed(() => pair.codeClaimed());
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
