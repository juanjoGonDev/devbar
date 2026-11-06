// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRuntimeState, GroupState } from '../src/ipc-contract.js';
import type { DetectedPort } from '../src/domain-types.js';
import { iconText } from './helpers/icon-text.js';
import { makeCommand } from './helpers/main-fakes.js';

/**
 * `renderer/tray/port-pill.ts` turns the ports main detected for a running
 * command into the tray's port pill, its «more ports» menu and the «buscando
 * puerto…» chip. Which menu is open is module state, so each test re-imports.
 */

type PortPillModule = typeof import('../renderer/tray/port-pill.js');
type HostModule = typeof import('../renderer/tray/host.js');

function port(overrides: Partial<DetectedPort> = {}): DetectedPort {
  const number = overrides.port ?? 3000;
  return {
    port: number,
    url: `http://localhost:${number}/`,
    kind: 'web',
    source: 'log',
    lanReachable: false,
    ...overrides,
  };
}

function commandState(
  overrides: Partial<CommandRuntimeState> = {},
): CommandRuntimeState {
  return {
    ports: [],
    commandId: 'c1',
    processId: 'g1:c1',
    status: 'running',
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: 0,
    color: 'running',
    muteWarn: false,
    muteErr: false,
    ...overrides,
  };
}

function groupState(commands: CommandRuntimeState[]): GroupState {
  return {
    groupId: 'g1',
    group: {
      id: 'g1',
      name: 'Front',
      icon: 'package',
      iconColor: null,
      path: '',
      mode: 'multi',
      order: 0,
      silenceWarnings: false,
      silenceErrors: false,
      env: [],
      commands: [],
      actions: [],
      preScripts: [],
      waitForPipeline: true,
      hiddenInTray: false,
    },
    currentBranch: null,
    color: 'running',
    commands,
    actions: [],
    lastError: null,
  };
}

