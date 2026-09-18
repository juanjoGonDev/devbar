// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupState } from '../src/ipc-contract.js';

/**
 * `renderer/tray/branches.ts` owns the branch combobox in a tray row and the
 * cache behind it: the negative "this folder is not a repository" verdict and
 * its TTL, the generation guard that discards a reply an invalidation has
 * already overtaken, and the bounded retry on an operational git failure.
 *
 * The cache is module state, so every test re-imports the module — which also
 * gives `host.js` and `combobox.js` a fresh instance to match.
 */

type BranchesModule = typeof import('../renderer/tray/branches.js');
type HostModule = typeof import('../renderer/tray/host.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function queue<T>(): {
  fn: () => Promise<T>;
  calls: () => number;
  settle: (value: T) => void;
} {
  const pending: Deferred<T>[] = [];
  let calls = 0;
  return {
    fn: () => {
      calls += 1;
      const next = deferred<T>();
      pending.push(next);
      return next.promise;
    },
    calls: () => calls,
    settle: (value) => {
      const next = pending.shift();
      if (!next) throw new Error('no pending call to settle');
      next.resolve(value);
    },
  };
}

function groupState(path: string | null): GroupState {
  return {
    groupId: 'g1',
    group: {
      id: 'g1',
      name: 'api',
      icon: '📦',
      path: path ?? '',
      mode: 'single',
      order: 0,
      silenceWarnings: false,
      silenceErrors: false,
      env: [],
      commands: [],
      actions: [],
      preScripts: [],
      waitForPipeline: true,
    },
    currentBranch: null,
    color: 'stopped',
    commands: [],
    actions: [],
    lastError: null,
  };
}

