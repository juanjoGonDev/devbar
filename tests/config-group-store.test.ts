// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { createGroupStore } from '../renderer/config/group-store.js';
import type { Group } from '../src/domain-types.js';

interface Deferred {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const pending: Deferred[] = [];
const toasts: Array<{ msg: string; kind?: string }> = [];
let detailRenders = 0;

function group(name: string, extra: Partial<Group> = {}): Group {
  return {
    id: `group-${name}`,
    name,
    icon: '📦',
    path: `/tmp/${name}`,
    mode: 'single',
    order: 0,
    silenceWarnings: false,
    silenceErrors: false,
    env: [],
    commands: [],
    actions: [],
    preScripts: [],
    waitForPipeline: true,
    ...extra,
  };
}

function store() {
  return createGroupStore({
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    renderGroupDetail: () => {
      detailRenders += 1;
    },
  });
}

/** Lets the promises the last action woke actually run. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function saveBar(): { save: HTMLButtonElement; discard: HTMLButtonElement } {
  document.body.innerHTML =
    '<button id="detail-save"></button><button id="detail-discard"></button>';
  return {
    save: document.getElementById('detail-save') as HTMLButtonElement,
    discard: document.getElementById('detail-discard') as HTMLButtonElement,
  };
}

describe('renderer/config/group-store.ts', () => {
  beforeEach(() => {
    pending.length = 0;
    toasts.length = 0;
    detailRenders = 0;
    document.body.innerHTML = '';
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        saveGroup: () =>
          new Promise((resolve, reject) => pending.push({ resolve, reject })),
      },
    });
  });

  describe('selection and drafts', () => {
    it('reports no draft before anything is selected', () => {
      const s = store();
      expect(s.getDraft()).toBeNull();
      expect(s.getSelectedId()).toBeNull();
      expect(s.isDirty()).toBe(false);
    });

    it('clones the selected group into an independent draft', () => {
      const s = store();
      const api = group('api');
      s.setGroups([api]);
      s.setSelectedId('group-api');
      s.loadDraftFromStored('group-api');
      expect(s.getDraft()).toEqual(api);
      expect(s.getDraft()).not.toBe(api);
      expect(s.getGroups()).toEqual([api]);
    });

    it('drops both snapshots for an id that is gone', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.loadDraftFromStored('group-ghost');
      expect(s.getDraft()).toBeNull();
      expect(s.isDirty()).toBe(false);
    });

    it('turns dirty only once a mutation actually changes the draft', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'api';
      });
      expect(s.isDirty()).toBe(false);
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      expect(s.isDirty()).toBe(true);
    });

    it('ignores a mutation while nothing is being edited', () => {
      const s = store();
      let ran = false;
      s.mutateDraft(() => {
        ran = true;
      });
      expect(ran).toBe(false);
    });

    it('restores the last-persisted snapshot on discard', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      s.discardDraft();
      expect(s.getDraft()?.name).toBe('api');
      expect(s.isDirty()).toBe(false);
    });

    it('leaves the draft alone on discard when there is no snapshot', () => {
      const s = store();
      s.discardDraft();
      expect(s.getDraft()).toBeNull();
    });

    it('forgets both snapshots on clear', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.clearDraft();
      expect(s.getDraft()).toBeNull();
      expect(s.isDirty()).toBe(false);
    });
  });

  describe('save bar', () => {
    it('enables both buttons exactly while the pane is dirty', () => {
      const bar = saveBar();
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.updateSaveBar();
      expect(bar.save.disabled).toBe(true);
      expect(bar.discard.disabled).toBe(true);
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      expect(bar.save.disabled).toBe(false);
      expect(bar.discard.disabled).toBe(false);
    });

    it('is a no-op while the pane has not drawn a save bar', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.updateSaveBar();
      expect(document.getElementById('detail-save')).toBeNull();
    });
  });

  describe('saveDraft', () => {
    it('refuses with no draft, without calling main', async () => {
      const s = store();
      await expect(s.saveDraft()).resolves.toBeNull();
      expect(pending).toHaveLength(0);
    });

    it('refuses an empty path and says so', async () => {
      const s = store();
      s.setGroups([group('api', { path: '' })]);
      s.loadDraftFromStored('group-api');
      await expect(s.saveDraft()).resolves.toBeNull();
      expect(toasts).toEqual([
        { msg: 'El path no puede estar vacío', kind: 'error' },
      ]);
      expect(pending).toHaveLength(0);
    });

    it('keeps the old baseline when main rejects the group', async () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      const saved = s.saveDraft();
      pending[0].resolve(null);
      await expect(saved).resolves.toBeNull();
      expect(s.isDirty(), 'a rejected save must leave the pane dirty').toBe(
        true,
      );
    });

    it('adopts the draft as the clean baseline on success', async () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      const saved = s.saveDraft();
      pending[0].resolve({ ...group('api'), name: 'api-2' });
      await saved;
      expect(s.isDirty()).toBe(false);
      expect(s.getGroups()[0]?.name).toBe('api-2');
      expect(detailRenders).toBe(0);
    });

    it('re-renders from the canonical group when main enforced changes', async () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      const saved = s.saveDraft();
      pending[0].resolve({
        ...group('api'),
        name: 'api-enforced',
        _autoStartEnforced: true,
      });
      await saved;
      expect(s.getDraft()?.name).toBe('api-enforced');
      expect(s.isDirty()).toBe(false);
      expect(detailRenders).toBe(1);
    });

    it('still answers for a group that is no longer in the list', async () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.setGroups([]);
      const saved = s.saveDraft();
      pending[0].resolve(group('api'));
      await expect(saved).resolves.toBeTruthy();
      expect(s.getGroups()).toEqual([]);
    });

    it('reports an overtaken save as done without letting it write state', async () => {
      // The save bar only disables itself when the pane is CLEAN, so a second
      // edit-and-save overlaps the first; the older answer must not win.
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'api-2';
      });
      const first = s.saveDraft();
      s.mutateDraft((g) => {
        g.name = 'api-3';
      });
      const second = s.saveDraft();
      pending[1].resolve({ ...group('api'), name: 'api-3' });
      await second;
      pending[0].resolve({ ...group('api'), name: 'api-2' });
      await expect(
        first,
        'the overtaken save still succeeded',
      ).resolves.toBeTruthy();
      await drain();
      expect(s.getGroups()[0]?.name).toBe('api-3');
    });
  });

  describe('slices persisted behind the draft', () => {
    it('copies a reordered slice into both snapshots', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.mutateDraft((g) => {
        g.name = 'edited';
      });
      s.setGroups([
        group('api', {
          name: 'api',
          preScripts: [{ id: 'p1', name: 'seed' }] as Group['preScripts'],
        }),
      ]);
      s.syncPersistedSlice('group-api', 'preScripts');
      expect(s.getDraft()?.preScripts).toHaveLength(1);
      expect(s.getDraft()?.name, 'unrelated edits survive').toBe('edited');
      expect(s.isDirty()).toBe(true);
    });

    it('ignores a slice for a group main no longer reports', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.syncPersistedSlice('group-ghost', 'commands');
      expect(s.getDraft()?.commands).toEqual([]);
    });

    it('ignores a slice for a group that is not the one being edited', () => {
      const s = store();
      s.setGroups([group('api'), group('web')]);
      s.loadDraftFromStored('group-api');
      s.syncPersistedSlice('group-web', 'actions');
      expect(s.getDraft()?.id).toBe('group-api');
      expect(s.isDirty()).toBe(false);
    });

    it('merges each saved sub-item slice in place', () => {
      const s = store();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.setGroups([
        group('api', {
          preScripts: [{ id: 'p1' }] as Group['preScripts'],
          commands: [{ id: 'c1' }] as Group['commands'],
          actions: [{ id: 'a1' }] as Group['actions'],
        }),
      ]);
      s.adoptSavedSlice('group-api', 'preScripts');
      s.adoptSavedSlice('group-api', 'commands');
      s.adoptSavedSlice('group-api', 'actions');
      expect(s.getDraft()?.preScripts).toHaveLength(1);
      expect(s.getDraft()?.commands).toHaveLength(1);
      expect(s.getDraft()?.actions).toHaveLength(1);
      expect(s.isDirty(), 'a merge is not an unsaved edit').toBe(false);
    });

    it('ignores a merge with no draft, a foreign id, or a vanished group', () => {
      const s = store();
      s.adoptSavedSlice('group-api', 'commands');
      expect(s.getDraft()).toBeNull();
      s.setGroups([group('api')]);
      s.loadDraftFromStored('group-api');
      s.adoptSavedSlice('group-web', 'commands');
      expect(s.getDraft()?.commands).toEqual([]);
      s.setGroups([]);
      s.adoptSavedSlice('group-api', 'commands');
      expect(s.getDraft()?.commands).toEqual([]);
    });
  });
});
