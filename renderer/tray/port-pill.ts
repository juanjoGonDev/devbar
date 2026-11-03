/**
 * The tray's port pill: the ports main detected for a running command (or,
 * on a collapsed group's header, for the whole group) as a compact `:3000`
 * that opens the page, a «+N» chevron that unfolds every port, and the
 * «buscando puerto…» chip while a fresh command has not announced one yet.
 *
 * The menu is rendered in the list's flow, below its row, rather than
 * floating: the popover sizes itself from the list's content height, so an
 * in-flow menu grows the popover instead of being clipped by it. Which menu
 * is open is module state, like a group's expanded flag, so it survives the
 * repaints a state push triggers.
 */
import { icon } from '../icon.js';
import { spinPhase } from '../spin-phase.js';
import { rerenderTray, showToast } from './host.js';
import type {
  CommandRuntimeState,
  GroupState,
} from '../../src/ipc-contract.js';
import type { DetectedPort } from '../../src/domain-types.js';

/** How long a running command with no port yet shows «buscando puerto…». */
export const PORT_SEARCH_WINDOW_MS = 30_000;

/** A port and the command that listens on it. */
interface PortEntry {
  groupId: string;
  commandId: string;
  port: DetectedPort;
}

export interface PortsUi {
  /** Goes in the row. */
  pill: HTMLElement;
  /** Goes right after the row, while its menu is open. */
  menu: HTMLElement | null;
}

let openMenuKey: string | null = null;

function setOpenMenu(key: string | null): void {
  openMenuKey = key;
  rerenderTray();
}

// One listener pair for the whole window: Escape, or a click anywhere but the
// menu and its chevron, closes the open menu.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenuKey !== null) setOpenMenu(null);
});
document.addEventListener('click', (event) => {
  if (openMenuKey === null) return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest('.port-menu, .port-pill-more')
  )
    return;
  setOpenMenu(null);
});

const isOpenable = (port: DetectedPort): boolean => port.kind !== 'other';

const otherTip = (port: DetectedPort): string =>
  `Escuchando en ${port.port} (no es una web)`;

/** `http://localhost:5173/` → `localhost:5173`. */
function hostOf(port: DetectedPort): string {
  try {
    return new URL(port.url).host;
  } catch {
    return `:${port.port}`;
  }
}

async function open(entry: PortEntry): Promise<void> {
  try {
    const result = await window.api.openPort(
      entry.groupId,
      entry.commandId,
      entry.port.port,
    );
    if (!result.ok)
      showToast(result.error ?? 'No se pudo abrir el puerto', 'error');
  } catch {
    showToast('No se pudo abrir el puerto', 'error');
  }
}

async function copyUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    showToast('URL copiada');
  } catch {
    showToast('No se pudo copiar la URL', 'error');
  }
}

function openButton(entry: PortEntry): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'port-pill-open';
  btn.append(`:${entry.port.port}`, icon('arrow-up-right'));
  btn.setAttribute('aria-label', `Abrir ${entry.port.url}`);
  btn.title = btn.getAttribute('aria-label') ?? '';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    void open(entry);
  });
  return btn;
}

function buildPill(
  key: string,
  title: string,
  entries: PortEntry[],
): PortsUi | null {
  const [primary, ...rest] = entries;
  if (!primary) return null;
  const pill = document.createElement('span');
  pill.className = `port-pill ${isOpenable(primary.port) ? 'is-web' : 'is-other'}`;
  if (isOpenable(primary.port)) {
    pill.append(openButton(primary));
  } else {
    pill.append(`:${primary.port.port}`);
    pill.title = otherTip(primary.port);
  }
  if (rest.length === 0) return { pill, menu: null };

  const isOpen = openMenuKey === key;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'port-pill-more';
  more.append(`+${rest.length}`, icon('chevron-down'));
  more.setAttribute('aria-label', `Ver los ${entries.length} puertos`);
  more.setAttribute('aria-expanded', String(isOpen));
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpenMenu(isOpen ? null : key);
  });
  pill.append(more);
  return { pill, menu: isOpen ? buildMenu(title, entries, primary) : null };
}