describe('renderer/tray/port-pill.ts', () => {
  let pill: PortPillModule;
  let host: HostModule;
  let rerender: ReturnType<typeof vi.fn<() => void>>;
  let openPort: ReturnType<
    typeof vi.fn<
      (
        groupId: string,
        commandId: string,
        port?: number,
      ) => Promise<{ ok: boolean; error?: string }>
    >
  >;
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    document.body.innerHTML = '<div id="toast"></div>';
    openPort = vi.fn(() => Promise.resolve({ ok: true }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openPort },
    });
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.resetModules();
    pill = await import('../renderer/tray/port-pill.js');
    host = await import('../renderer/tray/host.js');
    rerender = vi.fn<() => void>();
    const toastEl = document.getElementById('toast');
    if (!toastEl) throw new Error('no toast element');
    host.setTrayHost({ toastElement: toastEl, rerender });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function q(root: ParentNode, selector: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    return el;
  }

  function click(el: Element): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  /** Mounts a command's pill and menu the way the row does. */
  function commandUi(
    cs: CommandRuntimeState,
  ): { pill: HTMLElement; menu: HTMLElement | null } | null {
    const ui = pill.commandPorts(groupState([cs]), cs, 'Vite dev');
    if (ui) document.body.append(ui.pill, ...(ui.menu ? [ui.menu] : []));
    return ui;
  }

  describe('a command with one web port', () => {
    it('shows the port and an arrow, accent tinted', () => {
      const ui = commandUi(commandState({ ports: [port()] }));
      const open = q(ui?.pill ?? document, '.port-pill-open');
      expect(iconText(open)).toBe(':3000[arrow-up-right]');
      expect(ui?.pill.classList.contains('is-web')).toBe(true);
    });

    it('names the URL it opens', () => {
      const ui = commandUi(commandState({ ports: [port()] }));
      expect(
        q(ui?.pill ?? document, '.port-pill-open').getAttribute('aria-label'),
      ).toBe('Abrir http://localhost:3000/');
    });

    it('opens that port of that command', () => {
      const ui = commandUi(commandState({ ports: [port()] }));
      click(q(ui?.pill ?? document, '.port-pill-open'));
      expect(openPort).toHaveBeenCalledWith('g1', 'c1', 3000);
    });

    it('treats an HTTP API port as openable too', () => {
      const ui = commandUi(commandState({ ports: [port({ kind: 'http' })] }));
      click(q(ui?.pill ?? document, '.port-pill-open'));
      expect(openPort).toHaveBeenCalledWith('g1', 'c1', 3000);
    });

    it('toasts the reason when the port cannot be opened', async () => {
      openPort.mockResolvedValueOnce({ ok: false, error: 'No abre' });
      const ui = commandUi(commandState({ ports: [port()] }));
      click(q(ui?.pill ?? document, '.port-pill-open'));
      await vi.waitFor(() =>
        expect(q(document, '#toast').textContent).toBe('No abre'),
      );
      expect(q(document, '#toast').className).toContain('error');
    });

    it('does not offer a ports menu', () => {
      const ui = commandUi(commandState({ ports: [port()] }));
      expect(ui?.pill.querySelector('.port-pill-more')).toBeNull();
    });
  });

  describe('a command whose auto link opens a path', () => {
    function withPath(): {
      pill: HTMLElement;
      menu: HTMLElement | null;
    } | null {
      const cs = commandState({
        ports: [port(), port({ port: 5432, kind: 'other' })],
      });
      const gs = groupState([cs]);
      gs.group.commands = [
        makeCommand({ id: 'c1', link: { mode: 'auto', path: '/admin' } }),
      ];
      const ui = pill.commandPorts(gs, cs, 'Vite dev');
      if (ui) document.body.append(ui.pill, ...(ui.menu ? [ui.menu] : []));
      return ui;
    }

    it('names and copies the URL with that path', async () => {
      const ui = withPath();
      expect(
        q(ui?.pill ?? document, '.port-pill-open').getAttribute('aria-label'),
      ).toBe('Abrir http://localhost:3000/admin');
      click(q(ui?.pill ?? document, '.port-pill-more'));
      click(q(withPath()?.menu ?? document, '.port-menu-copy'));
      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/admin');
      await vi.waitFor(() =>
        expect(q(document, '#toast').textContent).toBe('URL copiada'),
      );
    });
  });

  describe('a command whose only port is not a web', () => {
    it('shows the port muted and not clickable', () => {
      const ui = commandUi(
        commandState({ ports: [port({ port: 5432, kind: 'other' })] }),
      );
      expect(ui?.pill.classList.contains('is-other')).toBe(true);
      expect(ui?.pill.querySelector('button')).toBeNull();
      expect(ui?.pill.textContent).toBe(':5432');
    });

    it('says why in its tooltip', () => {
      const ui = commandUi(
        commandState({ ports: [port({ port: 5432, kind: 'other' })] }),
      );
      expect(ui?.pill.title).toBe('Escuchando en 5432 (no es una web)');
    });
  });

  describe('a command with several ports', () => {
    const several = (): CommandRuntimeState =>
      commandState({
        ports: [
          port({ port: 5173, label: 'Vite' }),
          port({ port: 6006, label: 'Storybook' }),
          port({ port: 5432, kind: 'other' }),
        ],
      });

    it('shows the primary and how many more', () => {
      const ui = commandUi(several());
      expect(iconText(q(ui?.pill ?? document, '.port-pill-open'))).toBe(
        ':5173[arrow-up-right]',
      );
      expect(iconText(q(ui?.pill ?? document, '.port-pill-more'))).toBe(
        '+2[chevron-down]',
      );
    });

    it('starts with the menu closed', () => {
      expect(commandUi(several())?.menu).toBeNull();
    });

    it('opens the menu from the chevron and repaints', () => {
      const ui = commandUi(several());
      const more = q(ui?.pill ?? document, '.port-pill-more');
      expect(more.getAttribute('aria-expanded')).toBe('false');
      click(more);
      expect(rerender).toHaveBeenCalledTimes(1);
      const again = commandUi(several());
      expect(again?.menu).not.toBeNull();
      expect(
        q(again?.pill ?? document, '.port-pill-more').getAttribute(
          'aria-expanded',
        ),
      ).toBe('true');
    });

    it('titles the menu after the command', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      const menu = commandUi(several())?.menu;
      expect(q(menu ?? document, '.port-menu-title').textContent).toBe(
        'Puertos de Vite dev',
      );
    });

    it('lists every port with its label', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      const menu = commandUi(several())?.menu ?? document;
      const items = [...menu.querySelectorAll('.port-menu-item')].map((item) =>
        iconText(item),
      );
      expect(items).toEqual([
        'localhost:5173Vite[arrow-up-right]',
        'localhost:6006Storybook[arrow-up-right]',
        'localhost:5432',
      ]);
    });

    it('opens the port picked from the menu', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      const menu = commandUi(several())?.menu ?? document;
      const storybook = q(menu, 'button.port-menu-item:nth-of-type(2)');
      expect(storybook.getAttribute('aria-label')).toBe(
        'Abrir http://localhost:6006/',
      );
      click(storybook);
      expect(openPort).toHaveBeenCalledWith('g1', 'c1', 6006);
    });

    it('marks the non-web port in the menu as information only', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      const menu = commandUi(several())?.menu ?? document;
      const other = q(menu, '.port-menu-item.is-other');
      expect(other.tagName).not.toBe('BUTTON');
      expect(other.title).toBe('Escuchando en 5432 (no es una web)');
    });

    it('copies the primary URL', async () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      const menu = commandUi(several())?.menu ?? document;
      click(q(menu, '.port-menu-copy'));
      expect(writeText).toHaveBeenCalledWith('http://localhost:5173/');
      await vi.waitFor(() =>
        expect(q(document, '#toast').textContent).toBe('URL copiada'),
      );
    });

    it('closes the menu on Escape', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      commandUi(several());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(commandUi(several())?.menu).toBeNull();
    });

    it('closes the menu on a click elsewhere', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      commandUi(several());
      click(document.body);
      expect(commandUi(several())?.menu).toBeNull();
    });

    it('closes the menu from the chevron again', () => {
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      click(q(commandUi(several())?.pill ?? document, '.port-pill-more'));
      expect(commandUi(several())?.menu).toBeNull();
    });
  });

  describe('a command still looking for its port', () => {
    it('shows «buscando puerto…» just after it started', () => {
      const ui = commandUi(commandState({ startedAt: 90_000 }));
      expect(ui?.pill.classList.contains('port-searching')).toBe(true);
      expect(iconText(ui?.pill)).toBe('[loader-circle]buscando puerto…');
    });

    it('phase-locks the spinner', () => {
      const ui = commandUi(commandState({ startedAt: 90_000 }));
      expect(q(ui?.pill ?? document, '.icon').style.animationDelay).toMatch(
        /^-?\d/,
      );
    });

    it('gives up after 30 seconds', () => {
      expect(commandUi(commandState({ startedAt: 60_000 }))).toBeNull();
    });

    it('repaints once the 30 seconds run out', () => {
      commandUi(commandState({ startedAt: 90_000 }));
      vi.advanceTimersByTime(20_100);
      expect(rerender).toHaveBeenCalled();
    });

    it('shows nothing for a stopped command', () => {
      expect(
        commandUi(commandState({ status: 'stopped', startedAt: null })),
      ).toBeNull();
    });
  });

  describe('the group header', () => {
    it('shows the first web port of its running commands', () => {
      const gs = groupState([
        commandState({ ports: [port({ port: 5432, kind: 'other' })] }),
        commandState({
          commandId: 'c2',
          ports: [port({ port: 5173 })],
        }),
      ]);
      const ui = pill.groupPorts(gs);
      expect(iconText(q(ui?.pill ?? document, '.port-pill-open'))).toBe(
        ':5173[arrow-up-right]',
      );
      click(q(ui?.pill ?? document, '.port-pill-open'));
      expect(openPort).toHaveBeenCalledWith('g1', 'c2', 5173);
    });

    it('counts the other openable ports and lists them under the group', () => {
      const gs = groupState([
        commandState({ ports: [port({ port: 5173 })] }),
        commandState({ commandId: 'c2', ports: [port({ port: 6006 })] }),
      ]);
      const ui = pill.groupPorts(gs);
      expect(iconText(q(ui?.pill ?? document, '.port-pill-more'))).toBe(
        '+1[chevron-down]',
      );
      click(q(ui?.pill ?? document, '.port-pill-more'));
      const menu = pill.groupPorts(gs)?.menu ?? document;
      expect(q(menu, '.port-menu-title').textContent).toBe('Puertos de Front');
      click(q(menu, 'button.port-menu-item:nth-of-type(2)'));
      expect(openPort).toHaveBeenCalledWith('g1', 'c2', 6006);
    });

    it('shows nothing without a web port', () => {
      const gs = groupState([
        commandState({ ports: [port({ port: 5432, kind: 'other' })] }),
      ]);
      expect(pill.groupPorts(gs)).toBeNull();
    });

    it('ignores the ports of a command that is not running', () => {
      const gs = groupState([
        commandState({ status: 'stopped', ports: [port()] }),
      ]);
      expect(pill.groupPorts(gs)).toBeNull();
    });
  });
});
