// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { chain } from './helpers/pipeline-editor.js';
import { runState } from './helpers/workflows.js';
import {
  createLogDrawer,
  type LogDrawer,
} from '../renderer/workflows/log-drawer.js';
import type { LogEntry } from '../src/domain-types.js';
import type { LogsSnapshot, WorkflowRunState } from '../src/ipc-contract.js';

/**
 * The workflow terminal under the canvas. Its tabs, meta and buttons are its
 * own; its lines are the logs window's engine over the script's own buffer,
 * fed the same way (`getLogs`, then `onLog` pushes) — so these tests drive it
 * through exactly that transport.
 */
const NAMES: Record<string, string> = {
  setup: 'Make setup',
  deps: 'Install deps',
};
const SETUP_ID = 'pre:back:setup';
const DEPS_ID = 'pre:front:deps';

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date(2026, 0, 5, 9, 3, 41).getTime(),
    stream: 'stdout',
    level: null,
    line: text,
    ...extra,
  };
}

/** What `logs:get` answers: the buffer, and the seq it reached. */
function snapshot(lines: LogEntry[], seq = lines.length): LogsSnapshot {
  return {
    target: { kind: 'unknown', group: null, target: { name: '?' } },
    lines: lines.map((entry, i) => ({ seq: i + 1, ...entry })),
    logLimit: 2000,
    seq,
    commandState: { status: 'running', startedAt: 1_000 },
  };
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.wf-log-lines .line')];
}

