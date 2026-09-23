// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionRuntimeState,
  CommandRuntimeState,
  GroupState,
} from '../src/ipc-contract.js';
import type { Action, Command } from '../src/domain-types.js';

/**
 * `renderer/tray/group-row.ts` builds one group's row: the collapsed line,
 * and — once expanded — a sub-row per command and a chip per action. The
 * expanded/collapsed state is module state, so each test re-imports.
 */

type GroupRowModule = typeof import('../renderer/tray/group-row.js');
type HostModule = typeof import('../renderer/tray/host.js');

function command(overrides: Partial<Command> = {}): Command {
  return {
    id: 'c1',
    name: 'dev server',
    command: 'pnpm dev',
    ...overrides,
  } as Command;
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'migrar',
    command: 'pnpm migrate',
    ...overrides,
  } as Action;
}

function commandState(
  overrides: Partial<CommandRuntimeState> = {},
): CommandRuntimeState {
  return {
    commandId: 'c1',
    processId: 'g1:c1',
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: null,
    color: 'stopped',
    muteWarn: false,
    muteErr: false,
    ...overrides,
  };
}

function actionState(
  overrides: Partial<ActionRuntimeState> = {},
): ActionRuntimeState {
  return {
    actionId: 'a1',
    processId: 'g1:a1',
    status: 'idle',
    lastExitCode: null,
    lastFinishedAt: null,
    startedAt: null,
    ...overrides,
  };
}