function buildMenu(
  title: string,
  entries: PortEntry[],
  primary: PortEntry,
): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'port-menu';
  menu.setAttribute('role', 'menu');

  const heading = document.createElement('div');
  heading.className = 'port-menu-title';
  heading.textContent = `Puertos de ${title}`;
  menu.append(heading);

  for (const entry of entries) {
    const address = document.createElement('span');
    address.className = 'port-menu-address';
    address.textContent = hostOf(entry.port);
    const parts: (Node | string)[] = [address];
    if (entry.port.label) {
      const label = document.createElement('span');
      label.className = 'port-menu-label';
      label.textContent = entry.port.label;
      parts.push(label);
    }
    if (isOpenable(entry.port)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'port-menu-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-label', `Abrir ${entry.port.url}`);
      item.append(...parts, icon('arrow-up-right'));
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        openMenuKey = null;
        void open(entry);
        rerenderTray();
      });
      menu.append(item);
    } else {
      const item = document.createElement('div');
      item.className = 'port-menu-item is-other';
      item.title = otherTip(entry.port);
      item.append(...parts);
      menu.append(item);
    }
  }

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'port-menu-copy';
  copy.setAttribute('role', 'menuitem');
  copy.append(icon('copy'), 'Copiar URL');
  copy.addEventListener('click', (event) => {
    event.stopPropagation();
    void copyUrl(primary.port.url);
  });
  menu.append(copy);
  return menu;
}

// A single timer repaints the tray when the earliest «buscando puerto…» chip
// runs out, so the chip disappears even if no state push arrives.
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchDeadline = Infinity;

function repaintAt(deadline: number): void {
  if (searchTimer !== null && deadline >= searchDeadline) return;
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchDeadline = deadline;
  searchTimer = setTimeout(
    () => {
      searchTimer = null;
      searchDeadline = Infinity;
      rerenderTray();
    },
    Math.max(0, deadline - Date.now()),
  );
}

function searchingChip(startedAt: number): PortsUi {
  repaintAt(startedAt + PORT_SEARCH_WINDOW_MS);
  const chip = document.createElement('span');
  chip.className = 'port-searching';
  const spinner = icon('loader-circle');
  spinner.classList.add('port-searching-spin');
  chip.append(spinPhase(spinner), 'buscando puerto…');
  return { pill: chip, menu: null };
}

/** A command row's ports: the pill, the searching chip, or nothing. */
export function commandPorts(
  gs: GroupState,
  cs: CommandRuntimeState,
  commandName: string,
): PortsUi | null {
  if (cs.status !== 'running') return null;
  const ports = cs.ports ?? [];
  if (ports.length === 0) {
    const fresh =
      cs.startedAt !== null &&
      Date.now() - cs.startedAt < PORT_SEARCH_WINDOW_MS;
    return fresh && cs.startedAt !== null ? searchingChip(cs.startedAt) : null;
  }
  return buildPill(
    `command:${gs.groupId}:${cs.commandId}`,
    commandName,
    ports.map((port) => ({
      groupId: gs.groupId,
      commandId: cs.commandId,
      port,
    })),
  );
}

/**
 * A collapsed group's pill: its first web port across its running commands,
 * with every other openable port behind the chevron. Nothing without a web.
 */
export function groupPorts(gs: GroupState): PortsUi | null {
  const entries: PortEntry[] = gs.commands
    .filter((cs) => cs.status === 'running')
    .flatMap((cs) =>
      (cs.ports ?? []).filter(isOpenable).map((port) => ({
        groupId: gs.groupId,
        commandId: cs.commandId,
        port,
      })),
    );
  const primary = entries.find((entry) => entry.port.kind === 'web');
  if (!primary) return null;
  return buildPill(`group:${gs.groupId}`, gs.group?.name || 'este grupo', [
    primary,
    ...entries.filter((entry) => entry !== primary),
  ]);
}
