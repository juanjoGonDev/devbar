import { attachDragHandlers } from '../dnd-helper.js';
import type {
  Action,
  Command,
  Group,
  PreScript,
} from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import { summarizeSchedule } from './schedule-editor.js';
import type { ShowToast } from './toast.js';

export interface SubListsDeps {
  store: GroupStore;
  showToast: ShowToast;
  openSubDialog(
    item: Command | Action | PreScript | null,
    kind: 'command' | 'action' | 'prescript',
    groupId: string,
  ): void;
  loadGroups(): Promise<void>;
  renderGroupDetail(): void;
  refreshPipeline(): Promise<void>;
}

export interface SubLists {
  /**
   * Build this group's flat pre-script DEFINITION library and append it to
   * `parent`. Placement into the global pipeline (steps/order) is a SEPARATE
   * concern now, owned by the "Pipeline" nav section (`pipeline-editor.ts`) —
   * this list is purely CRUD over `group.preScripts`, modeled on `buildSubList`.
   */
  buildPreScriptsLibrary(group: Group, parent: HTMLElement): void;
  buildSubList(
    group: Group,
    kind: 'command' | 'action',
    parent: HTMLElement,
  ): void;
}

export function createSubLists(deps: SubListsDeps): SubLists {
  const { store } = deps;

  function buildPreScriptsLibrary(group: Group, parent: HTMLElement): void {
    const section = document.createElement('div');
    section.className = 'detail-section presteps-section';

    const headerRow = document.createElement('div');
    headerRow.className = 'sub-list-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'section-label';
    titleSpan.textContent = 'Pre-scripts';
    headerRow.appendChild(titleSpan);
    const addBtn = document.createElement('button');
    addBtn.className = 'small-btn';
    addBtn.textContent = '+ Añadir pre-script';
    addBtn.addEventListener('click', () =>
      deps.openSubDialog(null, 'prescript', group.id),
    );
    headerRow.appendChild(addBtn);
    section.appendChild(headerRow);

    const helpText = document.createElement('p');
    helpText.className = 'help-text muted';
    helpText.style.cssText = 'font-size:11px; margin:4px 0 8px;';
    helpText.textContent =
      'Definiciones reutilizables de este grupo. Colócalas en el orden del pipeline global desde la sección «Pipeline».';
    section.appendChild(helpText);

    const scripts = group.preScripts || [];
    if (scripts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'prestep-empty';
      empty.textContent =
        'Sin pre-scripts. Pulsa «+ Añadir pre-script» para crear uno.';
      section.appendChild(empty);
      parent.appendChild(section);
      return;
    }

    const listEl = document.createElement('ul');
    listEl.className = 'prescript-list';
    for (const script of scripts) {
      listEl.appendChild(buildPreScriptLibraryRow(group, script));
    }
    section.appendChild(listEl);

    attachDragHandlers(listEl, async (orderedIds) => {
      await window.api.reorderPreScripts(group.id, orderedIds);
      await deps.loadGroups();
      store.syncPersistedSlice(group.id, 'preScripts');
      deps.renderGroupDetail();
    });

    parent.appendChild(section);
  }

  function buildPreScriptLibraryRow(
    group: Group,
    script: PreScript,
  ): HTMLElement {
    const li = document.createElement('li');
    // `drag-row` carries the shared handle reveal, dragging state and drop
    // indicator that every other draggable row in this window already uses.
    li.className = 'prescript-row drag-row';
    li.dataset.id = script.id;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.draggable = true;
    dragHandle.title = 'Arrastra para reordenar';
    dragHandle.textContent = '⋮';
    li.appendChild(dragHandle);

    const nameEl = document.createElement('strong');
    nameEl.textContent = script.name || 'Unnamed';
    li.appendChild(nameEl);

    const cmdEl = document.createElement('code');
    cmdEl.textContent = [script.command, ...(script.args || [])].join(' ');
    li.appendChild(cmdEl);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    li.appendChild(spacer);

    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Editar';
    editBtn.className = 'small-btn';
    editBtn.addEventListener('click', () =>
      deps.openSubDialog(script, 'prescript', group.id),
    );
    li.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = 'Borrar';
    delBtn.className = 'small-btn danger';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`¿Borrar "${script.name}"?`)) return;
      await window.api.deletePreScript(group.id, script.id);
      await deps.loadGroups();
      store.syncPersistedSlice(group.id, 'preScripts');
      deps.renderGroupDetail();
      await deps.refreshPipeline(); // deleting a definition prunes its refs from the pipeline
    });
    li.appendChild(delBtn);

    return li;
  }

  function buildSubList(
    group: Group,
    kind: 'command' | 'action',
    parent: HTMLElement,
  ): void {
    const isCommand = kind === 'command';
    const items = isCommand ? group.commands || [] : group.actions || [];
    const sectionTitle = isCommand ? 'Comandos' : 'Acciones';
    const addLabel = isCommand ? '+ Añadir comando' : '+ Añadir acción';

    const section = document.createElement('div');
    section.className = 'detail-section';

    const headerRow = document.createElement('div');
    headerRow.className = 'sub-list-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'section-label';
    titleSpan.textContent = sectionTitle;
    headerRow.appendChild(titleSpan);
    const addBtn = document.createElement('button');
    addBtn.className = 'small-btn';
    addBtn.textContent = addLabel;
    addBtn.addEventListener('click', () =>
      deps.openSubDialog(null, kind, group.id),
    );
    headerRow.appendChild(addBtn);
    section.appendChild(headerRow);

    const listEl = document.createElement('div');
    listEl.className = 'sub-item-list';
    listEl.dataset.kind = kind;
    listEl.dataset.groupId = group.id;

    for (const item of items) {
      listEl.appendChild(buildSubItemRow(item, kind, group.id));
    }

    section.appendChild(listEl);
    parent.appendChild(section);

    // DnD for sub-list
    attachDragHandlers(listEl, async (orderedIds) => {
      if (isCommand) {
        await window.api.reorderCommands(group.id, orderedIds);
      } else {
        await window.api.reorderActions(group.id, orderedIds);
      }
      await deps.loadGroups();
      store.syncPersistedSlice(
        group.id,
        kind === 'command' ? 'commands' : 'actions',
      );
      deps.renderGroupDetail();
    });
  }

  function buildSubItemRow(
    item: Command | Action,
    kind: 'command' | 'action',
    groupId: string,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sub-item-row drag-row';
    row.dataset.id = item.id;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.draggable = true;
    handle.title = 'Arrastra para reordenar';
    handle.textContent = '⋮⋮';
    row.appendChild(handle);

    if (item.icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'sub-icon';
      iconEl.textContent = item.icon;
      row.appendChild(iconEl);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'sub-name';
    nameEl.textContent = item.name;
    row.appendChild(nameEl);

    const cmdSummary = document.createElement('span');
    cmdSummary.className = 'sub-cmd muted';
    cmdSummary.textContent = [item.command, ...(item.args || [])].join(' ');
    row.appendChild(cmdSummary);

    const actions = document.createElement('div');
    actions.className = 'sub-actions';

    // Auto-start toggle — only for commands (actions are one-shots and
    // not eligible for boot auto-start). Lives in the listing so single-
    // mode radio behaviour is obvious at a glance.
    if (kind === 'command' && 'autoStart' in item) {
      const autoBtn = document.createElement('button');
      const isOn = item.autoStart;
      autoBtn.className = `small-btn autostart-toggle${isOn ? ' is-on' : ''}`;
      autoBtn.textContent = '⚡';
      autoBtn.title = isOn
        ? 'Auto-arranca con DevBar — click para desactivar'
        : 'Auto-arrancar al iniciar DevBar';
      autoBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        autoBtn.disabled = true;
        const res = await window.api.setCommandAutoStart(
          groupId,
          item.id,
          !isOn,
        );
        autoBtn.disabled = false;
        if (res && res.ok === false) {
          deps.showToast(`Error: ${res.error || 'desconocido'}`, 'error');
          return;
        }
        await deps.loadGroups();
        // An INSTANT write, like reorder and delete: fold the persisted slice
        // back into the draft the pane renders and saves, or the next save
        // writes the old commands over the flag that was just set.
        store.syncPersistedSlice(groupId, 'commands');
        deps.renderGroupDetail();
      });
      actions.appendChild(autoBtn);
    }

    // Schedule indicator — commands and actions. Click opens the editor where the
    // schedule lives.
    if (
      (kind === 'command' || kind === 'action') &&
      item.schedule &&
      item.schedule.enabled &&
      (item.schedule.rules || []).length > 0
    ) {
      const schedBtn = document.createElement('button');
      schedBtn.className = 'small-btn schedule-badge is-on';
      schedBtn.textContent = '🕐';
      schedBtn.title = `Programado: ${summarizeSchedule(item.schedule)} — click para editar`;
      schedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.openSubDialog(item, kind, groupId);
      });
      actions.appendChild(schedBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Editar';
    editBtn.className = 'small-btn';
    editBtn.addEventListener('click', () =>
      deps.openSubDialog(item, kind, groupId),
    );
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = 'Borrar';
    delBtn.className = 'small-btn danger';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`¿Borrar "${item.name}"?`)) return;
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
      await deps.loadGroups();
      // Same instant-write contract as the reorder above: without this the
      // deleted item is still in the draft, and saving puts it back.
      store.syncPersistedSlice(
        groupId,
        kind === 'command' ? 'commands' : 'actions',
      );
      deps.renderGroupDetail();
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
    return row;
  }

  return { buildPreScriptsLibrary, buildSubList };
}