describe('renderer/tray/branches.ts', () => {
  let branches: BranchesModule;
  let host: HostModule;
  let listBranches: ReturnType<typeof queue<unknown>>;
  let currentBranch: ReturnType<typeof queue<unknown>>;
  let switchBranch: ReturnType<typeof queue<unknown>>;
  let rerender: ReturnType<typeof vi.fn<() => void>>;
  let toastEl: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="toast"></div>';
    const el = document.getElementById('toast');
    if (!el) throw new Error('no toast element');
    toastEl = el;
    listBranches = queue<unknown>();
    currentBranch = queue<unknown>();
    switchBranch = queue<unknown>();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listBranches: listBranches.fn,
        currentBranch: currentBranch.fn,
        switchBranch: switchBranch.fn,
        setTrayHeight: () => Promise.resolve(),
      },
    });
    vi.resetModules();
    branches = await import('../renderer/tray/branches.js');
    host = await import('../renderer/tray/host.js');
    rerender = vi.fn<() => void>();
    host.setTrayHost({ toastElement: toastEl, rerender });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  function mount(state = groupState('/repo')): HTMLElement {
    const el = branches.buildBranchSelector(state);
    document.body.appendChild(el);
    return el;
  }

  function inputOf(el: HTMLElement): HTMLInputElement {
    const input = el.querySelector('input');
    if (!input) throw new Error('the selector has no input');
    return input;
  }

  function optionLabels(): string[] {
    const lists = document.querySelectorAll<HTMLElement>('.combobox-list');
    const list = lists[lists.length - 1];
    if (!list) throw new Error('no combobox list');
    return Array.from(
      list.querySelectorAll<HTMLElement>('.combobox-item'),
      (item) => item.textContent?.replace('✓', '') ?? '',
    );
  }

  describe('groups that do not use git', () => {
    it('keeps the row slot without showing a dead control', () => {
      const el = mount(groupState(null));
      expect(el.classList.contains('branch-none')).toBe(true);
      expect(el.style.visibility).toBe('hidden');
      expect(el.style.pointerEvents).toBe('none');
      expect(el.getAttribute('aria-hidden')).toBe('true');
    });

    it('asks git nothing about them', () => {
      mount(groupState(null));
      expect(listBranches.calls()).toBe(0);
    });
  });

  describe('loading the branches', () => {
    it('starts on a loading placeholder and queries once', () => {
      const el = mount();
      expect(inputOf(el).placeholder).toBe('Cargando…');
      expect(listBranches.calls()).toBe(1);
    });

    it('fills the combobox with the branches and the checked-out one', async () => {
      const el = mount();
      listBranches.settle({ ok: true, branches: ['main', 'develop'] });
      await flush();
      currentBranch.settle({ ok: true, branch: 'develop' });
      await flush();
      expect(inputOf(el).value).toBe('develop');
      inputOf(el).dispatchEvent(new FocusEvent('focus'));
      expect(optionLabels()).toEqual(['develop', 'main']);
    });

    it('leaves the value empty when git cannot say which branch is out', async () => {
      const el = mount();
      listBranches.settle({ ok: true, branches: ['main'] });
      await flush();
      currentBranch.settle({ ok: false });
      await flush();
      expect(inputOf(el).value).toBe('');
    });

    it('serves the second row from the cache instead of querying again', async () => {
      mount();
      listBranches.settle({ ok: true, branches: ['main'] });
      await flush();
      currentBranch.settle({ ok: true, branch: 'main' });
      await flush();
      const again = mount();
      expect(listBranches.calls()).toBe(1);
      expect(inputOf(again).placeholder).toBe('Rama…');
      expect(inputOf(again).value).toBe('main');
    });

    it('queries again once the cache is cleared', async () => {
      mount();
      listBranches.settle({ ok: true, branches: ['main'] });
      await flush();
      currentBranch.settle({ ok: true, branch: 'main' });
      await flush();
      branches.clearBranchCache(['g1']);
      mount();
      expect(listBranches.calls()).toBe(2);
    });
  });

  describe('a reply that an invalidation has overtaken', () => {
    it('never reaches the combobox', async () => {
      const el = mount();
      branches.clearBranchCache(['g1']);
      listBranches.settle({ ok: true, branches: ['main'] });
      await flush();
      expect(currentBranch.calls()).toBe(0);
      expect(inputOf(el).value).toBe('');
    });

    it('does not cache a stale current-branch reply either', async () => {
      const el = mount();
      listBranches.settle({ ok: true, branches: ['main'] });
      await flush();
      branches.clearBranchCache(['g1']);
      currentBranch.settle({ ok: true, branch: 'main' });
      await flush();
      expect(inputOf(el).value).toBe('');
    });
  });

  describe('a folder that is not a repository', () => {
    it('drops the selector rather than leaving it stuck on "Cargando…"', async () => {
      const el = mount();
      listBranches.settle({ ok: false, isRepo: false });
      await flush();
      expect(el.isConnected).toBe(false);
      expect(
        document.querySelector('.branch-none')?.getAttribute('aria-hidden'),
      ).toBe('true');
    });

    it('remembers the verdict so the next row asks nothing', async () => {
      mount();
      listBranches.settle({ ok: false, isRepo: false });
      await flush();
      const again = mount();
      expect(again.classList.contains('branch-none')).toBe(true);
      expect(listBranches.calls()).toBe(1);
    });

    it('re-verifies after the verdict goes stale, because `git init` fires no event', async () => {
      mount();
      listBranches.settle({ ok: false, isRepo: false });
      await flush();
      await flush(60_000);
      expect(rerender).toHaveBeenCalledTimes(1);
      const again = mount();
      expect(again.classList.contains('branch-none')).toBe(false);
      expect(listBranches.calls()).toBe(2);
    });

    it('lets a newer query cycle own the verdict instead of expiring under it', async () => {
      mount();
      listBranches.settle({ ok: false, isRepo: false });
      await flush();
      branches.clearBranchCache(['g1']);
      await flush(60_000);
      expect(rerender).not.toHaveBeenCalled();
    });

    it('honours a fresh verdict when a row is rebuilt before the TTL', async () => {
      mount();
      listBranches.settle({ ok: false, isRepo: false });
      await flush();
      await flush(30_000);
      const again = mount();
      expect(again.classList.contains('branch-none')).toBe(true);
    });
  });

  describe('git being unavailable', () => {
    it('says so and promises a retry', async () => {
      mount();
      listBranches.settle({ ok: false, error: 'git not found' });
      await flush();
      expect(toastEl.textContent).toBe(
        'api: no se pudieron listar las ramas — reintento en 3 s',
      );
      expect(toastEl.className).toBe('toast error');
    });

    it('retries once, after the pause', async () => {
      mount();
      listBranches.settle({ ok: false, error: 'git not found' });
      await flush();
      expect(listBranches.calls()).toBe(1);
      await flush(3000);
      expect(listBranches.calls()).toBe(2);
    });

    it('gives up rather than toast-looping on a persistently broken git', async () => {
      mount();
      listBranches.settle({ ok: false, error: 'git not found' });
      await flush();
      await flush(3000);
      listBranches.settle({ ok: false, error: 'git not found' });
      await flush();
      expect(toastEl.textContent).toBe(
        'api: no se pudieron listar las ramas — reintento agotado',
      );
      await flush(10_000);
      expect(listBranches.calls()).toBe(2);
    });

    it('caches nothing, because the verdict says nothing about the folder', async () => {
      mount();
      listBranches.settle({ ok: false, error: 'git not found' });
      await flush();
      mount();
      // The first row's own retry plus this fresh row's query.
      expect(listBranches.calls()).toBe(2);
    });

    it('abandons a scheduled retry the cache invalidated', async () => {
      mount();
      listBranches.settle({ ok: false, error: 'git not found' });
      await flush();
      branches.clearBranchCache(['g1']);
      await flush(3000);
      expect(listBranches.calls()).toBe(1);
    });
  });

  describe('switching branch', () => {
    async function ready(): Promise<HTMLElement> {
      const el = mount();
      listBranches.settle({ ok: true, branches: ['main', 'develop'] });
      await flush();
      currentBranch.settle({ ok: true, branch: 'main' });
      await flush();
      return el;
    }

    function pick(el: HTMLElement, label: string): void {
      inputOf(el).dispatchEvent(new FocusEvent('focus'));
      const lists = document.querySelectorAll<HTMLElement>('.combobox-list');
      const list = lists[lists.length - 1];
      const option = Array.from(
        list?.querySelectorAll<HTMLElement>('.combobox-item') ?? [],
      ).find((item) => item.dataset.value === label);
      if (!option) throw new Error(`no option ${label}`);
      option.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
    }

    it('asks the main process to check the branch out', async () => {
      const el = await ready();
      pick(el, 'develop');
      await flush();
      expect(switchBranch.calls()).toBe(1);
    });

    it('confirms the switch and reloads the branches', async () => {
      const el = await ready();
      pick(el, 'develop');
      await flush();
      switchBranch.settle({ ok: true });
      await flush();
      expect(toastEl.textContent).toBe('api → develop');
      expect(toastEl.className).toBe('toast ok');
      expect(listBranches.calls()).toBe(2);
    });

    it('reports only the first line of a failure, then reloads anyway', async () => {
      const el = await ready();
      pick(el, 'develop');
      await flush();
      switchBranch.settle({
        ok: false,
        error: 'error: cannot switch\nlocal changes would be overwritten',
      });
      await flush();
      expect(toastEl.textContent).toBe('api: error: cannot switch');
      expect(toastEl.className).toBe('toast error');
      expect(listBranches.calls()).toBe(2);
    });

    it('forgets the cached branches so the reload really re-reads them', async () => {
      const el = await ready();
      pick(el, 'develop');
      await flush();
      switchBranch.settle({ ok: true });
      await flush();
      listBranches.settle({ ok: true, branches: ['main', 'develop'] });
      await flush();
      currentBranch.settle({ ok: true, branch: 'develop' });
      await flush();
      expect(inputOf(el).value).toBe('develop');
    });
  });
});
