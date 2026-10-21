import { icon, iconButton, userIcon } from '../icon.js';
import { customIconIdOf } from '../../src/custom-icons.js';
import { createIconColorControl } from './icon-color-control.js';
import type { DeviceMenu } from './remote-device-menu.js';
import type { Group } from '../../src/domain-types.js';
import type { GroupRuntime } from './group-runtime.js';
import type { GroupStore } from './group-store.js';

export interface GroupHeaderDeps {
  store: GroupStore;
  runtime: GroupRuntime;
  menu: DeviceMenu;
  openIconPicker(
    anchorEl: HTMLElement,
    onSelect: (value: string) => void,
  ): void;
  /** Flips «Visible en la barra» — an instant write outside the draft. */
  toggleVisibility(stored: Group, visible: boolean): void;
  /** Called as the name is typed here, so other copies can follow it. */
  onRename?(value: string): void;
  duplicate(group: Group): void;
  remove(group: Group): void;
}

export interface GroupHeader {
  el: HTMLElement;
  /** The tablist goes under the identity row, inside the same header. */
  append(child: HTMLElement): void;
  /** Repaints what main reports live: the status pill and the branch. */
  refreshRuntime(): void;
  /** Mirrors the name typed elsewhere (the «Ajustes» tab). */
  setName(value: string): void;
  /** Mirrors the folder typed in the «Ajustes» tab. */
  setPath(value: string): void;
}

/**
 * The group's identity row: icon + colour, the name (edited in place), the
 * folder and its branch, a live «N en marcha» / «Parado» pill, the tray
 * visibility eye and the «⋯» menu of group-wide actions.
 */
export function buildGroupHeader(
  group: Group,
  deps: GroupHeaderDeps,
): GroupHeader {
  const { store } = deps;
  const header = document.createElement('div');
  header.className = 'detail-header';
  const row = document.createElement('div');
  row.className = 'detail-head-row';
  header.append(row);

  row.append(buildIconControl(group, deps));

  const identity = document.createElement('div');
  identity.className = 'detail-identity';
  const nameInput = document.createElement('input');
  nameInput.className = 'detail-name-input';
  nameInput.value = group.name || '';
  nameInput.placeholder = 'Nombre del grupo';
  nameInput.setAttribute('aria-label', 'Nombre del grupo');
  nameInput.addEventListener('input', () => {
    store.mutateDraft((d) => {
      d.name = nameInput.value;
    });
    deps.onRename?.(nameInput.value);
  });
  const pathLine = document.createElement('div');
  pathLine.className = 'detail-path-line';
  const pathEl = document.createElement('span');
  pathEl.className = 'detail-path';
  const pathText = document.createElement('span');
  pathText.className = 'detail-path-text';
  pathEl.append(icon('folder'), pathText);
  pathLine.append(pathEl);
  identity.append(nameInput, pathLine);
  row.append(identity);

  const status = document.createElement('span');
  status.className = 'detail-status';
  status.setAttribute('role', 'status');
  row.append(status, buildVisibility(group, deps), buildMore(group, deps));

  function setPath(value: string): void {
    pathText.textContent = value || 'Sin carpeta';
    pathEl.classList.toggle('is-empty', !value);
    pathText.title = value;
  }

  function refreshRuntime(): void {
    const running = deps.runtime.runningCount(group.id);
    status.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'detail-status-dot';
    status.append(dot, running > 0 ? `${running} en marcha` : 'Parado');
    status.classList.toggle('is-running', running > 0);

    const branch = deps.runtime.branch(group.id);
    pathLine.querySelector('.detail-branch')?.remove();
    if (!branch) return;
    const branchEl = document.createElement('span');
    branchEl.className = 'detail-branch';
    const branchName = document.createElement('span');
    branchName.textContent = branch;
    branchEl.append(icon('git-branch'), branchName);
    pathLine.append(branchEl);
  }

  setPath(group.path || '');
  refreshRuntime();

  return {
    el: header,
    append: (child) => header.append(child),
    refreshRuntime,
    setName: (value) => {
      nameInput.value = value;
    },
    setPath,
  };
}

function buildIconControl(group: Group, deps: GroupHeaderDeps): HTMLElement {
  let iconValue = group.icon;
  let iconColor = group.iconColor;
  const iconBtn = document.createElement('button');
  iconBtn.type = 'button';
  iconBtn.className = 'icon-btn';
  iconBtn.title = 'Cambiar icono';
  iconBtn.setAttribute('aria-label', iconBtn.title);
  iconBtn.dataset.groupId = group.id;
  const colorControl = createIconColorControl(iconBtn, (value) => {
    iconColor = value;
    paintIcon();
    deps.store.mutateDraft((d) => {
      d.iconColor = value;
    });
  });
  function paintIcon(): void {
    iconBtn.replaceChildren(userIcon(iconValue, 'package', iconColor));
    colorControl.setImage(customIconIdOf(iconValue) !== null);
  }
  colorControl.set(iconColor);
  paintIcon();
  iconBtn.addEventListener('click', (e) => {
    deps.openIconPicker(e.currentTarget as HTMLButtonElement, (value) => {
      iconValue = value;
      paintIcon();
      deps.store.mutateDraft((d) => {
        d.icon = value;
      });
    });
  });
  return colorControl.el;
}

/** «Visible en la barra»: the stored flag, since it never rides the draft. */
function buildVisibility(
  group: Group,
  deps: GroupHeaderDeps,
): HTMLButtonElement {
  const stored = deps.store.getGroups().find((g) => g.id === group.id) ?? group;
  const visible = !stored.hiddenInTray;
  const button = iconButton(
    visible ? 'eye' : 'eye-off',
    visible ? 'Ocultar de la barra' : 'Mostrar en la barra',
    'detail-icon-btn detail-visibility',
  );
  button.setAttribute(
    'aria-label',
    visible ? 'Visible en la barra' : 'Oculto en la barra',
  );
  button.setAttribute('aria-pressed', String(visible));
  button.addEventListener('click', () =>
    deps.toggleVisibility(stored, visible),
  );
  return button;
}

function buildMore(group: Group, deps: GroupHeaderDeps): HTMLElement {
  const host = document.createElement('span');
  host.className = 'detail-menu-host';
  const button = iconButton(
    'ellipsis',
    'Más acciones',
    'detail-icon-btn detail-more',
  );
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () =>
    deps.menu.toggle(button, [
      { label: 'Duplicar', icon: 'copy', run: () => deps.duplicate(group) },
      null,
      {
        label: 'Borrar grupo…',
        icon: 'trash-2',
        danger: true,
        run: () => deps.remove(group),
      },
    ]),
  );
  host.append(button);
  return host;
}
