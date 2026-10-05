import type { RemoteDeviceRow } from '../../src/ipc-contract/remote-api.js';
import { iconButton } from '../icon.js';
import { formatDate, lastSeen } from './remote-format.js';
import { paintVerified } from './remote-safety-dialog.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * The «Dispositivos vinculados» rows: name (renamed inline — Enter or leaving
 * the field saves, Escape cancels) with «Verificado» / «Sin verificar»,
 * client and link date, the IP it last signed in from (a new one raises an
 * alert), presence («Conectado ahora» while the phone holds an event stream
 * open), «Código de seguridad» and «Desvincular». While a name is being
 * edited the list is not repainted, so a push from main cannot wipe what the
 * user is typing.
 */

export interface DeviceList {
  render(devices: readonly RemoteDeviceRow[], now: number): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createDeviceList(
  list: HTMLUListElement,
  deps: {
    showToast: ShowToast;
    onIdle(): void;
    onSecurityCode(device: RemoteDeviceRow): void;
  },
): DeviceList {
  let editing = false;

  const report = (
    result: { ok: boolean; error?: string | undefined },
    fallback: string,
  ): boolean => {
    if (!result.ok) deps.showToast(result.error ?? fallback, 'error');
    return result.ok;
  };

  function startRename(row: HTMLElement, device: RemoteDeviceRow): void {
    const nameRow = row.querySelector('.remote-device-name-row');
    if (!nameRow) return;
    editing = true;
    const input = element('input', 'remote-rename');
    input.value = device.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', 'Nombre del dispositivo');
    nameRow.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (save: boolean): Promise<void> => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name !== device.name) {
        try {
          report(
            await window.api.renameRemoteDevice(device.id, name),
            'No se pudo cambiar el nombre.',
          );
        } catch (err) {
          deps.showToast(`Error: ${errorMessage(err)}`, 'error');
        }
      }
      editing = false;
      deps.onIdle();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      void finish(event.key === 'Enter');
    });
    input.addEventListener('blur', () => void finish(true));
  }

  async function unlink(
    device: RemoteDeviceRow,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    try {
      const result = await window.api.unlinkRemoteDevice(device.id);
      if (report(result, 'No se pudo desvincular.'))
        deps.showToast(`«${device.name}» desvinculado`, 'ok');
    } catch (err) {
      deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function row(device: RemoteDeviceRow, now: number): HTMLLIElement {
    const item = element('li', 'remote-device');
    const main = element('div', 'remote-device-main');
    const nameRow = element('div', 'remote-device-name-row');
    const rename = iconButton('pencil', 'Renombrar', 'remote-rename-btn');
    rename.addEventListener('click', () => startRename(item, device));
    const verified = element('span', 'remote-verified');
    paintVerified(verified, device.verifiedAt !== null);
    nameRow.append(
      element('strong', 'remote-device-name', device.name),
      rename,
      verified,
    );
    main.append(
      nameRow,
      element(
        'div',
        'remote-device-meta',
        `${device.client} · vinculado el ${formatDate(device.createdAt)}`,
      ),
    );
    if (device.lastIp)
      main.append(
        element('span', 'remote-device-ip', `Última IP ${device.lastIp}`),
      );

    const presence = device.connected
      ? element('span', 'remote-seen is-online', 'Conectado ahora')
      : element(
          'span',
          'remote-seen',
          `Última conexión ${lastSeen(device.lastSeenAt, now)}`,
        );
    const unlinkBtn = element(
      'button',
      'small-btn danger remote-unlink',
      'Desvincular',
    );
    unlinkBtn.type = 'button';
    unlinkBtn.addEventListener('click', () => void unlink(device, unlinkBtn));
    const safetyBtn = iconButton(
      'shield-check',
      'Código de seguridad',
      'remote-safety-btn',
    );
    safetyBtn.addEventListener('click', () => deps.onSecurityCode(device));
    const side = element('div', 'remote-device-side');
    side.append(presence, safetyBtn, unlinkBtn);

    item.append(main, side);
    return item;
  }

  return {
    render: (devices, now) => {
      if (editing) return;
      list.replaceChildren(...devices.map((device) => row(device, now)));
    },
  };
}
