// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../src/domain-types.js';
import type { LogsSnapshot } from '../src/ipc-contract.js';

/**
 * `renderer/log-view/` is the logs window's engine made instantiable: a view
 * of its own, given its elements, fed by `getLogs` and `logs:line` pushes.
 * The logs window's suites cover the engine through the window's instance;
 * these cover what only a second instance can show — that it keeps its own
 * state — and the single-process load it adds.
 */
type LogViewModule = typeof import('../renderer/log-view/log-view.js');

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: text, ...extra };
}

function snapshot(lines: LogEntry[], seq = lines.length): LogsSnapshot {
  return {
    target: { kind: 'unknown', group: null, target: { name: '?' } },
    lines: lines.map((entry, i) => ({ seq: i + 1, ...entry })),
    logLimit: 500,
    seq,
    commandState: { status: 'running', startedAt: 1 },
  };
}

describe('renderer/log-view/log-view.ts', () => {
  let mod: LogViewModule;
  let answers: Map<string, (value: LogsSnapshot) => void>;

  beforeEach(async () => {
    document.body.innerHTML = '';
    answers = new Map();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getLogs: vi.fn(
          (id: string) =>
            new Promise<LogsSnapshot>((resolve) => answers.set(id, resolve)),
        ),
      },
    });
    vi.resetModules();
    mod = await import('../renderer/log-view/log-view.js');
  });

  function mount() {
    const main = document.createElement('div');
    const lines = document.createElement('div');
    main.appendChild(lines);
    document.body.appendChild(main);
    const view = mod.createLogView({ lines, main, scrollButton: null });
    const texts = (): string[] =>
      Array.from(
        lines.querySelectorAll('.line:not(.folded)'),
        (row) => row.querySelector('.body')?.textContent ?? '',
      );
    return { view, lines, texts };
  }

  async function answer(id: string, value: LogsSnapshot): Promise<void> {
    answers.get(id)?.(value);
    await Promise.resolve();
    await Promise.resolve();
  }

  it('keeps its own lines and stack blocks: two views never touch each other', async () => {
    const one = mount();
    const two = mount();
    const opening = [one.view.open('pre:g:a'), two.view.open('pre:g:b')];
    await answer(
      'pre:g:a',
      snapshot([
        line('Error: boom', { level: 'error' }),
        line('    at a (x:1)'),
      ]),
    );
    await answer('pre:g:b', snapshot([line('otra cosa')]));
    expect(await Promise.all(opening)).toEqual([true, true]);
    expect(one.texts()).toEqual(['Error: boom', '    at a (x:1)']);
    expect(two.texts()).toEqual(['otra cosa']);
    expect(one.view.state.memoryCap).toBe(500);
    expect(two.view.buffer).not.toBe(one.view.buffer);
  });

  it('takes the live lines of its own process only, each once', async () => {
    const { view, texts } = mount();
    const opened = view.open('pre:g:a');
    view.receivePush({ id: 'pre:g:a', entry: line('dos', { seq: 2 }) });
    await answer('pre:g:a', snapshot([line('uno'), line('dos')]));
    await opened;
    view.receivePush({ id: 'pre:g:a', entry: line('tres', { seq: 3 }) });
    view.receivePush({ id: 'pre:g:b', entry: line('ajena', { seq: 4 }) });
    expect(texts()).toEqual(['uno', 'dos', 'tres']);
  });

  it('reloads the process already shown in place, without emptying first', async () => {
    const { view, texts } = mount();
    const first = view.open('pre:g:a');
    await answer('pre:g:a', snapshot([line('run 1')]));
    await first;
    const second = view.open('pre:g:a');
    expect(texts()).toEqual(['run 1']); // still there while the new run loads
    await answer('pre:g:a', snapshot([line('run 2')], 7));
    expect(await second).toBe(true);
    expect(texts()).toEqual(['run 2']);
  });

  it('keeps a line held for a reload that a failed reload superseded', async () => {
    const calls: {
      resolve: (value: LogsSnapshot) => void;
      reject: (error: Error) => void;
    }[] = [];
    Object.assign(window.api, {
      getLogs: () =>
        new Promise<LogsSnapshot>((resolve, reject) =>
          calls.push({ resolve, reject }),
        ),
    });
    const { view, texts } = mount();
    const first = view.open('pre:g:a');
    calls[0]?.resolve(snapshot([line('uno')]));
    await first;
    const reload = view.open('pre:g:a');
    view.receivePush({ id: 'pre:g:a', entry: line('dos', { seq: 2 }) });
    const newer = view.open('pre:g:a'); // same scope: it takes over «dos»
    calls[2]?.reject(new Error('sin respuesta'));
    expect(await newer).toBe(false);
    calls[1]?.resolve(snapshot([line('uno'), line('dos')]));
    expect(await reload).toBe(false); // superseded: its answer is moot
    expect(texts()).toEqual(['uno', 'dos']);
  });

  it('refolds a stack trace whose first frame the memory cap trimmed away', async () => {
    // Capped at 10 lines, a trim fires at line 311 and keeps the last 10:
    // frames 302–306 of a block whose head (300) and first frame (301) it
    // drops.
    const { view, lines } = mount();
    const opened = view.open('pre:g:a');
    await answer('pre:g:a', { ...snapshot([]), logLimit: 10 });
    await opened;
    for (let seq = 1; seq <= 311; seq += 1) {
      const text =
        seq === 300
          ? 'Error: boom'
          : seq >= 301 && seq <= 306
            ? `    at f (x:${seq})`
            : `línea ${seq}`;
      const level = seq === 300 ? 'error' : null;
      view.receivePush({ id: 'pre:g:a', entry: line(text, { seq, level }) });
    }
    expect(view.buffer.entries).toHaveLength(10);
    // Every frame left still has a way to be shown: none is hidden for good
    // under a fold whose control went with the trimmed frame.
    const fold = lines.querySelector('.stack-fold');
    expect(fold?.textContent ?? 'no fold row').toContain('+4 líneas de stack');
  });

  it('gives up a load in flight once cleared', async () => {
    const { view, texts } = mount();
    const opened = view.open('pre:g:a');
    view.clear();
    await answer('pre:g:a', snapshot([line('tarde')]));
    expect(await opened).toBe(false);
    view.receivePush({ id: 'pre:g:a', entry: line('suelta', { seq: 9 }) });
    expect(texts()).toEqual([]);
  });
});
