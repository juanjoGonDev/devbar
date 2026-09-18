// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type {
  CommandRuntimeState,
  GroupState,
  PipelineState,
  UpdateStatus,
} from '../src/ipc-contract.js';

function groupState(
  name: string,
  overrides: Partial<GroupState> = {},
): GroupState {
  return {
    groupId: `group-${name}`,
    group: {
      id: `group-${name}`,
      name,
      icon: '📦',
      path: '',
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
    ...overrides,
  };
}

function commandState(
  overrides: Partial<CommandRuntimeState> = {},
): CommandRuntimeState {
  return {
    commandId: 'c1',
    processId: 'p1',
    status: 'running',
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: null,
    color: 'running',
    muteWarn: false,
    muteErr: false,
    ...overrides,
  };
}

function pipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    status: 'idle',
    currentStep: null,
    totalSteps: 0,
    lastError: null,
    lastRunId: null,
    startedAt: null,
    ...overrides,
  };
}

function updateStatus(version: string | null): UpdateStatus {
  return {
    available: version
      ? {
          version,
          url: `https://example.invalid/${version}`,
          dmgUrl: null,
          zipUrl: null,
          setupUrl: null,
          appImageUrl: null,
          debUrl: null,
        }
      : null,
    staged: null,
    lastCheckAt: null,
    currentVersion: '0.0.0',
  };
}

