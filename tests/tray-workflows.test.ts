// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type { GroupState, WorkflowEntry } from '../src/ipc-contract.js';
import type { Workflow, WorkflowTrigger } from '../src/domain-types.js';

/**
 * The tray popover's Workflows tab and its «N oculto(s)» group disclosure,
 * driven through the real tray window. The Workflows tab is the remembered
 * one here, so its list shows as soon as there is something in it.
 */

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function click(el: Element | null): void {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const MANUAL: WorkflowTrigger = {
  kind: 'manual',
  confirm: false,
};

function entry(
  id: string,
  trigger: WorkflowTrigger = MANUAL,
  extra: Partial<WorkflowEntry> = {},
  workflow: Partial<Workflow> = {},
): WorkflowEntry {
  return {
    workflow: {
      id,
      name: `Flujo ${id}`,
      enabled: true,
      hidden: false,
      trigger,
      graph: { blocks: [], edges: [] },
      ...workflow,
    },
    lastRun: null,
    nextRunAt: null,
    scriptCount: 2,
    running: null,
    ...extra,
  };
}

function groupState(name: string, hiddenInTray = false): GroupState {
  return {
    groupId: `group-${name}`,
    group: {
      id: `group-${name}`,
      name,
      icon: 'package',
      iconColor: null,
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
      hiddenInTray,
    },
    currentBranch: null,
    color: 'stopped',
    commands: [],
    actions: [],
    lastError: null,
  };
}

const rows = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>('.tray-wf-row .tray-wf-name'),
    (el) => el.textContent ?? '',
  );

