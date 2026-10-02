import type {
  RemoteSettingsView,
  RemoteUpdateView,
} from '../../src/ipc-contract/remote-wire.js';
import type { Me } from './api.js';
import type { PanelContext } from './context.js';
import { UNREACHABLE } from './context.js';
import type { PanelElements } from './elements.js';
import { shortDate } from './format.js';
import { settingsView } from './wire.js';

/**
 * «Ajustes»: the update (installable from here only when DevBar has it staged
 * — anything else is installed on the computer), the four global switches a
 * phone may change, and this device: its name, when it was linked, and
 * unlinking it.
 */

const SWITCHES = [
  'autostart',
  'notifySuccess',
  'silenceWarnings',
  'silenceErrors',
] as const;
const NAME_HINT = 'Ponle un nombre de 1 a 40 caracteres.';

export interface SettingsTab {
  show(): void;
  renderUpdate(update: RemoteUpdateView): void;
}

export function createSettingsTab(
  els: PanelElements['settings'],
  ctx: PanelContext,
  me: Me,
): SettingsTab {
  let device = { name: me.deviceName, createdAt: me.deviceCreatedAt };
  /** Set once the phone asked for the restart: nothing to offer until then. */
  let restarting = false;
  let lastUpdate: RemoteUpdateView | null = null;

  const paintDevice = (): void => {
    els.deviceName.textContent = device.name;
    els.linkedOn.textContent = device.createdAt
      ? shortDate(device.createdAt)
      : '';
    els.footer.textContent = `Conectado a ${ctx.hostName()} · ${ctx.env.hostname}`;
  };

  const paintSwitches = (settings: RemoteSettingsView): void => {
    for (const key of SWITCHES) els[key].checked = settings[key];
  };

  function renderUpdate(update: RemoteUpdateView): void {
    lastUpdate = update;
    const state = restarting ? 'restarting' : update.state;
    const version = update.version ?? '';
    const copy: Record<typeof state, [string, string]> = {
      current: ['Estás al día', `DevBar ${update.currentVersion}`],
      ready: [
        `DevBar ${version} disponible`,
        `Tienes la ${update.currentVersion}. DevBar se reiniciará en el ordenador; esta sesión se reconecta sola.`,
      ],
      manual: [
        `DevBar ${version} disponible`,
        'Esta actualización se instala desde el ordenador: DevBar › Configuración › Acerca de.',
      ],
      busy: [
        `Preparando DevBar ${version}…`,
        'Se está descargando en el ordenador.',
      ],
      restarting: ['Reiniciando DevBar…', 'Reconectando esta sesión…'],
    };
    const [title, text] = copy[state];
    els.updateTitle.textContent = title;
    els.updateText.textContent = text;
    els.updateApply.hidden = state !== 'ready';
    els.updateProgress.hidden = state !== 'busy' && state !== 'restarting';
  }

  async function applyUpdate(): Promise<void> {
    if (
      !ctx.env.confirm(
        '¿Actualizar DevBar ahora? Se reiniciará en el ordenador y los servicios volverán a arrancar.',
      )
    )
      return;
    els.updateApply.disabled = true;
    const answer = await ctx.client
      .post('/api/update/apply', {})
      .catch(() => null);
    els.updateApply.disabled = false;
    if (answer?.status === 202) {
      restarting = true;
      if (lastUpdate) renderUpdate(lastUpdate);
    } else if (answer?.status === 409)
      ctx.toast('La actualización ya no está lista.');
    else
      ctx.toast(answer ? 'No se pudo instalar la actualización.' : UNREACHABLE);
  }

  async function save(key: (typeof SWITCHES)[number]): Promise<void> {
    const input = els[key];
    const wanted = input.checked;
    input.disabled = true;
    const answer = await ctx.client
      .post('/api/settings', { [key]: wanted })
      .catch(() => null);
    input.disabled = false;
    if (answer?.status === 200) paintSwitches(settingsView(answer.body));
    else {
      input.checked = !wanted;
      ctx.toast('No se pudo guardar el ajuste.');
    }
  }

  const renameError = (message: string): void => {
    els.renameError.textContent = message;
    els.renameError.hidden = message === '';
  };
  const closeRename = (): void => {
    els.renameForm.hidden = true;
    els.rename.hidden = false;
  };

  async function rename(): Promise<void> {
    const name = els.renameInput.value.trim();
    const answer = await ctx.client
      .post('/api/device/rename', { name })
      .catch(() => null);
    if (answer?.status === 200) {
      device = { ...device, name };
      paintDevice();
      closeRename();
    } else if (answer?.status === 401) ctx.unlinked();
    else renameError(answer ? NAME_HINT : UNREACHABLE);
  }

  async function unlink(): Promise<void> {
    if (
      !ctx.env.confirm(
        '¿Desvincular este dispositivo? Para volver a usarlo tendrás que vincularlo de nuevo desde el ordenador.',
      )
    )
      return;
    els.unlink.disabled = true;
    const answer = await ctx.client.unlink().catch(() => null);
    els.unlink.disabled = false;
    if (answer?.status === 200 || answer?.status === 401) ctx.unlinked();
    else ctx.toast(answer ? 'No se pudo desvincular.' : UNREACHABLE);
  }

  for (const key of SWITCHES)
    els[key].addEventListener('change', () => void save(key));
  els.updateApply.addEventListener('click', () => void applyUpdate());
  els.rename.addEventListener('click', () => {
    els.renameInput.value = device.name;
    renameError('');
    els.renameForm.hidden = false;
    els.rename.hidden = true;
    els.renameInput.focus();
  });
  els.renameCancel.addEventListener('click', closeRename);
  els.renameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void rename();
  });
  els.unlink.addEventListener('click', () => void unlink());

  paintDevice();

  return {
    show: () => {
      paintDevice();
      ctx.client
        .settings()
        .then(paintSwitches, () =>
          ctx.toast('No se pudieron leer los ajustes.'),
        );
      ctx.client.me().then(
        (fresh) => {
          if (!fresh.linked) return;
          device = { name: fresh.deviceName, createdAt: fresh.deviceCreatedAt };
          paintDevice();
        },
        () => undefined,
      );
    },
    renderUpdate,
  };
}