function renderedGroups(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#groups .group-name'),
    (el) => el.textContent ?? '',
  );
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Lets the one-frame resize debounce actually run. */
async function nextFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe('renderer/tray.ts', () => {
  let tray: RendererWindow | null = null;

  afterEach(() => {
    tray?.close();
    tray = null;
    vi.useRealTimers();
  });

  async function openTray(
    values: Readonly<Record<string, unknown>> = {},
  ): Promise<RendererWindow> {
    tray = await loadRendererWindow({
      html: 'tray.html',
      load: () => import('../renderer/tray.js'),
      values: { platform: 'macos', ...values },
    });
    return tray;
  }

  describe('initial group states', () => {
    it('renders the read when nothing newer has landed', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [groupState('api')]);
      expect(renderedGroups()).toEqual(['api']);
    });

    it('keeps a pushed update that landed before the read resolved', async () => {
      // The ordering the window actually hits on a slow boot: main pushes
      // `groups:update` while the initial read is still in flight. Applying
      // the older snapshot afterwards leaves the tray showing groups the main
      // process no longer has, until some unrelated event pushes again.
      const win = await openTray();
      await win.push('onUpdate', [groupState('api'), groupState('web')]);
      await win.settle('getGroupStates', [groupState('viejo')]);
      expect(renderedGroups()).toEqual(['api', 'web']);
    });

    it('invites the user to configure a group when there are none', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', []);
      expect(
        document.querySelector('#groups .empty-state')?.textContent,
      ).toContain('No hay grupos configurados');
    });

    it('sizes the popover to its content once the list is up', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [groupState('api')]);
      await nextFrame();
      expect(win.callCount('setTrayHeight')).toBeGreaterThan(0);
    });
  });

  describe('initial update status', () => {
    it('marks the version chip from the read when nothing newer has landed', async () => {
      const win = await openTray();
      await win.settle('getUpdateStatus', updateStatus('9.9.9'));
      const chip = document.getElementById('app-version');
      expect(chip?.classList.contains('has-update')).toBe(true);
    });

    it('keeps a pushed status that landed before the read resolved', async () => {
      // The check that found the update runs at boot too, so its push races
      // the read the window issues on the same tick. Losing that race drops
      // the dot from the chip until the next check, hours later.
      const win = await openTray();
      await win.push('onUpdateStatus', updateStatus('9.9.9'));
      await win.settle('getUpdateStatus', updateStatus(null));
      const chip = document.getElementById('app-version');
      expect(chip?.classList.contains('has-update')).toBe(true);
    });

    it('says which version is waiting', async () => {
      const win = await openTray();
      await win.push('onUpdateStatus', updateStatus('9.9.9'));
      expect(byId('app-version').title).toBe(
        'v9.9.9 disponible — ver changelog',
      );
    });

    it('clears the mark when the update goes away', async () => {
      const win = await openTray();
      await win.push('onUpdateStatus', updateStatus('9.9.9'));
      await win.push('onUpdateStatus', updateStatus(null));
      const chip = byId('app-version');
      expect(chip.classList.contains('has-update')).toBe(false);
      expect(chip.title).toBe('Ver changelog');
    });

    it('leaves the chip alone when the status read fails', async () => {
      const win = await openTray();
      await win.fail('getUpdateStatus', new Error('sin red'));
      expect(byId('app-version').classList.contains('has-update')).toBe(false);
    });
  });

  describe('the version chip', () => {
    it('shows the running version', async () => {
      const win = await openTray();
      await win.settle('getAppVersion', '1.2.3');
      expect(byId('app-version').textContent).toBe('v1.2.3');
    });

    it('opens the changelog in config, which has room for it', async () => {
      const openConfigChangelog = vi.fn();
      const win = await openTray({ openConfigChangelog });
      await win.settle('getAppVersion', '1.2.3');
      click(byId('app-version'));
      expect(openConfigChangelog).toHaveBeenCalledTimes(1);
    });

    it('stays empty when the version cannot be read', async () => {
      const win = await openTray();
      await win.fail('getAppVersion', new Error('nope'));
      expect(byId('app-version').textContent).toBe('');
    });
  });

  describe('the header buttons', () => {
    it('opens every log from the telemetry button', async () => {
      const openLogs = vi.fn();
      await openTray({ openLogs });
      click(byId('open-telemetry'));
      expect(openLogs).toHaveBeenCalledWith({ scope: 'all' });
    });

    it('opens the configuration window', async () => {
      const openConfig = vi.fn();
      await openTray({ openConfig });
      click(byId('open-config'));
      expect(openConfig).toHaveBeenCalledTimes(1);
    });

    it('quits the app', async () => {
      const quit = vi.fn();
      await openTray({ quit });
      click(byId('quit-app'));
      expect(quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('the alerts summary', () => {
    function noisy(warnCount: number, errorCount: number): GroupState {
      return groupState('api', {
        commands: [commandState({ warnCount, errorCount })],
      });
    }

    it('adds up the warnings and errors across every group', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [noisy(2, 1), noisy(3, 0)]);
      expect(byId('alerts-summary').textContent).toBe('⚠ 5✕ 1');
    });

    it('stays hidden when nothing is wrong', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [noisy(0, 0)]);
      expect(byId('alerts-summary').style.display).toBe('none');
    });

    it('counts only what is actually running', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [
        groupState('api', {
          commands: [commandState({ status: 'stopped', warnCount: 7 })],
        }),
      ]);
      expect(byId('alerts-summary').style.display).toBe('none');
    });

    it('skips the levels a group has muted', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [
        groupState('api', {
          commands: [
            commandState({ warnCount: 4, errorCount: 2, muteWarn: true }),
          ],
        }),
      ]);
      expect(byId('alerts-summary').textContent).toBe('✕ 2');
    });

    it('opens the telemetry view already filtered to that level', async () => {
      const openLogs = vi.fn();
      const win = await openTray({ openLogs });
      await win.settle('getGroupStates', [noisy(2, 1)]);
      click(byId('alerts-summary').children[0] ?? byId('alerts-summary'));
      expect(openLogs).toHaveBeenCalledWith({ scope: 'all', level: 'warn' });
    });
  });

  describe('the pipeline trigger', () => {
    function host(): HTMLElement {
      return byId('pipeline-trigger');
    }

    it('stays out of the header when no pipeline is configured', async () => {
      const win = await openTray();
      await win.push('onPipelineUpdate', pipelineState());
      expect(host().children).toHaveLength(0);
    });

    it('offers to run a configured pipeline', async () => {
      const win = await openTray();
      await win.push('onPipelineUpdate', pipelineState({ totalSteps: 2 }));
      const trigger = host().querySelector('.prescripts-trigger');
      expect(trigger?.textContent).toBe('▶▶');
      expect((trigger as HTMLElement).title).toBe('Ejecutar pipeline');
    });

    it('runs it when pressed', async () => {
      const win = await openTray();
      await win.push('onPipelineUpdate', pipelineState({ totalSteps: 2 }));
      click(host().querySelector('.prescripts-trigger') ?? host());
      expect(win.callCount('runPreScripts')).toBe(1);
    });

    it('refuses to start a second run and says why', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'running', totalSteps: 2, currentStep: 1 }),
      );
      click(host().querySelector('.prescripts-trigger') ?? host());
      expect(win.callCount('runPreScripts')).toBe(0);
      expect(byId('toast').textContent).toBe('Ya hay un pipeline corriendo');
    });

    it('reports a race the main process lost', async () => {
      const win = await openTray();
      await win.push('onPipelineUpdate', pipelineState({ totalSteps: 1 }));
      click(host().querySelector('.prescripts-trigger') ?? host());
      await win.settle('runPreScripts', {
        ok: false,
        error: 'already_running',
      });
      expect(byId('toast').textContent).toBe('Ya hay un pipeline corriendo');
    });

    it('shows the step and the elapsed time while it runs', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'running',
          currentStep: 2,
          totalSteps: 3,
          startedAt: Date.now() - 5000,
        }),
      );
      expect(host().querySelector('.prestep-step')?.textContent).toBe('2/3');
      expect(host().querySelector('.prestep-elapsed')).not.toBeNull();
      expect(
        (host().querySelector('.prestep-badge') as HTMLElement).title,
      ).toBe('Pipeline: paso 2/3');
    });

    it('drops the step counter for a single-step pipeline', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'running', currentStep: 1, totalSteps: 1 }),
      );
      expect(host().querySelector('.prestep-step')).toBeNull();
    });

    it('offers to cancel a run in flight', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'running', currentStep: 1, totalSteps: 2 }),
      );
      click(host().querySelector('.prestep-cancel') ?? host());
      expect(win.callCount('cancelPreScripts')).toBe(1);
    });

    it('ticks a finished run', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'done', totalSteps: 2 }),
      );
      expect(host().querySelector('.prestep-badge.ok')?.textContent).toBe('✓');
    });

    it('shows the failure and what it said', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'error',
          totalSteps: 2,
          lastError: 'migración falló',
        }),
      );
      const badge = host().querySelector('.prestep-badge.err') as HTMLElement;
      expect(badge.textContent).toBe('✕');
      expect(badge.title).toBe('migración falló');
    });

    it('keeps a finished run reviewable through its log', async () => {
      const openLogs = vi.fn();
      const win = await openTray({ openLogs });
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'done', totalSteps: 1, lastRunId: 'run-7' }),
      );
      click(host().querySelector('.prestep-logs-btn') ?? host());
      expect(openLogs).toHaveBeenCalledWith('pre-pipeline:run-7');
    });

    it('renders the initial read when no push has landed', async () => {
      const win = await openTray();
      await win.settle(
        'getPipelineState',
        pipelineState({ status: 'done', totalSteps: 1 }),
      );
      expect(host().querySelector('.prestep-badge.ok')).not.toBeNull();
    });

    it('keeps a pushed state that landed before that read resolved', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'error', totalSteps: 1 }),
      );
      await win.settle(
        'getPipelineState',
        pipelineState({ status: 'done', totalSteps: 1 }),
      );
      expect(host().querySelector('.prestep-badge.err')).not.toBeNull();
    });
  });

  describe('toasts from the main process', () => {
    it('shows what main asked it to show', async () => {
      const win = await openTray();
      await win.push('onToast', { kind: 'error', message: 'algo falló' });
      expect(byId('toast').textContent).toBe('algo falló');
      expect(byId('toast').className).toBe('toast error');
    });
  });

  describe('branch caches', () => {
    it('re-reads the branches when the repository changes on disk', async () => {
      const win = await openTray();
      await win.settle('getGroupStates', [
        groupState('api', {
          group: { ...groupState('api').group, path: '/repo' },
        }),
      ]);
      const before = win.callCount('listBranches');
      await win.push('onBranchesChanged', { repoPath: '/repo' });
      expect(win.callCount('listBranches')).toBe(before + 1);
    });

    it('ignores a repository event before any group has arrived', async () => {
      const win = await openTray();
      await win.push('onBranchesChanged', { repoPath: '/repo' });
      expect(win.callCount('listBranches')).toBe(0);
    });

    it('re-reads them when a group is pointed at a different folder', async () => {
      const win = await openTray();
      const at = (path: string): GroupState =>
        groupState('api', { group: { ...groupState('api').group, path } });
      await win.push('onUpdate', [at('/repo')]);
      const before = win.callCount('listBranches');
      await win.push('onUpdate', [at('/otro-repo')]);
      expect(win.callCount('listBranches')).toBe(before + 1);
    });

    it('leaves them alone when nothing about the paths moved', async () => {
      const win = await openTray();
      const at = (path: string): GroupState =>
        groupState('api', { group: { ...groupState('api').group, path } });
      await win.push('onUpdate', [at('/repo')]);
      await win.settle('listBranches', { ok: true, branches: ['main'] });
      await win.settle('currentBranch', { ok: true, branch: 'main' });
      const before = win.callCount('listBranches');
      await win.push('onUpdate', [at('/repo')]);
      expect(win.callCount('listBranches')).toBe(before);
    });
  });

  describe('a render that arrives while a dropdown is open', () => {
    async function openDropdown(
      win: RendererWindow,
    ): Promise<HTMLInputElement> {
      await win.push('onUpdate', [
        groupState('api', {
          group: { ...groupState('api').group, path: '/repo' },
        }),
      ]);
      const input = document.querySelector<HTMLInputElement>('.combobox-input');
      if (!input) throw new Error('no branch selector');
      input.dispatchEvent(new FocusEvent('focus'));
      return input;
    }

    it('waits rather than tearing the live combobox out of the row', async () => {
      const win = await openTray();
      const input = await openDropdown(win);
      await win.push('onUpdate', [groupState('web')]);
      expect(renderedGroups()).toEqual(['api']);
      expect(input.isConnected).toBe(true);
    });

    it('replays it as soon as the dropdown closes', async () => {
      const win = await openTray();
      const input = await openDropdown(win);
      await win.push('onUpdate', [groupState('web')]);
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await win.push('onToast', { kind: 'ok', message: 'listo' });
      expect(renderedGroups()).toEqual(['web']);
    });

    it('leaves the popover height to the dropdown while it is open', async () => {
      const win = await openTray();
      await openDropdown(win);
      // A previous window's resize frame can still be queued, and it reaches
      // this window's `api` — let everything in flight land before measuring.
      await nextFrame();
      const before = win.callCount('setTrayHeight');
      await win.push('onUpdate', [groupState('web')]);
      await nextFrame();
      expect(win.callCount('setTrayHeight')).toBe(before);
    });
  });

  describe('the uptime ticker', () => {
    it('refreshes every running group’s elapsed time once a second', async () => {
      // Only setInterval/Date are faked: the harness drains its promises with
      // setTimeout, which has to keep working.
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'Date'],
        now: 100_000,
      });
      const win = await openTray();
      await win.settle('getGroupStates', [
        groupState('api', {
          commands: [commandState({ status: 'running', startedAt: 40_000 })],
        }),
      ]);
      const uptime = document.querySelector<HTMLElement>('#groups .uptime');
      expect(uptime?.textContent).toBe('1m 0s');
      // The faked clock moves with the timers, so a minute of ticks is a
      // minute of uptime.
      vi.advanceTimersByTime(60_000);
      expect(uptime?.textContent).toBe('2m 0s');
    });

    it('leaves alone an uptime label with no start time', async () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'Date'],
        now: 100_000,
      });
      const win = await openTray();
      await win.settle('getGroupStates', [groupState('api')]);
      const stray = document.createElement('span');
      stray.className = 'uptime';
      stray.dataset.startedAt = '';
      stray.textContent = 'sin datos';
      byId('groups').appendChild(stray);
      vi.advanceTimersByTime(1000);
      expect(stray.textContent).toBe('sin datos');
    });
  });
});
