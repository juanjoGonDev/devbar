import { latestWins } from '../latest-wins.js';
import type { Group } from '../../src/domain-types.js';
import type { ShowToast } from './toast.js';

type SavedGroup = Group & { _autoStartEnforced?: boolean };

/** The slices an INSTANT write (reorder, delete, sub-dialog save) can persist
 * behind the draft's back. */
type GroupSlice = 'preScripts' | 'commands' | 'actions';

export interface GroupStoreDeps {
  showToast: ShowToast;
  /**
   * Re-renders the detail pane. Late-bound: the pane is built from this store,
   * so the entry point wires the two together after both exist.
   */
  renderGroupDetail(): void;
}

export interface GroupStore {
  /** Every group as main last reported it. */
  getGroups(): Group[];
  setGroups(groups: Group[]): void;
  getSelectedId(): string | null;
  setSelectedId(groupId: string | null): void;
  /** The in-memory copy of the selected group being edited. */
  getDraft(): Group | null;
  isDirty(): boolean;
  loadDraftFromStored(groupId: string): void;
  mutateDraft(mut: (group: Group) => void): void;
  /** Throws away the draft's edits, back to the last-persisted snapshot. */
  discardDraft(): void;
  /** Drops both snapshots — nothing is selected any more. */
  clearDraft(): void;
  updateSaveBar(): void;
  saveDraft(): Promise<SavedGroup | null>;
  syncPersistedSlice(groupId: string, key: GroupSlice): void;
  adoptSavedSlice(groupId: string, key: GroupSlice): void;
}

