import { icon } from '../icon.js';
import { attachDragHandlers } from '../dnd-helper.js';
import type {
  Action,
  Command,
  Group,
  PreScript,
} from '../../src/domain-types.js';
import type { GroupRuntime } from './group-runtime.js';
import type { GroupStore } from './group-store.js';
import type { DeviceMenu, MenuEntry } from './remote-device-menu.js';
import { autoTag, buildSubRow, scheduleTag } from './sub-list-row.js';
import type { ShowToast } from './toast.js';

type SubKind = 'command' | 'action' | 'prescript';
type SliceKey = 'commands' | 'actions' | 'preScripts';

export interface SubListsDeps {
  store: GroupStore;
  runtime: GroupRuntime;
  menu: DeviceMenu;
  showToast: ShowToast;
  openSubDialog(
    item: Command | Action | PreScript | null,
    kind: SubKind,
    groupId: string,
  ): void;
  loadGroups(): Promise<void>;
  renderGroupDetail(): void;
  refreshPipeline(): Promise<void>;
}

export interface SubLists {
  /**
   * Build this group's flat pre-script DEFINITION library and append it to
   * `parent`. Placement into a workflow is a SEPARATE concern, owned by the
   * «Workflows» section — this list is purely CRUD over `group.preScripts`.
   */
  buildPreScriptsLibrary(group: Group, parent: HTMLElement): void;
  buildSubList(
    group: Group,
    kind: 'command' | 'action',
    parent: HTMLElement,
  ): void;
  /** Re-marks which rows are running, without rebuilding anything. */
  refreshRunning(groupId: string, root: HTMLElement): void;
}

const TITLES: Record<SubKind, string> = {
  command: 'Comandos',
  action: 'Acciones',
  prescript: 'Pre-scripts',
};
const ADD_LABELS: Record<SubKind, string> = {
  command: 'Añadir comando',
  action: 'Añadir acción',
  prescript: 'Añadir pre-script',
};
const SLICES: Record<SubKind, SliceKey> = {
  command: 'commands',
  action: 'actions',
  prescript: 'preScripts',
};

function commandLine(item: { command: string; args?: string[] }): string {
  return [item.command, ...(item.args || [])].join(' ');
}

