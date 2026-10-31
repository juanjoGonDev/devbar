// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { group, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import { chain } from './helpers/pipeline-editor.js';
import {
  MANUAL,
  rowFor,
  runState,
  wfEntry,
  workflow,
} from './helpers/workflows.js';
import { startupEntries } from './helpers/startup-workflow.js';
import type { WorkflowEntry } from '../src/ipc-contract.js';

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

function click(el: Element | null): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const listHost = () => q('#workflows-list-root');
const editorHost = () => q('#prescripts-pipeline-root');
const badge = () => q('#workflows-badge');

const ENTRIES: WorkflowEntry[] = [
  ...startupEntries(chain()),
  wfEntry('w2', MANUAL, {}, { name: 'Demo' }),
];

describe('renderer/workflows/section.ts', () => {
  let win: RendererWindow | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    win?.close();
    win = null;
  });

  async function boot(
    entries = ENTRIES,
    runs: unknown[] = [],
  ): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api')]);
    await win.settle('listWorkflows', entries);
    await win.settle('getWorkflowRunStates', runs);
    return win;
  }

  it('names the section Workflows in the nav and the title bar', async () => {
    await boot();
    const item = q('.nav-item[data-target="prescripts"]');
    expect(item.querySelector('.nav-label')?.textContent).toBe('Workflows');
    expect(
      item.querySelector<HTMLElement>('.nav-ico .icon')?.dataset.icon,
    ).toBe('workflow');
    item.click();
    expect(q('#window-title').textContent).toBe('Workflows');
  });

  it('starts on the list, one row per workflow', async () => {
    await boot();
    expect(listHost().hidden).toBe(false);
    expect(editorHost().hidden).toBe(true);
    expect(rowFor('w-start')).toBeTruthy();
    expect(rowFor('w2')).toBeTruthy();
  });

  it('counts the running workflows on the nav badge, hidden at zero', async () => {
    const w = await boot();
    expect(badge().hidden).toBe(true);
    await w.push(
      'onWorkflowRunState',
      runState('w2', chain(), 'running', { a: 'running' }),
    );
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('1');
    await w.push(
      'onWorkflowRunState',
      runState('w2', chain(), 'success', { a: 'success' }),
    );
    expect(badge().hidden).toBe(true);
    await w.push('onWorkflowsUpdate', [
      wfEntry('a', MANUAL, {
        running: { runId: 1, doneScripts: 0, totalScripts: 1, startedAt: 0 },
      }),
    ]);
    expect(badge().textContent).toBe('1');
  });

  it('opens a workflow in the editor with the run it already had, and comes back', async () => {
    const w = await boot(ENTRIES, [
      runState('w-start', chain(), 'error', { a: 'error' }),
    ]);
    click(rowFor('w-start').querySelector('.wf-name'));
    expect(listHost().hidden).toBe(true);
    expect(editorHost().hidden).toBe(false);
    await w.settle('listWorkflows', ENTRIES);
    expect(q('.wf-run-status .wf-dot').classList.contains('is-error')).toBe(
      true,
    );
    click([...document.querySelectorAll('.wf-crumb-back')][0] ?? null);
    expect(listHost().hidden).toBe(false);
    expect(editorHost().hidden).toBe(true);
  });

  it('paints a pushed run of the workflow being edited', async () => {
    const w = await boot();
    click(rowFor('w-start').querySelector('.wf-name'));
    await w.settle('listWorkflows', ENTRIES);
    await w.push(
      'onWorkflowRunState',
      runState('w-start', chain(), 'running', { a: 'running' }),
    );
    expect(q('.wf-run-label').textContent).toContain('Ejecutando');
    await w.push(
      'onWorkflowRunState',
      runState('w2', chain(), 'error', { a: 'error' }),
    );
    expect(q('.wf-run-label').textContent).toContain('Ejecutando');
  });

  it('goes back to the list when the open workflow is deleted elsewhere', async () => {
    const w = await boot();
    click(rowFor('w2').querySelector('.wf-name'));
    await w.settle('listWorkflows', ENTRIES);
    await w.push('onWorkflowsUpdate', ENTRIES.slice(0, 1));
    expect(listHost().hidden).toBe(false);
  });

  it('opens a new workflow with its name ready to type over', async () => {
    const w = await boot();
    click(q('.wf-new'));
    await w.settle(
      'createWorkflow',
      workflow('fresh', MANUAL, { name: 'Nuevo workflow' }),
    );
    const fresh = [
      ...ENTRIES,
      wfEntry('fresh', MANUAL, {}, { name: 'Nuevo workflow' }),
    ];
    await w.settle('listWorkflows', fresh);
    expect(editorHost().hidden).toBe(false);
    expect(document.activeElement).toBe(q('.wf-crumb-name'));
  });

  it('lands on the list from the tray’s «Ver todos»', async () => {
    const w = await boot();
    click(rowFor('w2').querySelector('.wf-name'));
    await w.settle('listWorkflows', ENTRIES);
    await w.push('onConfigGoto', 'workflows');
    expect(
      q('.config-section[data-section="prescripts"]').classList.contains(
        'active',
      ),
    ).toBe(true);
    expect(listHost().hidden).toBe(false);
  });
});
