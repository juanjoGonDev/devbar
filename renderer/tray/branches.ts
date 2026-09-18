/**
 * The per-group branch selector in a tray row, and the cache behind it.
 *
 * Split out of `renderer/tray.ts`: the cache, its generation guard and the
 * negative-verdict TTL are a self-contained piece of state, and the combobox
 * they feed is the only part of a row that talks to git.
 */
import {
  createCombobox,
  type ComboboxControl,
  type ComboboxOption,
} from '../combobox.js';
import { rerenderTray, showToast } from './host.js';
import type { GroupState } from '../../src/ipc-contract.js';

// Branch cache: groupId → { branches: string[], current: string|null, isRepo? }
// isRepo === false is a NEGATIVE cache entry: the group's path is not a git
// repository, so the selector stays hidden without re-querying on every
// re-render.
interface BranchCacheEntry {
  branches: string[];
  isRepo?: boolean | undefined;
  current: string | null;
  /** When this entry was written (used to re-verify stale negatives). */
  checkedAt?: number | undefined;
}
const branchCache = new Map<string, BranchCacheEntry>();
// A "this folder is not a repository" verdict is not permanent: a `git init`
// in the folder fires NO watcher event (the watcher only follows repositories
// that already are), so a forever-negative verdict would hide the branch
// selector even after the folder became a repository. Re-verify negatives
// after this window; positives stay cached until a real event clears them.
const NEGATIVE_BRANCH_VERDICT_TTL_MS = 60_000;
// Monotonic token per group. Every event that can make branch data
// stale (path change, onBranchesChanged) bumps it, and an in-flight
// listBranches result re-checks it before applying — otherwise a slow
// response from before the clear repopulates the cache and the combo
// with stale branches.
const branchGeneration = new Map<string, number>();
function bumpBranchGeneration(groupIds: Iterable<string>): void {
  for (const id of groupIds) {
    branchGeneration.set(id, (branchGeneration.get(id) ?? 0) + 1);
  }
}
export function clearBranchCache(groupIds: Iterable<string>): void {
  branchCache.clear();
  // Include groups that are loading but were never bumped: they have
  // no key yet, and their in-flight response must be discarded too.
  bumpBranchGeneration([...branchGeneration.keys(), ...groupIds]);
}

// ─────────────────────── Branch selector (combobox) ──────────────────

/**
 * Invisible stand-in for the branch selector on groups that do not use git
 * (no path, or a path that is not a repository). Keeps the row's right-edge
 * slot so the layout does not shift, without showing a dead control.
 *
 * Must stay in the layout: `hidden` (display:none) would collapse the
 * 110px flex slot and pull the pre-scripts controls toward the edge on
 * non-git rows. `visibility:hidden` keeps the box; pointer-events makes it
 * inert so it cannot steal focus or clicks.
 */
function branchNone(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'branch-select branch-none';
  el.setAttribute('aria-hidden', 'true');
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';
  return el;
}

export function buildBranchSelector(gs: GroupState): HTMLElement {
  const groupId = gs.groupId;
  const group = gs.group || {};

  // Groups without a path don't use git: no selector at all.
  if (!group.path) return branchNone();

  let cached = branchCache.get(groupId);
  // A cached "not a repository" verdict is only honored while fresh: after
  // the TTL it is dropped so the async path below re-verifies (a folder can
  // become a repo with NO watcher event — `git init` is invisible to a
  // watcher that only follows existing repositories).
  if (
    cached?.isRepo === false &&
    cached.checkedAt != null &&
    Date.now() - cached.checkedAt >= NEGATIVE_BRANCH_VERDICT_TTL_MS
  ) {
    branchCache.delete(groupId);
    cached = undefined;
  }
  // Known non-git project: nothing to show and nothing to query.
  if (cached && cached.isRepo === false) return branchNone();
  const initOptions = cached ? branchDataToOptions(cached) : [];
  const initValue = cached ? cached.current || null : null;

  const combo = createCombobox({
    value: initValue,
    options: initOptions,
    placeholder: cached ? 'Rama…' : 'Cargando…',
    onSelect: async (branch) => {
      if (!branch) return;
      combo.setLoading(true);
      const res = await window.api.switchBranch(groupId, branch);
      combo.setLoading(false);
      branchCache.delete(groupId);
      if (!res.ok) {
        showToast(
          `${group.name}: ${(res.error || '').split('\n')[0]}`,
          'error',
        );
        // Reload branches to restore correct state
        loadBranchesIntoCombo(groupId, combo, group.name);
      } else {
        showToast(`${group.name} → ${branch}`, 'ok');
        // Update cache and combo without full re-render
        loadBranchesIntoCombo(groupId, combo, group.name);
      }
    },
  });

  // If no cache, load branches asynchronously
  if (!cached) {
    combo.setLoading(true);
    loadBranchesIntoCombo(groupId, combo, group.name);
  }

  return combo;
}

