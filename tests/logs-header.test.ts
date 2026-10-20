// @vitest-environment jsdom
import { iconText } from './helpers/icon-text.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import type { LogListItem } from '../src/ipc-contract.js';

/**
 * `renderer/logs/header.ts` is the window's own title bar: what is on screen,
 * how long it has been running, and the controls that act on the whole view.
 * `renderHeaderRunState` runs once a second for the ticking uptime, so what is
 * asserted here is not only what it writes but that it stops writing when
 * nothing changed.
 */
type HeaderModule = typeof import('../renderer/logs/header.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

function item(overrides: Partial<LogListItem> = {}): LogListItem {
  return {
    id: 'api',
    type: 'command',
    name: 'api',
    icon: null,
    iconColor: null,
    lineCount: 0,
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    startedAt: null,
    lastFinishedAt: null,
    logLimit: 5000,
    ...overrides,
  };
}

describe('renderer/logs/header.ts', () => {
  let header: HeaderModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let dom: LogsDom;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0));
    dom = mountLogsDom();
    header = await import('../renderer/logs/header.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Put one service on screen, as `selectLog` would have left things. */
  function showing(overrides: Partial<LogListItem> = {}): LogListItem {
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
    return shown;
  }

  describe('renderHeaderRunState', () => {
    it('names just the group while a whole group is merged', () => {
      view.view.processId = null;
      view.view.mergedGroupId = 'g1';
      view.view.groupName = 'Back';
      header.renderHeaderRunState();
      expect(elements.crumbNameEl.textContent).toBe('Back');
      expect(elements.crumbGroupEl.hidden).toBe(true);
      expect(elements.runPillEl.hidden).toBe(true);
      expect(elements.runBtn.hidden).toBe(true);
      expect(document.title).toBe('Logs — Back · todos');
    });

    it('says «Todo» for everything merged', () => {
      view.view.processId = null;
      view.view.mergedIsAll = true;
      header.renderHeaderRunState();
      expect(elements.crumbNameEl.textContent).toBe('Todo');
      expect(document.title).toBe('Telemetría');
    });

    it('waits for the snapshot before naming a service', () => {
      view.view.processId = 'api';
      view.view.displayName = '';
      elements.crumbNameEl.textContent = 'sin tocar';
      header.renderHeaderRunState();
      expect(elements.crumbNameEl.textContent).toBe('sin tocar');
    });

    it('names the service, qualified by its group', () => {
      showing();
      header.renderHeaderRunState();
      expect(elements.crumbGroupEl.textContent).toBe('Back');
      expect(elements.crumbGroupEl.hidden).toBe(false);
      expect(elements.crumbSepEl.hidden).toBe(false);
      expect(elements.crumbNameEl.textContent).toBe('api');
      expect(document.title).toBe('Logs — Back · api');
    });

    it('drops the qualifier when there is no group to qualify with', () => {
      showing();
      view.view.groupName = '';
      header.renderHeaderRunState();
      expect(elements.crumbGroupEl.hidden).toBe(true);
      expect(elements.crumbSepEl.hidden).toBe(true);
      expect(document.title).toBe('Logs — api');
    });

    it('offers to stop a running command, or restart it', () => {
      showing({ status: 'running', startedAt: Date.now() });
      header.renderHeaderRunState();
      expect(elements.runBtn.hidden).toBe(false);
      expect(iconText(elements.runBtn)).toBe('[square]');
      expect(elements.runBtn.title).toBe('Parar');
      expect(elements.runBtn.classList.contains('on')).toBe(true);
      expect(elements.restartBtn.hidden).toBe(false);
    });

    it('offers to start a stopped one, and nothing to restart', () => {
      showing({ status: 'stopped' });
      header.renderHeaderRunState();
      expect(iconText(elements.runBtn)).toBe('[play]');
      expect(elements.runBtn.title).toBe('Iniciar');
      expect(elements.runBtn.classList.contains('on')).toBe(false);
      expect(elements.restartBtn.hidden).toBe(true);
    });

    it('never offers to restart an action', () => {
      showing({
        id: 'action:g1:deploy',
        type: 'action',
        status: 'running',
        startedAt: Date.now(),
      });
      header.renderHeaderRunState();
      expect(elements.runBtn.hidden).toBe(false);
      expect(elements.restartBtn.hidden).toBe(true);
    });

    it('hides the controls for something the window cannot launch', () => {
      showing({ type: 'prescript', status: 'running', startedAt: Date.now() });
      header.renderHeaderRunState();
      expect(elements.runBtn.hidden).toBe(true);
      expect(elements.restartBtn.hidden).toBe(true);
      expect(elements.runPillEl.hidden).toBe(false);
    });

    it('ticks the uptime of a live run on the pill', () => {
      showing({ status: 'running', startedAt: Date.now() - 65_000 });
      header.renderHeaderRunState();
      expect(elements.runPillTextEl.textContent).toBe('En marcha · 1m 5s');
      expect(elements.runPillEl.dataset.tone).toBe('running');
      expect(document.title).toBe('Logs — Back · api · 1m 5s');
    });

    it('says a finished run is stopped, keeping its length in the tooltip', () => {
      showing({
        status: 'stopped',
        startedAt: 1000,
        lastFinishedAt: 4000,
      });
      header.renderHeaderRunState();
      expect(elements.runPillTextEl.textContent).toBe('Parado');
      expect(elements.runPillEl.title).toBe('Última ejecución: 3s');
      expect(elements.runPillEl.dataset.tone).toBe('stopped');
      expect(document.title).toBe('Logs — Back · api · 3s');
    });

    it('turns the pill red when the run ended in an error', () => {
      showing({ status: 'error' });
      header.renderHeaderRunState();
      expect(elements.runPillTextEl.textContent).toBe('Con errores');
      expect(elements.runPillEl.dataset.tone).toBe('error');
    });

    it('leaves the text nodes alone when the second changed nothing', () => {
      // It runs once a second: writing the same string back would still dirty
      // the node, and the browser would repaint the toolbar on every tick.
      showing({ status: 'stopped' });
      header.renderHeaderRunState();
      const name = elements.crumbNameEl.firstChild;
      const pill = elements.runPillTextEl.firstChild;
      header.renderHeaderRunState();
      expect(elements.crumbNameEl.firstChild).toBe(name);
      expect(elements.runPillTextEl.firstChild).toBe(pill);
    });

    it('repaints the level chips, which share the toolbar', () => {
      showing();
      view.view.levelFilter = new Set(['error']);
      header.renderHeaderRunState();
      expect(elements.levelErrorChip.getAttribute('aria-pressed')).toBe('true');
      expect(elements.levelAllBtn.getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('the restart control', () => {
    it('stops, then starts, the running command', async () => {
      showing({ status: 'running', startedAt: Date.now() });
      elements.restartBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(dom.calls.map((call) => call.name)).toEqual([
        'stopProcess',
        'startProcess',
      ]);
      expect(dom.argsFor('startProcess')).toEqual([['api']]);
    });

    it('does nothing once the command is no longer running', async () => {
      showing({ status: 'stopped' });
      elements.restartBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(dom.calls).toEqual([]);
    });
  });

  describe('the run control', () => {
    it('stops what is running', () => {
      showing({ status: 'running', startedAt: Date.now() });
      elements.runBtn.click();
      expect(dom.argsFor('stopProcess')).toEqual([['api']]);
    });

    it('starts what is stopped', () => {
      showing({ status: 'stopped' });
      elements.runBtn.click();
      expect(dom.argsFor('startProcess')).toEqual([['api']]);
    });

    it('runs an action through the gate that asks for confirmation', () => {
      // actions:run keeps the confirmation prompt; startProcess would skip it.
      showing({ id: 'action:g1:deploy:prod', type: 'action', name: 'deploy' });
      elements.runBtn.click();
      expect(dom.argsFor('runAction')).toEqual([['g1', 'deploy:prod']]);
      expect(dom.argsFor('startProcess')).toEqual([]);
    });

    it('ignores an action id it cannot split into group and action', () => {
      showing({ id: 'action', type: 'action', name: 'roto' });
      elements.runBtn.click();
      expect(dom.argsFor('runAction')).toEqual([]);
      expect(dom.argsFor('startProcess')).toEqual([]);
    });

    it('does nothing for something the window cannot launch', () => {
      showing({ type: 'prescript' });
      elements.runBtn.click();
      expect(dom.calls).toEqual([]);
    });
  });

  describe('toggleRunById', () => {
    it('resolves the state on click, not the one the row was built from', () => {
      // Sidebar rows are repainted in place, so the row a click arrives on may
      // have been built when the service was still stopped.
      showing({ status: 'running', startedAt: Date.now() });
      header.toggleRunById('api');
      expect(dom.argsFor('stopProcess')).toEqual([['api']]);
    });

    it('does nothing for a service main no longer lists', () => {
      showing();
      header.toggleRunById('se-fue');
      expect(dom.calls).toEqual([]);
    });
  });

  describe('clearLog', () => {
    it('wipes the retained buffer, not merely the rows on screen', async () => {
      const pane = await import('../renderer/logs/pane.js');
      const status = await import('../renderer/logs/status.js');
      showing();
      pane.resetBuffer([
        { ts: 0, stream: 'stdout', level: null, line: 'vieja' },
      ]);
      status.queueWhilePaused({
        ts: 0,
        stream: 'stdout',
        level: null,
        line: 'en cola',
      });
      await header.clearLog();
      expect(dom.argsFor('clearLogs')).toEqual([['api']]);
      expect(elements.linesEl.childElementCount).toBe(0);
      // Resuming would otherwise re-add the very lines just cleared.
      expect(status.pendingQueue).toHaveLength(0);
    });

    it('still clears the view when no single service owns it', async () => {
      const pane = await import('../renderer/logs/pane.js');
      view.view.processId = null;
      pane.resetBuffer([
        { ts: 0, stream: 'stdout', level: null, line: 'vieja' },
      ]);
      await header.clearLog();
      expect(dom.argsFor('clearLogs')).toEqual([]);
      expect(elements.linesEl.childElementCount).toBe(0);
    });
  });

  describe('detachLog', () => {
    it('opens this very service in a window of its own', () => {
      showing();
      header.detachLog();
      expect(dom.argsFor('openLogs')).toEqual([
        [{ processId: 'api', detached: true }],
      ]);
    });

    it('has nothing to detach while a merged scope is on screen', () => {
      view.view.processId = null;
      header.detachLog();
      expect(dom.argsFor('openLogs')).toEqual([]);
    });
  });
});
