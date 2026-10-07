import type { RemoteDeviceRow } from '../../src/ipc-contract/remote-api.js';
import { icon, iconButton } from '../icon.js';
import { createDeviceMenu, type MenuEntry } from './remote-device-menu.js';
import { formatDate, lastSeen } from './remote-format.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * The «Dispositivos» rows: an avatar (with a green dot while the device is
 * connected), the name with a shield when it is verified, «<client> · <last
 * IP>» on one line, «Conectado» or how long ago it was last seen, and a «⋯»
 * menu with «Código de seguridad» (or «Verificar con código»), «Renombrar»
 * and «Desvincular». Renaming happens in the row — Enter or leaving the field
 * saves, Escape cancels — and while a name is being edited the list is not
 * repainted, so a push from main cannot wipe what the user is typing.
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

/** The shield after a verified name: an image to assistive tech. */
function verifiedMark(): HTMLElement {
  const mark = element('span', 'remote-verified-mark');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', 'Verificado');
  mark.title = 'Verificado';
  mark.append(icon('shield-check'));
  return mark;
}

/** «Conectado», or «hace 3 h» read out as «Última conexión hace 3 h». */
function presence(device: RemoteDeviceRow, now: number): HTMLElement {
  if (device.connected)
    return element('span', 'remote-seen is-online', 'Conectado');
  const seen = element('span', 'remote-seen');
  seen.append(
    element('span', 'sr-only', 'Última conexión '),
    lastSeen(device.lastSeenAt, now),
  );
  return seen;
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
  const menu = createDeviceMenu();

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

  const actions = (
    row: HTMLElement,
    device: RemoteDeviceRow,
    trigger: HTMLButtonElement,
  ): MenuEntry[] => [
    {
      label:
        device.verifiedAt === null
          ? 'Verificar con código'
          : 'Código de seguridad',
      icon: 'shield',
      run: () => deps.onSecurityCode(device),
    },
    {
      label: 'Renombrar',
      icon: 'pencil',
      run: () => startRename(row, device),
    },
    null,
    {
      label: 'Desvincular',
      icon: 'unlink',
      danger: true,
      run: () => void unlink(device, trigger),
    },
  ];

  function row(device: RemoteDeviceRow, now: number): HTMLLIElement {
    const item = element('li', 'remote-device');

    const avatar = element('span', 'remote-avatar');
    avatar.append(icon('smartphone'));
    if (device.connected) avatar.append(element('span', 'remote-presence'));

    const nameRow = element('div', 'remote-device-name-row');
    nameRow.append(element('strong', 'remote-device-name', device.name));
    if (device.verifiedAt !== null) nameRow.append(verifiedMark());
    const where = device.lastIp
      ? `${device.client} · ${device.lastIp}`
      : device.client;
    const meta = element('div', 'remote-device-meta', where);
    meta.title = `${where}\nVinculado el ${formatDate(device.createdAt)}`;
    const main = element('div', 'remote-device-main');
    main.append(nameRow, meta);

    const trigger = iconButton(
      'ellipsis',
      `Acciones de ${device.name}`,
      'remote-menu-btn',
    );
    trigger.dataset.deviceId = device.id;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () =>
      menu.toggle(trigger, actions(item, device, trigger)),
    );

    item.append(avatar, main, presence(device, now), trigger);
    return item;
  }

  return {
    render: (devices, now) => {
      if (editing) return;
      const focused = menu.close()?.dataset.deviceId;
      list.replaceChildren(...devices.map((device) => row(device, now)));
      if (focused === undefined) return;
      const triggers =
        list.querySelectorAll<HTMLButtonElement>('.remote-menu-btn');
      [...triggers].find((each) => each.dataset.deviceId === focused)?.focus();
    },
  };
}
