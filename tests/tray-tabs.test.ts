// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type { GroupState, WorkflowEntry } from '../src/ipc-contract.js';
import type { Workflow } from '../src/domain-types.js';
import { makeGroup } from './helpers/main-fakes.js';

/**
 * The tray popover's «Grupos | Workflows» tabs, driven through the real tray
 * window: what each tab shows, its count and badge, the keyboard, the
 * remembered choice, and the selector disappearing when there is no workflow
 * to list.
 */

const STORAGE_KEY = 'devbar.tray.tab';

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function click(el: Element | null): void {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function key(el: Element, name: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
}

function entry(
  id: string,
  extra: Partial<WorkflowEntry> = {},
  workflow: Partial<Workflow> = {},
): WorkflowEntry {
  return {
    workflow: {
      id,
      name: `Flujo ${id}`,
      enabled: true,
      hidden: false,
      trigger: { kind: 'manual', confirm: false },
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

const RUNNING = {
  runId: 1,
  doneScripts: 1,
  totalScripts: 4,
  startedAt: Date.now(),
};

function groupState(name: string, hiddenInTray = false): GroupState {
  return {
    groupId: `group-${name}`,
    group: makeGroup({ id: `group-${name}`, name, hiddenInTray }),
    currentBranch: null,
    color: 'stopped',
    commands: [],
    actions: [],
    lastError: null,
  };
}

const tabs = (): HTMLElement => byId('tray-tabs');
const groupsTab = (): HTMLElement => byId('tray-tab-groups');
const workflowsTab = (): HTMLElement => byId('tray-tab-workflows');
const groupNames = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>('#groups .group-name'),
    (el) => el.textContent ?? '',
  );
const workflowNames = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>('#groups .tray-wf-name'),
    (el) => el.textContent ?? '',
  );

describe('renderer/tray/tabs.ts', () => {
  let tray: RendererWindow | null = null;
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    tray?.close();
    tray = null;
    localStorage.clear();
    document.body.innerHTML = '';
  });

  async function openTray(
    workflows: WorkflowEntry[] = [entry('m')],
    groups: GroupState[] = [
      groupState('api'),
      groupState('web'),
      groupState('db', true),
    ],
  ): Promise<RendererWindow> {
    tray = await loadRendererWindow({
      html: 'tray.html',
      load: () => import('../renderer/tray.js'),
      values: { platform: 'macos' },
    });
    await tray.settle('getGroupStates', groups);
    await tray.settle('listWorkflows', workflows);
    return tray;
  }

  it('starts on Grupos, which lists only the groups', async () => {
    await openTray();
    expect(tabs().hidden).toBe(false);
    expect(tabs().getAttribute('role')).toBe('tablist');
    expect(groupsTab().getAttribute('aria-selected')).toBe('true');
    expect(workflowsTab().getAttribute('aria-selected')).toBe('false');
    expect(groupNames()).toEqual(['api', 'web']);
    expect(workflowNames()).toEqual([]);
    expect(byId('groups').getAttribute('role')).toBe('tabpanel');
    expect(byId('groups').getAttribute('aria-labelledby')).toBe(
      'tray-tab-groups',
    );
  });

  it('counts the visible groups on the Grupos tab', async () => {
    await openTray();
    expect(groupsTab().querySelector('.tray-tab-count')?.textContent).toBe('2');
  });

  it('shows the workflows, without the groups, on the Workflows tab', async () => {
    await openTray([entry('m'), entry('r', { running: RUNNING })]);
    click(workflowsTab());
    expect(workflowsTab().getAttribute('aria-selected')).toBe('true');
    expect(groupsTab().getAttribute('aria-selected')).toBe('false');
    expect(groupNames()).toEqual([]);
    expect(workflowNames()).toEqual(['Flujo r', 'Flujo m']);
    expect(byId('groups').getAttribute('aria-labelledby')).toBe(
      'tray-tab-workflows',
    );
  });

  it('badges the Workflows tab with the running count, only when some run', async () => {
    const win = await openTray([entry('m')]);
    const badge = (): HTMLElement | null =>
      workflowsTab().querySelector('.tray-tab-badge');
    expect(badge()?.hidden).toBe(true);
    await win.push('onWorkflowsUpdate', [
      entry('m', { running: RUNNING }),
      entry('n', { running: RUNNING }),
    ]);
    expect(badge()?.hidden).toBe(false);
    expect(badge()?.textContent).toBe('2');
    expect(badge()?.getAttribute('aria-label')).toBe('2 en ejecución');
  });

  it('heads the Workflows tab with «Gestionar workflows», which opens them in settings', async () => {
    const win = await openTray([entry('m'), entry('n')]);
    click(workflowsTab());
    const section = document.querySelector('#groups .tray-workflows');
    const manage = section?.firstElementChild ?? null;
    expect(manage?.classList.contains('tray-manage')).toBe(true);
    expect(manage?.textContent).toContain('Gestionar workflows');
    expect(document.querySelectorAll('#groups .tray-manage')).toHaveLength(1);
    click(manage);
    expect(win.argsFor('openConfig')).toEqual([['workflows']]);
    expect(document.querySelector('.tray-wf-all')).toBeNull();
  });

  it('heads the Grupos tab with «Gestionar grupos», which opens them in settings', async () => {
    const win = await openTray();
    const manage = byId('groups').firstElementChild;
    expect(manage?.classList.contains('tray-manage')).toBe(true);
    expect(manage?.textContent).toContain('Gestionar grupos');
    expect(document.querySelectorAll('#groups .tray-manage')).toHaveLength(1);
    click(manage);
    expect(win.argsFor('openConfig')).toEqual([['groups']]);
  });

  it('keeps «Gestionar grupos» over the groups when the selector is hidden', async () => {
    await openTray([]);
    expect(tabs().hidden).toBe(true);
    expect(byId('groups').firstElementChild?.textContent).toContain(
      'Gestionar grupos',
    );
    expect(groupNames()).toEqual(['api', 'web']);
  });

  it('moves between the tabs with the arrow keys, Home and End', async () => {
    await openTray();
    groupsTab().focus();
    key(groupsTab(), 'ArrowRight');
    expect(workflowsTab().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(workflowsTab());
    key(workflowsTab(), 'ArrowRight');
    expect(groupsTab().getAttribute('aria-selected')).toBe('true');
    key(groupsTab(), 'End');
    expect(workflowsTab().getAttribute('aria-selected')).toBe('true');
    key(workflowsTab(), 'Home');
    expect(groupsTab().getAttribute('aria-selected')).toBe('true');
    key(groupsTab(), 'ArrowLeft');
    expect(workflowsTab().getAttribute('aria-selected')).toBe('true');
    expect(workflowsTab().tabIndex).toBe(0);
    expect(groupsTab().tabIndex).toBe(-1);
  });

  it('remembers the chosen tab for the next time', async () => {
    await openTray();
    click(workflowsTab());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('workflows');
    tray?.close();
    await openTray();
    expect(workflowsTab().getAttribute('aria-selected')).toBe('true');
    expect(workflowNames()).toEqual(['Flujo m']);
  });

  it('ignores a remembered value it does not know', async () => {
    localStorage.setItem(STORAGE_KEY, 'nope');
    await openTray();
    expect(groupsTab().getAttribute('aria-selected')).toBe('true');
  });

  it('hides the selector and shows only the groups with no workflow to list', async () => {
    localStorage.setItem(STORAGE_KEY, 'workflows');
    const win = await openTray([entry('h', {}, { hidden: true })]);
    expect(tabs().hidden).toBe(true);
    expect(groupNames()).toEqual(['api', 'web']);
    expect(workflowNames()).toEqual([]);
    expect(byId('groups').hasAttribute('role')).toBe(false);
    // Back as soon as there is one, on the tab that was remembered.
    await win.push('onWorkflowsUpdate', [entry('m')]);
    expect(tabs().hidden).toBe(false);
    expect(workflowNames()).toEqual(['Flujo m']);
  });

  it('keeps the selector for hidden workflows listed behind the fold', async () => {
    const win = await openTray([entry('h', {}, { hidden: true })]);
    expect(tabs().hidden).toBe(true);
    await win.push('onSettingsChange', { showHiddenWorkflowsFold: true });
    expect(tabs().hidden).toBe(false);
  });

  it('shows the empty state on Grupos and the workflows on their tab', async () => {
    await openTray([entry('m')], []);
    expect(document.querySelector('#groups .empty-state')).not.toBeNull();
    click(workflowsTab());
    expect(document.querySelector('#groups .empty-state')).toBeNull();
    expect(workflowNames()).toEqual(['Flujo m']);
  });
});
