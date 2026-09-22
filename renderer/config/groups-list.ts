import { attachDragHandlers } from '../dnd-helper.js';
import { latestWins } from '../latest-wins.js';
import type { Group } from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import { errorMessage, type ShowToast } from './toast.js';

export interface GroupsListDeps {
  /** The left pane's nav container (`#groups-list`). */
  listEl: HTMLElement;
  store: GroupStore;
  showToast: ShowToast;
  /** Late-bound: the detail pane is wired to this list by the entry point. */
  renderGroupDetail(): void;
}

export interface GroupsList {
  /** Re-reads every group from main and repaints the nav. */
  load(): Promise<void>;
  render(): void;
}

export function createGroupsList(deps: GroupsListDeps): GroupsList {
  const { store } = deps;

  /**
   * Ticket for the in-flight groups read. Every entry point into this window
   * re-reads the whole list — boot, `onUpdate`, and a dozen save/delete
   * handlers — and none of them waits for the one before it. Two reads in
   * flight at once means the LAST one to answer wins, which is not necessarily
   * the newest: a slow early read landing last puts groups back in the nav that
   * main has already dropped.
   */
  const groupListReads = latestWins();

  async function loadGroups(): Promise<void> {
    // Issuing this read retires every older one still in flight.
    groupListReads.invalidate();
    const current = groupListReads.claim();
    const groups = await window.api.listGroups();
    if (!current()) return; // a newer read already answered
    store.setGroups(groups);
    renderGroupsList();
  }

  function renderGroupsList(): void {
    const groups = store.getGroups();
    deps.listEl.innerHTML = '';
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'nav-empty muted';
      empty.textContent = 'Sin grupos. Pulsa + Añadir.';
      deps.listEl.appendChild(empty);
      return;
    }

    // Land on something editable instead of an empty panel telling you to pick.
    // Only when nothing is selected and nothing is half-edited, so a refresh
    // mid-edit never yanks the user off their own draft.
    const first = groups[0];
    if (!store.getSelectedId() && !store.isDirty() && first) {
      store.setSelectedId(first.id);
      store.loadDraftFromStored(first.id);
    }

    for (const group of groups) {
      const card = buildGroupNavCard(group);
      deps.listEl.appendChild(card);
    }

    // Attach drag-and-drop for group reordering
    attachDragHandlers(deps.listEl, async (orderedIds) => {
      await window.api.reorderGroups(orderedIds);
      await loadGroups();
    });

    // Only re-render detail when clean — preserve in-progress edits
    if (store.getSelectedId() && !store.isDirty()) deps.renderGroupDetail();
  }

  function buildGroupNavCard(group: Group): HTMLElement {
    const card = document.createElement('div');
    card.className = `nav-card drag-row ${group.id === store.getSelectedId() ? 'selected' : ''}`;
    card.dataset.id = group.id;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.draggable = true;
    handle.title = 'Arrastra para reordenar';
    handle.textContent = '⋮⋮';
    card.appendChild(handle);

    const iconEl = document.createElement('span');
    iconEl.className = 'nav-icon';
    iconEl.textContent = group.icon || '📦';
    card.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'nav-name';
    nameEl.textContent = group.name || '(sin nombre)';
    card.appendChild(nameEl);

    card.addEventListener('click', async (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('.drag-handle'))
        return;
      if (group.id === store.getSelectedId()) return;
      if (store.isDirty()) {
        const { choice } = await window.api.confirmDirty('nav-switch');
        if (choice === 'cancel') return;
        if (choice === 'save') {
          try {
            const saved = await store.saveDraft();
            if (!saved) return; // empty path — abort switch, stay on this group
            await loadGroups();
          } catch (err) {
            deps.showToast(`Error: ${errorMessage(err)}`, 'error');
            return;
          }
        }
        // 'discard' falls through
      }
      store.setSelectedId(group.id);
      store.loadDraftFromStored(group.id);
      renderGroupsList();
      deps.renderGroupDetail();
    });

    return card;
  }

  return { load: loadGroups, render: renderGroupsList };
}
