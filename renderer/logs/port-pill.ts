/**
 * The port pill right after the run pill: «:3000» plus an arrow for
 * a running command that serves a page or an HTTP API, a small menu when it
 * serves several, and a muted «:5432» for a port nothing can open.
 *
 * The ports come from the group states main pushes (`onUpdate`), which the
 * window already receives; this module keeps the latest ones by process id.
 * `renderPortPill` runs once a second with the header, so it only rebuilds
 * when what it would draw changed.
 */
import { isRunning } from '../log-status.js';
import { icon } from '../icon.js';
import {
  createDeviceMenu,
  type MenuEntry,
} from '../config/remote-device-menu.js';
import { portPillEl } from './elements.js';
import type { DetectedPort } from '../../src/domain-types.js';
import type { GroupState, LogListItem } from '../../src/ipc-contract.js';

interface PortOwner {
  groupId: string;
  commandId: string;
  ports: DetectedPort[];
}

const owners = new Map<string, PortOwner>();
const menu = createDeviceMenu();

/** Remember each command's ports from the latest group states. */
export function adoptGroupStates(
  states: readonly GroupState[] | null | undefined,
): void {
  if (!states) return;
  owners.clear();
  for (const group of states) {
    for (const command of group.commands) {
      owners.set(command.processId, {
        groupId: group.groupId,
        commandId: command.commandId,
        ports: Array.isArray(command.ports) ? command.ports : [],
      });
    }
  }
}

export type PortPill =
  | { kind: 'open'; text: string; title: string; menu: boolean }
  | { kind: 'muted'; text: string };

const openable = (port: DetectedPort): boolean =>
  port.kind === 'web' || port.kind === 'http';

/** «localhost:3000» from the port's URL, or the bare port when it has none. */
function hostOf(port: DetectedPort): string {
  try {
    return new URL(port.url).host || `localhost:${port.port}`;
  } catch {
    return `localhost:${port.port}`;
  }
}

/**
 * What the pill says for ports already sorted primary first: the first port a
 * browser can open (a menu when there are more), else the first one muted.
 * The pill only reads «:3000»; the full URL is in its tooltip.
 */
export function portPillFor(ports: readonly DetectedPort[]): PortPill | null {
  const open = ports.filter(openable);
  const first = open[0];
  if (first) {
    const menu = open.length > 1;
    const title = menu ? 'Elegir puerto' : `Abrir ${first.url}`;
    return { kind: 'open', text: `:${first.port}`, title, menu };
  }
  const other = ports[0];
  return other ? { kind: 'muted', text: `:${other.port}` } : null;
}

function menuEntries(owner: PortOwner): MenuEntry[] {
  return owner.ports.filter(openable).map((port) => ({
    label: port.label ? `${hostOf(port)} · ${port.label}` : hostOf(port),
    icon: 'arrow-up-right',
    run: () =>
      void window.api.openPort(owner.groupId, owner.commandId, port.port),
  }));
}

type OpenPill = Extract<PortPill, { kind: 'open' }>;

function buildButton(owner: PortOwner, pill: OpenPill): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'port-open';
  const text = document.createElement('span');
  text.textContent = pill.text;
  button.append(text, icon('arrow-up-right'));
  button.title = pill.title;
  if (pill.menu) {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () =>
      menu.toggle(button, menuEntries(owner)),
    );
  } else {
    button.addEventListener(
      'click',
      () => void window.api.openPort(owner.groupId, owner.commandId),
    );
  }
  return button;
}

function buildMuted(pill: PortPill): HTMLElement {
  const muted = document.createElement('span');
  muted.className = 'port-muted';
  muted.title = 'Puerto sin página web';
  muted.textContent = pill.text;
  return muted;
}

/** Draw the pill for the service on screen; hidden for anything else. */
export function renderPortPill(item: LogListItem | null): void {
  const owner =
    item?.type === 'command' && isRunning(item) ? owners.get(item.id) : null;
  const pill = owner ? portPillFor(owner.ports) : null;
  const signature =
    owner && pill
      ? JSON.stringify([owner.groupId, owner.commandId, owner.ports, pill])
      : '';
  if (portPillEl.dataset.signature === signature) return;
  portPillEl.dataset.signature = signature;
  menu.close();
  portPillEl.hidden = !(owner && pill);
  if (!owner || !pill) {
    portPillEl.replaceChildren();
    return;
  }
  portPillEl.replaceChildren(
    pill.kind === 'open' ? buildButton(owner, pill) : buildMuted(pill),
  );
}