export function createGroupStore(deps: GroupStoreDeps): GroupStore {
  let allGroups: Group[] = [];
  let selectedGroupId: string | null = null;
  // draftGroup: in-memory copy of the selected group being edited
  // storedGroup: last-persisted snapshot (the "clean" baseline for dirty check)
  let draftGroup: Group | null = null;
  let storedGroup: Group | null = null;

  /**
   * Ticket for the in-flight group save. The save bar only disables itself when
   * the pane is CLEAN, never while a save is in flight, so a second edit and
   * save overlaps the first — and the older response landing last would put its
   * canonical group back into `allGroups`, showing the previous name in the nav
   * while disk already holds the newer one.
   */
  const groupSaves = latestWins();

  function isDirty(): boolean {
    if (!storedGroup || !draftGroup) return false;
    return JSON.stringify(draftGroup) !== JSON.stringify(storedGroup);
  }

  function loadDraftFromStored(groupId: string): void {
    const g = allGroups.find((x) => x.id === groupId);
    if (!g) {
      draftGroup = null;
      storedGroup = null;
      return;
    }
    storedGroup = structuredClone(g);
    draftGroup = structuredClone(g);
  }

  function updateSaveBar(): void {
    const dirty = isDirty();
    const saveBtn = document.getElementById(
      'detail-save',
    ) as HTMLButtonElement | null;
    const discardBtn = document.getElementById(
      'detail-discard',
    ) as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = !dirty;
    if (discardBtn) discardBtn.disabled = !dirty;
  }

  function mutateDraft(mut: (group: Group) => void): void {
    if (!draftGroup) return;
    mut(draftGroup);
    updateSaveBar();
  }

  /**
   * The single validated save path for the selected group's draft. Every place
   * that persists a group (save bar, group-switch "guardar", window-close
   * "guardar") MUST go through here so validation is consistent — otherwise the
   * discard-dialog "guardar" would smuggle an invalid group past the checks the
   * save bar enforces.
   *
   * Returns the saved group on success, or null if validation failed (the toast
   * is already shown; callers must abort any follow-up like switching or
   * closing). Throws only on an unexpected IPC error, which callers surface as
   * a toast.
   */
  async function saveDraft(): Promise<SavedGroup | null> {
    if (!draftGroup) return null;
    if (!draftGroup.path) {
      deps.showToast('El path no puede estar vacío', 'error');
      return null;
    }
    // Issuing this save retires every older one still in flight.
    groupSaves.invalidate();
    const current = groupSaves.claim();
    const savedGroup = await window.api.saveGroup(draftGroup);
    if (!savedGroup) {
      // Validation failed (the toast is already shown). storedGroup must stay
      // what it was: adopting the rejected draft as the "clean baseline"
      // would make isDirty() lie, hiding the unsaved-changes bar and the
      // retry/discard options for the user's real edits.
      return null;
    }
    // A newer save already owns the state. This one still SUCCEEDED, so it is
    // reported as such — callers use `null` to mean "rejected, abort the
    // follow-up", and a window close must not be blocked by a save that worked.
    if (!current()) return savedGroup;
    const { _autoStartEnforced, ...canonical } = savedGroup;
    const idx = allGroups.findIndex((group) => group.id === canonical.id);
    if (idx >= 0) allGroups[idx] = canonical;
    if (_autoStartEnforced) {
      // The server ENFORCED changes (single mode strips the extra
      // auto-start flags), so the persisted group differs from what the
      // editor is showing. Adopt the canonical group as BOTH the clean
      // baseline and the draft, then re-render the detail pane — otherwise
      // the form would display values that were never persisted, the group
      // would read as "clean" while disagreeing with disk, and Discard
      // would restore the stale pre-enforcement draft.
      storedGroup = structuredClone(canonical);
      draftGroup = structuredClone(canonical);
      deps.renderGroupDetail();
    } else {
      // No enforcement: the dirty-check baseline is the DRAFT itself — a
      // successful save means exactly what the user is looking at is now
      // persisted. Basing it on the IPC response leaves the group "dirty"
      // after every save: the response is a re-normalized shape the draft
      // does not byte-for-byte reproduce, and the stringify comparison
      // cannot ignore that.
      storedGroup = structuredClone(draftGroup);
    }
    return savedGroup;
  }

  /**
   * Copies a slice that an INSTANT write just persisted into both active
   * snapshots of the selected group.
   *
   * Reorder and delete write straight to the store, but the detail pane renders
   * from `draftGroup` and saving the group writes `draftGroup` back — so
   * without this the pane shows the old order and the next save silently undoes
   * what was already persisted. Only the named slice is copied: the rest of
   * `draftGroup` may hold unsaved edits to other fields.
   */
  function syncPersistedSlice(groupId: string, key: GroupSlice): void {
    const fresh = allGroups.find((candidate) => candidate.id === groupId);
    if (!fresh) return;
    if (storedGroup?.id === groupId)
      storedGroup = { ...storedGroup, [key]: structuredClone(fresh[key]) };
    if (draftGroup?.id === groupId)
      draftGroup = { ...draftGroup, [key]: structuredClone(fresh[key]) };
  }

  /**
   * The sub-dialog's variant: merge the slice the dialog just saved back into
   * BOTH snapshots in place, so the sub-list reflects the updated item while
   * parent-level edits to the draft are preserved.
   */
  function adoptSavedSlice(groupId: string, key: GroupSlice): void {
    if (!draftGroup || draftGroup.id !== groupId) return;
    const fresh = allGroups.find((g) => g.id === groupId);
    if (!fresh || !storedGroup) return;
    if (key === 'preScripts') {
      const freshSlice = structuredClone(fresh.preScripts);
      storedGroup.preScripts = freshSlice;
      draftGroup.preScripts = structuredClone(freshSlice);
    } else if (key === 'commands') {
      const freshSlice = structuredClone(fresh.commands);
      storedGroup.commands = freshSlice;
      draftGroup.commands = structuredClone(freshSlice);
    } else {
      const freshSlice = structuredClone(fresh.actions);
      storedGroup.actions = freshSlice;
      draftGroup.actions = structuredClone(freshSlice);
    }
  }

  return {
    getGroups: () => allGroups,
    setGroups: (groups) => {
      allGroups = groups;
    },
    getSelectedId: () => selectedGroupId,
    setSelectedId: (groupId) => {
      selectedGroupId = groupId;
    },
    getDraft: () => draftGroup,
    isDirty,
    loadDraftFromStored,
    mutateDraft,
    discardDraft: () => {
      if (storedGroup) draftGroup = structuredClone(storedGroup);
    },
    clearDraft: () => {
      draftGroup = null;
      storedGroup = null;
    },
    updateSaveBar,
    saveDraft,
    syncPersistedSlice,
    adoptSavedSlice,
  };
}