function branchDataToOptions(data: BranchCacheEntry): ComboboxOption[] {
  return (data.branches || []).map((b) => ({
    value: b,
    label: b,
    current: data.current === b,
  }));
}

/** Delay before retrying an operational branch-query failure. */
const BRANCH_RETRY_DELAY_MS = 3000;

function loadBranchesIntoCombo(
  groupId: string,
  combo: ComboboxControl,
  label?: string,
  retriesLeft = 1,
): void {
  const gen = branchGeneration.get(groupId) ?? 0;
  const stillValid = () => (branchGeneration.get(groupId) ?? 0) === gen;
  window.api.listBranches(groupId).then((res) => {
    combo.setLoading(false);
    // A stale-branch-cache event bumped the generation while this
    // query was in flight — its result is outdated, discard it.
    if (!stillValid()) return;
    if (!res.ok) {
      if (res.isRepo === false) {
        // Not a git project: remember it (negative cache) and drop the
        // selector entirely — a stuck "Cargando…" box is a dead control.
        // checkedAt gives the verdict a TTL: buildBranchSelector re-verifies
        // after NEGATIVE_BRANCH_VERDICT_TTL_MS, because a `git init` in the
        // folder produces no watcher event.
        const checkedAt = Date.now();
        branchCache.set(groupId, {
          branches: [],
          current: null,
          isRepo: false,
          checkedAt,
        });
        // `git init` emits no watcher event, so this verdict can outlive
        // its folder's reality while the group stays idle — nothing else
        // would trigger a render. When the TTL expires, drop THIS entry
        // and re-render so buildBranchSelector re-verifies async. The
        // generation guard skips refreshes a newer query cycle has
        // superseded, and the checkedAt check only removes the exact
        // entry stored here (a later re-verification owns its own timer).
        setTimeout(() => {
          if ((branchGeneration.get(groupId) ?? 0) !== gen) return;
          const entry = branchCache.get(groupId);
          if (entry?.isRepo !== false || entry.checkedAt !== checkedAt) return;
          branchCache.delete(groupId);
          rerenderTray();
        }, NEGATIVE_BRANCH_VERDICT_TTL_MS);
        combo.replaceWith(branchNone());
      } else {
        // Operational failure (git unavailable, query timed out): the
        // verdict says nothing about the folder, so it is NOT cached —
        // and the selector must not sit on "Cargando…" without a way out:
        // notify and retry once after a pause (bounded, so a persistently
        // broken git does not toast-loop). Only announce a retry when
        // one is actually scheduled below.
        showToast(
          retriesLeft > 0
            ? `${label ?? 'Ramas'}: no se pudieron listar las ramas — reintento en ${BRANCH_RETRY_DELAY_MS / 1000} s`
            : `${label ?? 'Ramas'}: no se pudieron listar las ramas — reintento agotado`,
          'error',
        );
        if (retriesLeft > 0) {
          setTimeout(() => {
            if (stillValid())
              loadBranchesIntoCombo(groupId, combo, label, retriesLeft - 1);
          }, BRANCH_RETRY_DELAY_MS);
        }
      }
      return;
    }
    window.api.currentBranch(groupId).then((cur) => {
      if (!stillValid()) return;
      const data: BranchCacheEntry = {
        branches: res.branches ?? [],
        current: cur.ok ? (cur.branch ?? null) : null,
        isRepo: true,
      };
      branchCache.set(groupId, data);
      combo.setOptions(branchDataToOptions(data));
      combo.setValue(data.current || null);
    });
  });
}
