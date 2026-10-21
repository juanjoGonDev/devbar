// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { DEPS, SETUP, chain } from './helpers/pipeline-editor.js';
import { runState } from './helpers/workflows.js';
import {
  createLogDrawer,
  type LogDrawer,
} from '../renderer/workflows/log-drawer.js';
import type { LogEntry } from '../src/domain-types.js';
import type { WorkflowRunState } from '../src/ipc-contract.js';

const NAMES: Record<string, string> = {
  setup: 'Make setup',
  deps: 'Install deps',
};

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date(2026, 0, 5, 9, 3, 41).getTime(),
    stream: 'stdout',
    level: null,
    line: text,
    ...extra,
  };
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('renderer/workflows/log-drawer.ts', () => {
  let win: RendererWindow | null = null;
  let run: WorkflowRunState | null = null;
  let toggles: boolean[] = [];

  afterEach(() => {
    win?.close();
    win = null;
  });

  async function mount(state: WorkflowRunState | null): Promise<LogDrawer> {
    win = await loadRendererWindow({
      html: 'config.html',
      load: () => Promise.resolve(),
    });
    run = state;
    toggles = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    return createLogDrawer({
      host,
      workflowId: () => 'w-start',
      run: () => run,
      pipeline: () => chain(),
      nameOf: (ref) => NAMES[ref.scriptId] ?? '?',
      now: () => 1_000 + 5_000,
      pollMs: 5,
      onToggle: (open) => toggles.push(open),
    });
  }

  it('lists one tab per script of the run and shows the chosen one', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'error', { a: 'success', b: 'error' }),
    );
    drawer.open('back::setup');
    expect(q('.wf-log').hidden).toBe(false);
    expect(toggles).toEqual([true]);
    const tabs = [...document.querySelectorAll<HTMLElement>('.wf-log-tab')];
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Make setup',
      'Install deps',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(q('.wf-log').getAttribute('aria-label')).toBe('Log de Make setup');
    expect(q('.wf-log-meta').textContent).toBe('exit 0 · 3.2s');
    expect(win?.argsFor('getWorkflowScriptLog')).toEqual([
      ['w-start', 'latest', SETUP],
    ]);
  });

  it('colours warnings and errors and strips the escapes', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'error', { a: 'success', b: 'error' }),
    );
    drawer.open('front::deps');
    await win?.settle('getWorkflowScriptLog', [
      line('\u001b[32mLeyendo perfil\u001b[0m'),
      line('el puerto todavía no responde', { level: 'warn' }),
      line('ECONNREFUSED: error de conexión'),
      line('Proceso terminado', { stream: 'sys' }),
    ]);
    const lines = [...document.querySelectorAll<HTMLElement>('.wf-log-line')];
    expect(lines.map((l) => l.className)).toEqual([
      'wf-log-line',
      'wf-log-line is-warn',
      'wf-log-line is-error',
      'wf-log-line is-sys',
    ]);
    expect(lines[0]?.textContent).toBe('[09:03:41] Leyendo perfil');
    expect(q('.wf-log-meta').textContent).toBe('exit 1 · 3.2s');
  });

  it('guesses an unlabelled level with the shared defaults, not a looser regex', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'error', { a: 'success', b: 'error' }),
    );
    drawer.open('front::deps');
    await win?.settle('getWorkflowScriptLog', [
      line('compilado src/errors/index.ts'),
      line('0 errors, 0 warnings'),
      line('DeprecationWarning: Buffer() está obsoleto'),
      line('TypeError: x is undefined'),
    ]);
    const lines = [...document.querySelectorAll<HTMLElement>('.wf-log-line')];
    expect(lines.map((l) => l.className)).toEqual([
      'wf-log-line',
      'wf-log-line',
      'wf-log-line is-warn',
      'wf-log-line is-error',
    ]);
  });

  it('switches script from its tab', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'error', { a: 'success', b: 'error' }),
    );
    drawer.open(null);
    q('.wf-log-tab[data-ref="front::deps"]').click();
    expect(win?.argsFor('getWorkflowScriptLog').at(-1)).toEqual([
      'w-start',
      'latest',
      DEPS,
    ]);
  });

  it('polls a running script and refetches when the run moves on', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'running', { a: 'running' }),
    );
    drawer.open('back::setup');
    expect(q('.wf-log-meta').textContent).toBe('0:05');
    expect(
      document.querySelector<HTMLElement>('.wf-log-tabs .pipeline-spinner')
        ?.style.animationDelay,
    ).toMatch(/^-[\d.]+ms$/);
    await win?.settle('getWorkflowScriptLog', [line('uno')]);
    await sleep(20);
    expect(win?.callCount('getWorkflowScriptLog')).toBe(2);
    await win?.settle('getWorkflowScriptLog', [line('uno'), line('dos')]);
    expect(document.querySelectorAll('.wf-log-line')).toHaveLength(2);
    run = runState('w-start', chain(), 'success', {
      a: 'success',
      b: 'success',
    });
    drawer.update();
    expect(win?.callCount('getWorkflowScriptLog')).toBe(3);
    drawer.close();
  });

  it('opens the logs window on the script and closes', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'success', { a: 'success', b: 'success' }),
    );
    drawer.open('front::deps');
    q('[aria-label="Abrir en la ventana de logs"]').click();
    expect(win?.argsFor('openWorkflowLog')).toEqual([['w-start', DEPS]]);
    q('[aria-label="Cerrar log"]').click();
    expect(drawer.isOpen()).toBe(false);
    expect(toggles).toEqual([true, false]);
  });

  it('stays empty without a run, and survives a failed read', async () => {
    const drawer = await mount(null);
    drawer.open(null);
    expect(document.querySelectorAll('.wf-log-tab')).toHaveLength(0);
    expect(win?.callCount('getWorkflowScriptLog')).toBe(0);
    run = runState('w-start', chain(), 'error', { a: 'error' });
    drawer.update();
    await win?.fail('getWorkflowScriptLog', new Error('gone'));
    expect(document.querySelectorAll('.wf-log-line')).toHaveLength(0);
  });
});