function groupState(overrides: Partial<GroupState> = {}): GroupState {
  const base: GroupState = {
    groupId: 'g1',
    group: {
      id: 'g1',
      name: 'api',
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
  };
  return { ...base, ...overrides };
}

describe('renderer/tray/group-row.ts', () => {
  let groupRow: GroupRowModule;
  let host: HostModule;
  let rerender: ReturnType<typeof vi.fn<() => void>>;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="toast"></div>';
    api = {
      openLogs: vi.fn(() => Promise.resolve()),
      setCommandAutoStart: vi.fn(() => Promise.resolve()),
      startProcess: vi.fn(() => Promise.resolve()),
      stopProcess: vi.fn(() => Promise.resolve()),
      runAction: vi.fn(() => Promise.resolve()),
      listBranches: vi.fn(() => new Promise(() => undefined)),
      currentBranch: vi.fn(() => new Promise(() => undefined)),
      setTrayHeight: vi.fn(() => Promise.resolve()),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api,
    });
    vi.resetModules();
    groupRow = await import('../renderer/tray/group-row.js');
    host = await import('../renderer/tray/host.js');
    rerender = vi.fn<() => void>();
    const toastEl = document.getElementById('toast');
    if (!toastEl) throw new Error('no toast element');
    host.setTrayHost({ toastElement: toastEl, rerender });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mount(state = groupState()): HTMLElement {
    const el = groupRow.renderGroupRow(state);
    document.body.appendChild(el);
    return el;
  }

  function q(root: ParentNode, selector: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    return el;
  }

  function click(el: Element): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  describe('the collapsed row', () => {
    it('shows the group icon and name', () => {
      const el = mount();
      expect(q(el, '.group-icon').textContent).toBe('📦');
      expect(q(el, '.group-name').textContent).toBe('api');
    });

    it('falls back for a group with no icon and no name', () => {
      const el = mount(
        groupState({
          group: { ...groupState().group, icon: '', name: '' },
        }),
      );
      expect(q(el, '.group-icon').textContent).toBe('📦');
      expect(q(el, '.group-name').textContent).toBe('(sin nombre)');
    });

    it('carries the traffic-light colour on the row and the dot', () => {
      const el = mount(groupState({ color: 'running' }));
      expect(q(el, '.group-row').className).toContain('running');
      expect(q(el, '.dot').className).toContain('running');
    });

    it('shows the uptime of the longest-running command', () => {
      vi.setSystemTime(new Date(100_000));
      const el = mount(
        groupState({
          commands: [
            commandState({ status: 'running', startedAt: 40_000 }),
            commandState({ status: 'running', startedAt: 10_000 }),
          ],
        }),
      );
      expect(q(el, '.group-uptime').dataset.startedAt).toBe('10000');
    });

    it('hides the uptime while nothing is running', () => {
      const el = mount(
        groupState({ commands: [commandState({ status: 'stopped' })] }),
      );
      expect(el.querySelector('.group-uptime')).toBeNull();
    });

    it('flags the last error where the pointer can read it', () => {
      const el = mount(groupState({ lastError: 'exited with 1' }));
      expect(q(el, '.group-error-badge').title).toBe('exited with 1');
    });

    it('opens the whole group’s logs without toggling the row', () => {
      const el = mount();
      click(q(el, '.group-logs-btn'));
      expect(api.openLogs).toHaveBeenCalledWith({
        scope: 'group',
        groupId: 'g1',
      });
      expect(rerender).not.toHaveBeenCalled();
    });

    it('names the group in that button’s tooltip', () => {
      expect(q(mount(), '.group-logs-btn').title).toBe(
        'Ver todos los logs de api',
      );
    });
  });

  describe('expanding', () => {
    it('opens the group when the row is clicked', () => {
      const el = mount();
      click(q(el, '.group-row'));
      expect(rerender).toHaveBeenCalledTimes(1);
      expect(q(mount(), '.group-expanded')).toBeDefined();
    });

    it('opens it from the chevron too', () => {
      const el = mount();
      click(q(el, '.caret-btn'));
      expect(q(mount(), '.caret-btn').textContent).toBe('▾');
    });

    it('closes it again on a second click', () => {
      click(q(mount(), '.caret-btn'));
      click(q(mount(), '.caret-btn'));
      expect(mount().querySelector('.group-expanded')).toBeNull();
    });

    it('leaves the row alone when the click landed on a control', () => {
      const el = mount();
      click(q(el, '.group-logs-btn'));
      expect(mount().querySelector('.group-expanded')).toBeNull();
    });

    it('ignores the synthetic click a closing dropdown leaves behind', async () => {
      const combobox = await import('../renderer/combobox.js');
      const el = mount(
        groupState({ group: { ...groupState().group, path: '/repo' } }),
      );
      const input = q(el, '.combobox-input');
      input.dispatchEvent(new FocusEvent('focus'));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      expect(combobox.lastComboboxInteractionAt()).toBeGreaterThan(0);
      click(q(el, '.group-row'));
      expect(rerender).not.toHaveBeenCalled();
    });

    it('accepts the click once that window has passed', async () => {
      await import('../renderer/combobox.js');
      const el = mount(
        groupState({ group: { ...groupState().group, path: '/repo' } }),
      );
      const input = q(el, '.combobox-input');
      input.dispatchEvent(new FocusEvent('focus'));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      vi.advanceTimersByTime(300);
      click(q(el, '.group-row'));
      expect(rerender).toHaveBeenCalledTimes(1);
    });
  });

  describe('command sub-rows', () => {
    function expandedWith(state: GroupState): HTMLElement {
      mount(state);
      click(q(mount(state), '.caret-btn'));
      return mount(state);
    }

    function withCommand(
      cs: Partial<CommandRuntimeState> = {},
      cmd: Partial<Command> = {},
    ): GroupState {
      return groupState({
        group: { ...groupState().group, commands: [command(cmd)] },
        commands: [commandState(cs)],
      });
    }

    it('lists the command by name', () => {
      const el = expandedWith(withCommand());
      expect(q(el, '.cmd-sub-name').textContent).toBe('dev server');
    });

    it('shows the command icon when it has one', () => {
      const el = expandedWith(withCommand({}, { icon: '🚀' }));
      expect(q(el, '.cmd-sub-icon').textContent).toBe('🚀');
    });

    it('skips a runtime state whose command is gone from the config', () => {
      const el = expandedWith(
        groupState({
          group: { ...groupState().group, commands: [] },
          commands: [commandState()],
        }),
      );
      expect(el.querySelector('.cmd-sub-row')).toBeNull();
    });

    it('starts a stopped command', () => {
      const el = expandedWith(withCommand({ status: 'stopped' }));
      const toggle = q(el, '.start-btn');
      expect(toggle.textContent).toBe('▶');
      click(toggle);
      expect(api.startProcess).toHaveBeenCalledWith('g1:c1');
    });

    it('stops a running one', () => {
      const el = expandedWith(withCommand({ status: 'running' }));
      const toggle = q(el, '.stop-btn');
      expect(toggle.textContent).toBe('■');
      click(toggle);
      expect(api.stopProcess).toHaveBeenCalledWith('g1:c1');
    });

    it('opens that command’s logs', () => {
      const el = expandedWith(withCommand());
      click(q(el, '.cmd-sub-btn'));
      expect(api.openLogs).toHaveBeenCalledWith('g1:c1');
    });

    it('toggles auto-start and shows the current setting', () => {
      const el = expandedWith(withCommand({}, { autoStart: true }));
      const button = q(el, '.autostart-btn');
      expect(button.className).toContain('autostart-on');
      click(button);
      expect(api.setCommandAutoStart).toHaveBeenCalledWith('g1', 'c1', false);
    });

    it('shows the uptime of a running command', () => {
      vi.setSystemTime(new Date(100_000));
      const el = expandedWith(
        withCommand({ status: 'running', startedAt: 70_000 }),
      );
      expect(q(el, '.cmd-sub-row .uptime').dataset.startedAt).toBe('70000');
    });

    it('counts warnings and errors, each opening its own filtered view', () => {
      const el = expandedWith(withCommand({ warnCount: 2, errorCount: 3 }));
      expect(q(el, '.counter-btn.warn').textContent).toBe('⚠ 2');
      expect(q(el, '.counter-btn.error').textContent).toBe('✕ 3');
      click(q(el, '.counter-btn.error'));
      expect(api.openLogs).toHaveBeenCalledWith({
        processId: 'g1:c1',
        level: 'error',
      });
    });

    it('hides a counter the group has muted', () => {
      const el = expandedWith(
        withCommand({ warnCount: 2, errorCount: 3, muteWarn: true }),
      );
      expect(el.querySelector('.counter-btn.warn')).toBeNull();
      expect(el.querySelector('.counter-btn.error')).not.toBeNull();
    });

    it('shows no counters at all when both are zero', () => {
      const el = expandedWith(withCommand({ warnCount: 0, errorCount: 0 }));
      expect(el.querySelector('.cmd-counters')).toBeNull();
    });
  });

  describe('action chips', () => {
    function expandedWith(state: GroupState): HTMLElement {
      mount(state);
      click(q(mount(state), '.caret-btn'));
      return mount(state);
    }

    function withAction(as: Partial<ActionRuntimeState> = {}): GroupState {
      return groupState({
        group: { ...groupState().group, actions: [action()] },
        actions: [actionState(as)],
      });
    }

    it('announces the section and shows the action', () => {
      const el = expandedWith(withAction());
      expect(q(el, '.actions-divider').textContent).toBe('── Acciones ──');
      expect(q(el, '.action-chip').textContent).toBe('migrar');
    });

    it('runs the action when the chip is pressed', () => {
      const el = expandedWith(withAction());
      click(q(el, '.action-chip'));
      expect(api.runAction).toHaveBeenCalledWith('g1', 'a1');
    });

    it('shows it as running and refuses a second press', () => {
      const el = expandedWith(withAction({ status: 'running' }));
      const chip = q(el, '.action-chip');
      expect(chip.className).toContain('running');
      expect(chip.textContent).toBe('migrar …');
      click(chip);
      expect(api.runAction).not.toHaveBeenCalled();
    });

    it('ticks a run that exited cleanly', () => {
      vi.setSystemTime(new Date(10_000));
      const el = expandedWith(
        withAction({
          status: 'done',
          lastExitCode: 0,
          lastFinishedAt: 9_000,
        }),
      );
      expect(q(el, '.action-chip').textContent).toBe('migrar ✓');
    });

    it('crosses a run that failed, and says so on hover', () => {
      vi.setSystemTime(new Date(10_000));
      const el = expandedWith(
        withAction({
          status: 'done',
          lastExitCode: 2,
          lastFinishedAt: 9_000,
        }),
      );
      expect(q(el, '.action-chip').textContent).toBe('migrar ✕');
      expect(q(el, '.action-chip').title).toBe('migrar (exit 2)');
    });

    it('lets the result fade back to a plain chip after a few seconds', () => {
      vi.setSystemTime(new Date(20_000));
      const el = expandedWith(
        withAction({
          status: 'done',
          lastExitCode: 0,
          lastFinishedAt: 10_000,
        }),
      );
      expect(q(el, '.action-chip').className).toBe('action-chip');
      expect(q(el, '.action-chip').textContent).toBe('migrar');
    });

    it('keeps the log reachable once the action has run', () => {
      const el = expandedWith(withAction({ lastFinishedAt: 1000 }));
      click(q(el, '.action-logs-btn'));
      expect(api.openLogs).toHaveBeenCalledWith('g1:a1');
    });

    it('offers no log for an action that has never run', () => {
      const el = expandedWith(withAction());
      expect(el.querySelector('.action-logs-btn')).toBeNull();
    });

    it('prefixes the icon when the action has one', () => {
      const el = expandedWith(
        groupState({
          group: {
            ...groupState().group,
            actions: [action({ icon: '🛠' })],
          },
          actions: [actionState()],
        }),
      );
      expect(q(el, '.action-chip').textContent).toBe('🛠 migrar');
    });

    it('skips a runtime state whose action is gone from the config', () => {
      const el = expandedWith(
        groupState({
          group: { ...groupState().group, actions: [] },
          actions: [actionState()],
        }),
      );
      expect(el.querySelector('.action-chip')).toBeNull();
    });
  });
});