function texts(): string[] {
  return rows().map((row) => row.querySelector('.body')?.textContent ?? '');
}

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
      onToggle: (open) => toggles.push(open),
    });
  }

  const finished = (): WorkflowRunState =>
    runState('w-start', chain(), 'error', { a: 'success', b: 'error' });

  it('lists one tab per script of the run and reads the chosen one’s buffer', async () => {
    const drawer = await mount(finished());
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
    // The logs window's own snapshot call, on the script's own buffer.
    expect(win?.argsFor('getLogs')).toEqual([[SETUP_ID]]);
  });

  it('draws the lines as the logs window does, coloured from their level', async () => {
    const drawer = await mount(finished());
    drawer.open('front::deps');
    await win?.settle(
      'getLogs',
      snapshot([
        line('\u001b[32mLeyendo perfil\u001b[0m'),
        line('el puerto todavía no responde', { level: 'warn' }),
        line('ECONNREFUSED: error de conexión', { level: 'error' }),
        line('■ exited with code 1', { stream: 'sys' }),
      ]),
    );
    expect(texts()).toEqual([
      'Leyendo perfil',
      'el puerto todavía no responde',
      'ECONNREFUSED: error de conexión',
      '■ exited with code 1',
    ]);
    const [plain, warn, error, sys] = rows();
    expect(plain?.querySelector('.body span')?.getAttribute('style')).toMatch(
      /color/,
    );
    expect(warn?.classList.contains('warn')).toBe(true);
    expect(warn?.querySelector('.lv')?.textContent).toBe('WRN');
    expect(error?.classList.contains('error')).toBe(true);
    expect(sys?.classList.contains('sys')).toBe(true);
    expect(plain?.querySelector('.ts')?.textContent).toBe('09:03:41.000');
    expect(q('.wf-log-meta').textContent).toBe('exit 1 · 3.2s');
  });

  it('guesses no level of its own: the level main stored is the only one', async () => {
    // Main reads a script's level with the shared defaults now; a second
    // guess here is what used to make the two views disagree.
    const drawer = await mount(finished());
    drawer.open('front::deps');
    await win?.settle('getLogs', snapshot([line('TypeError: x is undefined')]));
    expect(rows()[0]?.classList.contains('error')).toBe(false);
  });

  it('folds a stack trace and opens a JSON line, like the logs window', async () => {
    const drawer = await mount(finished());
    drawer.open('front::deps');
    await win?.settle(
      'getLogs',
      snapshot([
        line('Error: boom', { level: 'error' }),
        line('    at a (x:1)'),
        line('    at b (x:2)'),
        line('{"msg":"listo","port":3000}'),
      ]),
    );
    expect(q('.wf-log-lines .stack-fold').textContent).toContain(
      '+2 líneas de stack',
    );
    q('.wf-log-lines .json-toggle').click();
    expect(q('.wf-log-lines .json-pretty').textContent).toContain(
      '"port": 3000',
    );
  });

  it('streams new lines live instead of asking again', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'running', { a: 'running' }),
    );
    drawer.open('back::setup');
    expect(q('.wf-log-meta').textContent).toBe('0:05');
    await win?.settle('getLogs', snapshot([line('uno')]));
    await win?.push('onLog', { id: SETUP_ID, entry: line('dos', { seq: 2 }) });
    await win?.push('onLog', { id: DEPS_ID, entry: line('ajena', { seq: 9 }) });
    expect(texts()).toEqual(['uno', 'dos']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    drawer.update(); // the run ticks on: still the same run of the script
    expect(win?.callCount('getLogs')).toBe(1);
    drawer.close();
  });

  it('keeps a line that arrives while the snapshot is in flight, once', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'running', { a: 'running' }),
    );
    drawer.open('back::setup');
    await win?.push('onLog', { id: SETUP_ID, entry: line('dos', { seq: 2 }) });
    await win?.push('onLog', { id: SETUP_ID, entry: line('tres', { seq: 3 }) });
    // The snapshot reached seq 2: «dos» is in it, «tres» is not.
    await win?.settle('getLogs', snapshot([line('uno'), line('dos')], 2));
    expect(texts()).toEqual(['uno', 'dos', 'tres']);
  });

  it('redraws a progress bar in place instead of adding a line per frame', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'running', { a: 'running' }),
    );
    drawer.open('back::setup');
    await win?.settle('getLogs', snapshot([line('subiendo 10%')]));
    await win?.push('onLog', {
      id: SETUP_ID,
      entry: line('subiendo 60%', { seq: 2, replaces: 1 }),
    });
    expect(texts()).toEqual(['subiendo 60%']);
  });

  it('switches script from its tab', async () => {
    const drawer = await mount(finished());
    drawer.open(null);
    q('.wf-log-tab[data-ref="front::deps"]').click();
    expect(win?.argsFor('getLogs').at(-1)).toEqual([DEPS_ID]);
  });

  it('shows a script still waiting for its turn as such, not its last run', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'running', { a: 'running', b: 'waiting' }),
    );
    drawer.open('front::deps');
    expect(win?.argsFor('getLogs')).toEqual([]);
    expect(rows()).toHaveLength(0);
    expect(q('.wf-log-empty').hidden).toBe(false);
    expect(q('.wf-log-empty').textContent).toBe('Todavía no ha empezado');
  });

  it('reads the script again once it starts, and on each new run of it', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'running', { a: 'running', b: 'waiting' }),
    );
    drawer.open('front::deps');
    run = runState('w-start', chain(), 'running', {
      a: 'success',
      b: 'running',
    });
    drawer.update();
    expect(win?.argsFor('getLogs')).toEqual([[DEPS_ID]]);
    expect(q('.wf-log-empty').hidden).toBe(true);
    await win?.settle('getLogs', snapshot([line('instalando')]));
    // A retry: a new run of the script, so main emptied its buffer.
    run = runState(
      'w-start',
      chain(),
      'running',
      { a: 'success', b: 'running' },
      { runId: 8 },
    );
    run.scripts = run.scripts.map((s) => ({ ...s, startedAt: 9_000 }));
    drawer.update();
    expect(win?.argsFor('getLogs')).toEqual([[DEPS_ID], [DEPS_ID]]);
    await win?.settle('getLogs', snapshot([line('otra vez')]));
    expect(texts()).toEqual(['otra vez']);
  });

  it('shows why a script was turned away before it could start', async () => {
    // Refused (no path, declined…): it never started, but it did reach this
    // run, and the reason is in its own log.
    const state = finished();
    state.scripts = state.scripts.map((s) =>
      s.scriptId === 'deps' ? { ...s, startedAt: null } : s,
    );
    const drawer = await mount(state);
    drawer.open('front::deps');
    expect(win?.argsFor('getLogs')).toEqual([[DEPS_ID]]);
  });

  it('opens the logs window on the script and closes', async () => {
    const drawer = await mount(
      runState('w-start', chain(), 'success', { a: 'success', b: 'success' }),
    );
    drawer.open('front::deps');
    q('[aria-label="Abrir en la ventana de logs"]').click();
    expect(win?.argsFor('openWorkflowLog')).toEqual([
      ['w-start', { groupId: 'front', scriptId: 'deps' }],
    ]);
    q('[aria-label="Cerrar log"]').click();
    expect(drawer.isOpen()).toBe(false);
    expect(toggles).toEqual([true, false]);
  });

  it('stays empty without a run, and survives a failed read', async () => {
    const drawer = await mount(null);
    drawer.open(null);
    expect(document.querySelectorAll('.wf-log-tab')).toHaveLength(0);
    expect(win?.callCount('getLogs')).toBe(0);
    run = runState('w-start', chain(), 'error', { a: 'error' });
    drawer.update();
    await win?.fail('getLogs', new Error('gone'));
    expect(rows()).toHaveLength(0);
  });
});