export function createSubLists(deps: SubListsDeps): SubLists {
  const { store } = deps;

  /** «COMANDOS · N» with a text «+ Añadir» at the trailing edge. */
  function buildHeader(
    group: Group,
    kind: SubKind,
    count: number,
  ): HTMLElement {
    const headerRow = document.createElement('div');
    headerRow.className = 'sub-list-header';
    const title = document.createElement('span');
    title.className = 'sub-list-title';
    title.textContent = `${TITLES[kind]} · ${count}`;
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'sub-add-btn';
    addBtn.setAttribute('aria-label', ADD_LABELS[kind]);
    const label = document.createElement('span');
    label.textContent = 'Añadir';
    addBtn.append(icon('plus'), label);
    addBtn.addEventListener('click', () =>
      deps.openSubDialog(null, kind, group.id),
    );
    headerRow.append(title, addBtn);
    return headerRow;
  }

  /** Re-reads a slice an instant write just changed, into the draft too. */
  async function afterInstantWrite(groupId: string, kind: SubKind) {
    await deps.loadGroups();
    store.syncPersistedSlice(groupId, SLICES[kind]);
    deps.renderGroupDetail();
  }

  async function reorder(group: Group, kind: SubKind, ids: string[]) {
    if (kind === 'command') await window.api.reorderCommands(group.id, ids);
    else if (kind === 'action') await window.api.reorderActions(group.id, ids);
    else await window.api.reorderPreScripts(group.id, ids);
    await afterInstantWrite(group.id, kind);
  }

  async function remove(
    groupId: string,
    kind: SubKind,
    item: Command | Action | PreScript,
  ): Promise<void> {
    if (!confirm(`¿Borrar "${item.name}"?`)) return;
    if (kind === 'prescript') {
      await window.api.deletePreScript(groupId, item.id);
      await afterInstantWrite(groupId, kind);
      await deps.refreshPipeline(); // deleting a definition prunes its refs from the pipeline
      return;
    }
    const res =
      kind === 'command'
        ? await window.api.deleteCommand(groupId, item.id)
        : await window.api.deleteAction(groupId, item.id);
    if (!res.ok) {
      // The main side aborts the deletion when the stop of a running
      // process fails — surface why, and leave the item visible.
      deps.showToast(res.error || 'No se pudo borrar el elemento', 'error');
      return;
    }
    // Same instant-write contract as a reorder: without this the deleted
    // item is still in the draft, and saving puts it back.
    await afterInstantWrite(groupId, kind);
  }

  /** «Duplicar»: a new item named «… (copia)» that starts nothing itself. */
  async function duplicate(
    groupId: string,
    kind: SubKind,
    item: Command | Action | PreScript,
  ): Promise<void> {
    const copy: Record<string, unknown> = {
      ...structuredClone(item),
      id: undefined,
      name: `${item.name} (copia)`,
    };
    if ('autoStart' in item) copy.autoStart = false;
    if ('schedule' in item)
      copy.schedule = { ...item.schedule, enabled: false };
    try {
      if (kind === 'command') await window.api.saveCommand(groupId, copy);
      else if (kind === 'action') await window.api.saveAction(groupId, copy);
      else await window.api.savePreScript(groupId, copy);
      await deps.loadGroups();
      store.adoptSavedSlice(groupId, SLICES[kind]);
      deps.renderGroupDetail();
    } catch {
      deps.showToast('No se pudo duplicar', 'error');
    }
  }

  function menuEntries(
    groupId: string,
    kind: SubKind,
    item: Command | Action | PreScript,
  ): MenuEntry[] {
    return [
      {
        label: 'Duplicar',
        icon: 'copy',
        run: () => void duplicate(groupId, kind, item),
      },
      null,
      {
        label: 'Borrar',
        icon: 'trash-2',
        danger: true,
        run: () => void remove(groupId, kind, item),
      },
    ];
  }

  /**
   * The ⚡ toggle — commands only: actions are one-shots, never started at
   * boot. An INSTANT write, like reorder and delete.
   */
  function autoStartToggle(groupId: string, item: Command): HTMLElement {
    const isOn = item.autoStart;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sub-action-btn autostart-toggle${isOn ? ' is-on' : ''}`;
    button.append(icon('zap'));
    button.title = isOn
      ? 'Auto-arranca con DevBar — click para desactivar'
      : 'Auto-arrancar al iniciar DevBar';
    button.setAttribute('aria-label', 'Auto-arrancar al iniciar DevBar');
    button.setAttribute('aria-pressed', String(isOn));
    button.addEventListener('click', async () => {
      button.disabled = true;
      const res = await window.api.setCommandAutoStart(groupId, item.id, !isOn);
      button.disabled = false;
      if (res && res.ok === false) {
        deps.showToast(`Error: ${res.error || 'desconocido'}`, 'error');
        return;
      }
      // Fold the persisted slice back into the draft the pane renders and
      // saves, or the next save writes the old commands over the flag.
      await afterInstantWrite(groupId, 'command');
    });
    return button;
  }

  function buildRow(
    group: Group,
    kind: SubKind,
    item: Command | Action | PreScript,
  ): HTMLElement {
    const tags: HTMLElement[] = [];
    const extraActions: HTMLElement[] = [];
    if ('autoStart' in item) {
      if (item.autoStart) tags.push(autoTag());
      extraActions.push(autoStartToggle(group.id, item));
    }
    if ('schedule' in item) {
      const scheduled = scheduleTag(item.schedule);
      if (scheduled) tags.push(scheduled);
    }
    const hasIcon = 'icon' in item;
    return buildSubRow(
      {
        id: item.id,
        name: item.name || 'Unnamed',
        commandLine: commandLine(item),
        icon: hasIcon ? item.icon : 'scroll-text',
        iconColor: hasIcon ? item.iconColor : null,
        fallbackIcon:
          kind === 'command'
            ? 'terminal'
            : kind === 'action'
              ? 'wand-sparkles'
              : 'scroll-text',
        tags,
        running: deps.runtime.isRunning(group.id, item.id),
        extraActions,
        edit: () => deps.openSubDialog(item, kind, group.id),
        menuEntries: () => menuEntries(group.id, kind, item),
        openMenu: (trigger, entries) => deps.menu.toggle(trigger, entries),
      },
      kind === 'prescript' ? 'sub-item-row prescript-row' : 'sub-item-row',
    );
  }

  function buildList(
    group: Group,
    kind: SubKind,
    items: ReadonlyArray<Command | Action | PreScript>,
    parent: HTMLElement,
  ): void {
    const section = document.createElement('div');
    section.className =
      kind === 'prescript'
        ? 'detail-section sub-list-section presteps-section'
        : 'detail-section sub-list-section';
    section.append(buildHeader(group, kind, items.length));

    const listEl = document.createElement('div');
    listEl.className = 'sub-item-list';
    listEl.dataset.kind = kind;
    listEl.dataset.groupId = group.id;
    for (const item of items) listEl.append(buildRow(group, kind, item));
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sub-list-empty';
      empty.textContent = `Sin ${TITLES[kind].toLowerCase()}.`;
      listEl.append(empty);
    }
    section.append(listEl);
    parent.append(section);

    attachDragHandlers(listEl, (orderedIds) =>
      reorder(group, kind, orderedIds),
    );
  }

  return {
    buildPreScriptsLibrary: (group, parent) => {
      buildList(group, 'prescript', group.preScripts || [], parent);
      const help = document.createElement('p');
      help.className = 'sub-list-help';
      help.textContent =
        'Colócalos en un workflow desde la sección «Workflows».';
      parent.append(help);
    },
    buildSubList: (group, kind, parent) =>
      buildList(
        group,
        kind,
        kind === 'command' ? group.commands || [] : group.actions || [],
        parent,
      ),
    refreshRunning: (groupId, root) => {
      for (const row of root.querySelectorAll<HTMLElement>(
        '.sub-item-row[data-id]',
      ))
        row.classList.toggle(
          'is-running',
          deps.runtime.isRunning(groupId, row.dataset.id ?? ''),
        );
    },
  };
}
