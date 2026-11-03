// @vitest-environment jsdom
import { iconText } from './helpers/icon-text.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import type { DetectedPort } from '../src/domain-types.js';
import type {
  CommandRuntimeState,
  GroupState,
  LogListItem,
} from '../src/ipc-contract.js';

/**
 * `renderer/logs/port-pill.ts`: the «localhost:3000 ↗» pill right after the
 * run pill. It reads the ports from the group states the window already
 * receives, and only a running command with a web/http port gets an action.
 */
type PortPillModule = typeof import('../renderer/logs/port-pill.js');
type HeaderModule = typeof import('../renderer/logs/header.js');
type ViewModule = typeof import('../renderer/logs/view.js');

function port(overrides: Partial<DetectedPort> = {}): DetectedPort {
  return {
    port: 3000,
    url: 'http://localhost:3000/',
    kind: 'web',
    source: 'log',
    lanReachable: false,
    ...overrides,
  };
}

function command(ports: DetectedPort[]): CommandRuntimeState {
  return {
    commandId: 'web',
    processId: 'g1:web',
    status: 'running',
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: 1,
    color: 'running',
    muteWarn: false,
    muteErr: false,
    ports,
  };
}

function states(ports: DetectedPort[]): GroupState[] {
  return [
    {
      groupId: 'g1',
      group: {} as GroupState['group'],
      currentBranch: null,
      color: 'running',
      commands: [command(ports)],
      actions: [],
      lastError: null,
    },
  ];
}

function item(overrides: Partial<LogListItem> = {}): LogListItem {
  return {
    id: 'g1:web',
    type: 'command',
    name: 'web',
    icon: null,
    iconColor: null,
    lineCount: 0,
    status: 'running',
    warnCount: 0,
    errorCount: 0,
    startedAt: 1,
    lastFinishedAt: null,
    logLimit: 5000,
    ...overrides,
  };
}

describe('renderer/logs/port-pill.ts', () => {
  let pill: PortPillModule;
  let header: HeaderModule;
  let view: ViewModule;
  let dom: LogsDom;

  beforeEach(async () => {
    dom = mountLogsDom();
    pill = await import('../renderer/logs/port-pill.js');
    header = await import('../renderer/logs/header.js');
    view = await import('../renderer/logs/view.js');
  });

  function slot(): HTMLElement {
    const el = document.getElementById('port-pill');
    if (!el) throw new Error('#port-pill missing from logs.html');
    return el;
  }

  /** Put one service on screen, as `selectLog` would have left things. */
  function showing(overrides: Partial<LogListItem> = {}): void {
    const shown = item(overrides);
    view.view.processId = shown.id;
    view.view.displayName = shown.name;
    view.view.groupName = 'Back';
    view.view.sideData = [
      {
        groupId: 'g1',
        groupName: 'Back',
        groupIcon: 'folder',
        groupIconColor: null,
        items: [shown],
      },
    ];
  }

  describe('portPillFor', () => {
    it('has nothing to show without ports', () => {
      expect(pill.portPillFor([])).toBeNull();
    });

    it('offers the primary web port by its host', () => {
      expect(pill.portPillFor([port()])).toEqual({
        kind: 'open',
        text: 'localhost:3000',
        menu: false,
      });
    });

    it('opens an HTTP API as well', () => {
      expect(
        pill.portPillFor([
          port({ kind: 'http', port: 8080, url: 'http://localhost:8080/' }),
        ]),
      ).toMatchObject({ kind: 'open', text: 'localhost:8080' });
    });

    it('turns into a menu when there is more than one port to open', () => {
      expect(
        pill.portPillFor([
          port(),
          port({ port: 6006, url: 'http://localhost:6006/' }),
        ]),
      ).toMatchObject({ kind: 'open', text: 'localhost:3000', menu: true });
    });

    it('mutes a port that is not web', () => {
      expect(
        pill.portPillFor([
          port({ kind: 'other', port: 5432, url: 'http://localhost:5432/' }),
        ]),
      ).toEqual({ kind: 'muted', text: ':5432' });
    });
  });

  describe('renderPortPill', () => {
    it('shows the pill of a running command and opens its link', () => {
      showing();
      pill.adoptGroupStates(states([port()]));
      header.renderHeaderRunState();
      const button = slot().querySelector('button');
      expect(slot().hidden).toBe(false);
      expect(iconText(button)).toBe('localhost:3000[external-link]');
      button?.click();
      expect(dom.argsFor('openPort')).toEqual([['g1', 'web']]);
    });

    it('hides it while the command is stopped', () => {
      showing({ status: 'stopped' });
      pill.adoptGroupStates(states([port()]));
      header.renderHeaderRunState();
      expect(slot().hidden).toBe(true);
    });

    it('hides it for a merged scope', () => {
      pill.adoptGroupStates(states([port()]));
      view.view.processId = null;
      view.view.mergedIsAll = true;
      header.renderHeaderRunState();
      expect(slot().hidden).toBe(true);
    });

    it('shows a muted port with nothing to click', () => {
      showing();
      pill.adoptGroupStates(
        states([port({ kind: 'other', port: 5432, url: 'x' })]),
      );
      header.renderHeaderRunState();
      expect(slot().querySelector('button')).toBeNull();
      expect(slot().querySelector('.port-muted')?.textContent).toBe(':5432');
    });

    it('lists every port to open in a menu', () => {
      showing();
      pill.adoptGroupStates(
        states([
          port({ label: 'Vite' }),
          port({ port: 6006, url: 'http://localhost:6006/', kind: 'http' }),
          port({ kind: 'other', port: 5432, url: 'http://localhost:5432/' }),
        ]),
      );
      header.renderHeaderRunState();
      slot().querySelector('button')?.click();
      const items = [...slot().querySelectorAll('[role="menuitem"]')];
      expect(items.map((el) => iconText(el))).toEqual([
        '[external-link]localhost:3000 · Vite',
        '[external-link]localhost:6006',
      ]);
      (items[1] as HTMLButtonElement).click();
      expect(dom.argsFor('openPort')).toEqual([['g1', 'web', 6006]]);
    });

    it('follows the next state update live', () => {
      showing();
      pill.adoptGroupStates(states([port()]));
      header.renderHeaderRunState();
      pill.adoptGroupStates(states([]));
      header.renderHeaderRunState();
      expect(slot().hidden).toBe(true);
    });

    it('does not rebuild the pill when nothing changed', () => {
      showing();
      pill.adoptGroupStates(states([port()]));
      header.renderHeaderRunState();
      const before = slot().firstChild;
      header.renderHeaderRunState();
      expect(slot().firstChild).toBe(before);
    });

    it('ignores a push without a payload', () => {
      expect(() => pill.adoptGroupStates(undefined)).not.toThrow();
    });
  });
});