describe('renderer/tray/workflows-section.ts', () => {
  let tray: RendererWindow | null = null;
  beforeEach(() => {
    localStorage.setItem('devbar.tray.tab', 'workflows');
  });
  afterEach(() => {
    tray?.close();
    tray = null;
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function openTray(): Promise<RendererWindow> {
    tray = await loadRendererWindow({
      html: 'tray.html',
      load: () => import('../renderer/tray.js'),
      values: { platform: 'macos' },
    });
    await tray.settle('getGroupStates', [groupState('api')]);
    return tray;
  }

  describe('the Workflows tab', () => {
    it('has no tab to show while there is nothing to list', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', []);
      expect(byId('tray-tabs').hidden).toBe(true);
      expect(document.getElementById('tray-workflows')).toBeNull();
    });

    it('lists the running one first with its progress and a stop button', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', [
        entry('m'),
        entry(
          's',
          { kind: 'startup' },
          {
            running: {
              runId: 1,
              doneScripts: 3,
              totalScripts: 8,
              startedAt: Date.now(),
            },
          },
        ),
      ]);
      expect(rows()).toEqual(['Flujo s', 'Flujo m']);
      const running = document.querySelector('.tray-wf-row.is-running');
      expect(running?.querySelector('.tray-wf-count')?.textContent).toBe('3/8');
      expect(
        running?.querySelector<HTMLElement>('.tray-wf-progress-bar')?.style
          .width,
      ).not.toBe('');
      click(running?.querySelector('[aria-label="Detener «Flujo s»"]') ?? null);
      expect(win.argsFor('stopWorkflow')).toEqual([['s']]);
    });

    it('runs an idle one from its ▶ button', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', [entry('m')]);
      click(document.querySelector('[aria-label="Ejecutar «Flujo m»"]'));
      expect(win.argsFor('runWorkflow')).toEqual([['m']]);
    });

    it('follows the pushed list', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', []);
      await win.push('onWorkflowsUpdate', [entry('m')]);
      expect(rows()).toEqual(['Flujo m']);
    });

    it('lists no hidden workflow while the fold is off (the default)', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', [
        entry('m'),
        entry('h', MANUAL, {}, { hidden: true }),
      ]);
      expect(rows()).toEqual(['Flujo m']);
      expect(
        document.querySelector('#tray-workflows .hidden-groups-toggle'),
      ).toBeNull();
    });

    it('folds the hidden workflows at the end when the fold is on', async () => {
      const win = await openTray();
      await win.push('onSettingsChange', { showHiddenWorkflowsFold: true });
      await win.settle('listWorkflows', [
        entry('h', MANUAL, {}, { hidden: true }),
        entry('m'),
      ]);
      expect(rows()).toEqual(['Flujo m']);
      const toggle = document.querySelector<HTMLElement>(
        '#tray-workflows .hidden-groups-toggle',
      );
      expect(toggle?.textContent).toContain('1 oculto');
      click(toggle);
      expect(rows()).toEqual(['Flujo m', 'Flujo h']);
      expect(
        document.querySelector('.tray-wf-row.is-hidden-group')?.textContent,
      ).toContain('Flujo h');
    });

    it('always lists a running hidden workflow', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', [
        entry(
          'h',
          MANUAL,
          {
            running: {
              runId: 1,
              doneScripts: 0,
              totalScripts: 2,
              startedAt: Date.now(),
            },
          },
          { hidden: true },
        ),
      ]);
      expect(rows()).toEqual(['Flujo h']);
    });

    it('survives a group re-render', async () => {
      const win = await openTray();
      await win.settle('listWorkflows', [entry('m')]);
      await win.push('onUpdate', [groupState('api'), groupState('web')]);
      expect(rows()).toEqual(['Flujo m']);
    });
  });

  describe('hidden groups', () => {
    const groupNames = (): string[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>('#groups .group-name'),
        (el) => el.textContent ?? '',
      );

    it('folds hidden groups into an «N oculto(s)» disclosure', async () => {
      const win = await openTray();
      await win.push('onUpdate', [
        groupState('api'),
        groupState('web', true),
        groupState('db', true),
      ]);
      expect(groupNames()).toEqual(['api']);
      const toggle = document.querySelector<HTMLElement>(
        '.hidden-groups-toggle',
      );
      expect(toggle?.textContent).toContain('2 ocultos');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      click(toggle);
      expect(groupNames()).toEqual(['api', 'web', 'db']);
      expect(document.querySelectorAll('.is-hidden-group')).toHaveLength(2);
      expect(
        document
          .querySelector('.hidden-groups-toggle')
          ?.getAttribute('aria-expanded'),
      ).toBe('true');
    });

    it('says «1 oculto» for one, and nothing at all with none', async () => {
      const win = await openTray();
      await win.push('onUpdate', [groupState('api'), groupState('web', true)]);
      expect(
        document.querySelector('.hidden-groups-toggle')?.textContent,
      ).toContain('1 oculto');
      await win.push('onUpdate', [groupState('api')]);
      expect(document.querySelector('.hidden-groups-toggle')).toBeNull();
    });

    it('lists no hidden group at all when the fold is turned off', async () => {
      const win = await openTray();
      // The theme reads the settings too: answer every read the same way.
      for (let left = win.callCount('getSettings'); left > 0; left--)
        await win.settle('getSettings', { showHiddenGroupsFold: false });
      await win.push('onUpdate', [groupState('api'), groupState('web', true)]);
      expect(groupNames()).toEqual(['api']);
      expect(document.querySelector('.hidden-groups-toggle')).toBeNull();
    });

    it('follows the setting when it changes while the tray is open', async () => {
      const win = await openTray();
      await win.push('onUpdate', [groupState('api'), groupState('web', true)]);
      expect(document.querySelector('.hidden-groups-toggle')).not.toBeNull();
      await win.push('onSettingsChange', { showHiddenGroupsFold: false });
      expect(document.querySelector('.hidden-groups-toggle')).toBeNull();
      await win.push('onSettingsChange', { showHiddenGroupsFold: true });
      expect(document.querySelector('.hidden-groups-toggle')).not.toBeNull();
    });
  });
});
