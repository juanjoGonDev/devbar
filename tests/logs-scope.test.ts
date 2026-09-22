// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  entry,
  mountLogsDom,
  scrolledIntoView,
  type LogsDom,
  type MountLogsOptions,
} from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';
import type { LogSource } from '../src/ipc-contract.js';

/**
 * `renderer/logs/scope.ts` is the one way in for all three scopes — one
 * service, one group merged, everything merged — so the level pin, the buffer
 * reset and the sidebar highlight behave identically whichever control was
 * pressed. It also owns the load ticket that keeps a superseded snapshot from
 * being appended to a buffer it no longer owns.
 */
type ScopeModule = typeof import('../renderer/logs/scope.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');
type BufferModule = typeof import('../renderer/logs/buffer.js');

function snapshot(
  overrides: {
    lines?: LogEntry[];
    logLimit?: number;
    seq?: number;
    startedAt?: number | null;
    target?: unknown;
  } = {},
): unknown {
  return {
    target: overrides.target ?? {
      kind: 'command',
      group: { id: 'g1', name: 'Back' },
      target: {
        id: 'c1',
        name: 'api',
        silencedPatterns: { warn: [], error: [] },
      },
    },
    lines: overrides.lines ?? [],
    logLimit: overrides.logLimit ?? 5000,
    seq: overrides.seq ?? 0,
    commandState: { status: 'running', startedAt: overrides.startedAt ?? 100 },
  };
}

function merged(sources: LogSource[] = [], lines: LogEntry[] = []): unknown {
  return { groupName: 'Back', sources, lines, seqs: {} };
}

function source(id: string, name = id): LogSource {
  return { id, name, groupId: 'g1', groupName: 'Back' };
}

describe('renderer/logs/scope.ts', () => {
  let scope: ScopeModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let buffer: BufferModule;
  let dom: LogsDom;

  async function open(options: MountLogsOptions = {}): Promise<void> {
    dom = mountLogsDom({
      search: options.search,
      api: {
        getLogs: () => Promise.resolve(snapshot()),
        getMergedLogs: () => Promise.resolve(merged()),
        ...(options.api ?? {}),
      },
    });
    scope = await import('../renderer/logs/scope.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
    buffer = await import('../renderer/logs/buffer.js');
  }

  /** The sidebar rows `markMergedInSidebar` and `selectLog` repaint. */
  function buildSidebar(): void {
    elements.sideTreeEl.innerHTML = [
      '<button class="side-all"></button>',
      '<details class="side-group" data-group-id="g1">',
      '<div class="side-item" data-id="api"></div>',
      '<div class="side-item" data-id="web"></div>',
      '</details>',
      '<details class="side-group" data-group-id="g2"></details>',
    ].join('');
  }

  function activeItems(): string[] {
    return Array.from(
      elements.sideTreeEl.getElementsByClassName('side-item'),
    ).flatMap((row) =>
      row.classList.contains('active')
        ? [(row as HTMLElement).dataset.id ?? '']
        : [],
    );
  }

  function viewingGroups(): string[] {
    return Array.from(
      elements.sideTreeEl.getElementsByClassName('side-group'),
    ).flatMap((row) =>
      row.classList.contains('viewing')
        ? [(row as HTMLElement).dataset.groupId ?? '']
        : [],
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await open();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('openScope', () => {
    it('routes a single service through selectLog', async () => {
      await scope.openScope({ kind: 'single', processId: 'api' });
      expect(dom.argsFor('getLogs')).toEqual([['api']]);
      expect(view.view.processId).toBe('api');
    });

    it('routes a group through the merged read', async () => {
      await scope.openScope({ kind: 'group', groupId: 'g1' });
      expect(dom.argsFor('getMergedLogs')).toEqual([['g1']]);
      expect(view.view.mergedGroupId).toBe('g1');
      expect(view.view.mergedIsAll).toBe(false);
    });

    it('routes "everything" through the same read with no group', async () => {
      await scope.openScope({ kind: 'all' });
      expect(dom.argsFor('getMergedLogs')).toEqual([[null]]);
      expect(view.view.mergedIsAll).toBe(true);
    });

    it('pins the levels the caller asked for, before anything is drawn', async () => {
      await scope.openScope({ kind: 'all' }, ['warn', 'error']);
      expect([...view.view.levelFilter]).toEqual(['warn', 'error']);
      expect(elements.levelPillEl.hidden).toBe(false);
    });

    it('a scope opened without levels shows everything', async () => {
      await scope.openScope({ kind: 'all' }, ['warn']);
      await scope.openScope({ kind: 'all' });
      expect([...view.view.levelFilter]).toEqual([]);
      expect(elements.levelPillEl.hidden).toBe(true);
    });
  });

  describe('selectLog', () => {
    it("adopts main's answer: the lines, the cap and the run it belongs to", async () => {
      await open({
        api: {
          getLogs: () =>
            Promise.resolve(
              snapshot({
                lines: [entry('uno'), entry('dos')],
                logLimit: 77,
                startedAt: 4242,
              }),
            ),
        },
      });
      await scope.selectLog('api');
      expect(buffer.buffer.entries.map((line) => line.line)).toEqual([
        'uno',
        'dos',
      ]);
      // Whatever main kept for it, not what the setting says now.
      expect(view.view.memoryCap).toBe(77);
      expect(view.view.watchedStartedAt).toBe(4242);
    });

    it('names what is on screen from the resolved target', async () => {
      await scope.selectLog('api');
      expect(view.view.displayName).toBe('api');
      expect(view.view.groupName).toBe('Back');
      expect(view.view.currentGroupId).toBe('g1');
      expect(view.view.currentCommandId).toBe('c1');
    });

    it('falls back to the raw id when main cannot resolve the target', async () => {
      await open({
        api: {
          getLogs: () =>
            Promise.resolve(
              snapshot({
                target: { kind: 'unknown', group: null, target: { name: '?' } },
              }),
            ),
        },
      });
      await scope.selectLog('g1:huérfano');
      expect(view.view.displayName).toBe('g1:huérfano');
      expect(view.view.groupName).toBe('');
    });

    it('leaves the silence ids unset for a target that is not a command', async () => {
      await open({
        api: {
          getLogs: () =>
            Promise.resolve(
              snapshot({
                target: {
                  kind: 'action',
                  group: { id: 'g1', name: 'Back' },
                  target: { id: 'a1', name: 'deploy' },
                },
              }),
            ),
        },
      });
      await scope.selectLog('g1:a1');
      expect(view.view.displayName).toBe('deploy');
      expect(view.view.currentCommandId).toBeNull();
    });

    it('drops whatever the merged view was holding', async () => {
      await scope.openScope({ kind: 'all' });
      await scope.selectLog('api');
      expect(view.view.groupSources).toBeNull();
      expect(view.view.mergedGroupId).toBeNull();
      expect(view.view.mergedIsAll).toBe(false);
    });

    it('pre-fills the search box when the entry point carried one', async () => {
      await scope.selectLog('api', 'fallo');
      expect(elements.filterEl.value).toBe('fallo');
    });

    it('clears a stale search box when the entry point carried only a level', async () => {
      // A severity entry point pins the chip; a leftover text filter would
      // hide the very entries the counter stands for.
      elements.filterEl.value = 'viejo';
      await scope.selectLog('api', undefined, 'warn');
      expect(elements.filterEl.value).toBe('');
      expect([...view.view.levelFilter]).toEqual(['warn']);
    });

    it('keeps whatever is on screen for a plain switch', async () => {
      elements.filterEl.value = 'mío';
      await scope.selectLog('api');
      expect(elements.filterEl.value).toBe('mío');
      expect(view.view.filterRe?.source).toBe('mío');
    });

    it('marks the row it opened, and only that one', async () => {
      buildSidebar();
      await scope.selectLog('api');
      expect(activeItems()).toEqual(['api']);
      await scope.selectLog('web');
      expect(activeItems()).toEqual(['web']);
    });

    it('leaves the sidebar alone in a detached window, which has none', async () => {
      await open({ search: '?detached=1' });
      buildSidebar();
      await scope.selectLog('api');
      expect(activeItems()).toEqual([]);
    });

    it('drops the answer of a load a newer one superseded', async () => {
      const answers: ((value: unknown) => void)[] = [];
      await open({
        api: {
          getLogs: (id: string) =>
            new Promise((resolve) => {
              answers.push(() =>
                resolve(snapshot({ lines: [entry(`de ${id}`)] })),
              );
            }),
        },
      });
      const first = scope.selectLog('api');
      const second = scope.selectLog('web');
      answers[1]?.(undefined); // the newer one answers first
      answers[0]?.(undefined); // the older one arrives late
      await Promise.all([first, second]);
      expect(buffer.buffer.entries.map((line) => line.line)).toEqual([
        'de web',
      ]);
    });
  });

  describe('a merged scope', () => {
    it('drops the answer of a merged load a newer one superseded', async () => {
      // Identity alone cannot detect a lost race here: two overlapping loads
      // of the SAME scope would both pass an identity check and each append
      // its own snapshot.
      const answers: ((value: unknown) => void)[] = [];
      await open({
        api: {
          getMergedLogs: (groupId: string | null) =>
            new Promise((resolve) => {
              answers.push(() =>
                resolve(merged([], [entry(`de ${groupId ?? 'todo'}`)])),
              );
            }),
        },
      });
      const first = scope.openScope({ kind: 'group', groupId: 'g1' });
      const second = scope.openScope({ kind: 'all' });
      answers[1]?.(undefined); // the newer one answers first
      answers[0]?.(undefined); // the older one arrives late
      await Promise.all([first, second]);
      expect(buffer.buffer.entries.map((line) => line.line)).toEqual([
        'de todo',
      ]);
      expect(elements.titleEl.textContent).toBe('Telemetría');
    });

    it('titles the window after the group it merged', async () => {
      await scope.openScope({ kind: 'group', groupId: 'g1' });
      expect(elements.titleEl.textContent).toBe('Logs — Back · todos');
      expect(document.title).toBe('Logs — Back · todos');
    });

    it('calls the everything view what it is', async () => {
      await scope.openScope({ kind: 'all' });
      expect(elements.titleEl.textContent).toBe('Telemetría');
    });

    it('keeps the sources so a row can name where it came from', async () => {
      await open({
        api: {
          getMergedLogs: () =>
            Promise.resolve(merged([source('api', 'Api')], [entry('hola')])),
        },
      });
      await scope.openScope({ kind: 'all' });
      expect(view.view.groupSources?.get('api')?.name).toBe('Api');
    });

    it('puts away the controls that only mean something for one service', async () => {
      elements.uptimeBadgeEl.classList.add('visible');
      await scope.openScope({ kind: 'all' });
      expect(elements.uptimeBadgeEl.classList.contains('visible')).toBe(false);
      expect(elements.runBtn.style.display).toBe('none');
      expect(view.view.currentCommandId).toBeNull();
      expect(elements.drawerEl.hidden).toBe(true);
    });

    it('caps a merged snapshot globally, since no single run owns it', async () => {
      view.view.globalRetention = 1234;
      await scope.openScope({ kind: 'all' });
      expect(view.view.memoryCap).toBe(1234);
    });

    it('marks the group it is showing, and unmarks the services', async () => {
      buildSidebar();
      await scope.selectLog('api');
      await scope.openScope({ kind: 'group', groupId: 'g1' });
      expect(activeItems()).toEqual([]);
      expect(viewingGroups()).toEqual(['g1']);
    });

    it('marks the root row for the everything view', async () => {
      buildSidebar();
      await scope.openScope({ kind: 'all' });
      const all = elements.sideTreeEl.getElementsByClassName('side-all')[0];
      expect(all?.classList.contains('active')).toBe(true);
      expect(viewingGroups()).toEqual([]);
    });
  });

  describe('jumpToLine', () => {
    it('lands on the same line in that service and stops following the tail', async () => {
      await open({
        api: {
          getLogs: () =>
            Promise.resolve(
              snapshot({
                lines: [
                  entry('antes', { ts: 1 }),
                  entry('la buscada', { ts: 2 }),
                ],
              }),
            ),
        },
      });
      elements.autoscrollEl.checked = true;
      await scope.jumpToLine('api', 2);
      expect(elements.autoscrollEl.checked).toBe(false);
      expect((scrolledIntoView[0] as HTMLElement).dataset.line).toBe(
        'la buscada',
      );
    });

    it('does nothing more than the switch when the line is no longer held', async () => {
      await scope.jumpToLine('api', 999);
      expect(view.view.processId).toBe('api');
      expect(scrolledIntoView).toEqual([]);
    });
  });

  describe('syncWatched', () => {
    function listWatched(overrides: {
      startedAt?: number | null;
      logLimit?: number;
    }): void {
      view.view.sideData = [
        {
          groupId: 'g1',
          groupName: 'Back',
          groupIcon: '📁',
          items: [
            {
              id: 'api',
              type: 'command',
              name: 'api',
              icon: null,
              lineCount: 0,
              status: 'running',
              warnCount: 0,
              errorCount: 0,
              startedAt: overrides.startedAt ?? 100,
              lastFinishedAt: null,
              logLimit: overrides.logLimit ?? 5000,
            },
          ],
        },
      ];
    }

    it('does nothing while a merged scope is on screen', () => {
      view.view.processId = null;
      listWatched({});
      scope.syncWatched();
      expect(dom.argsFor('getLogs')).toEqual([]);
    });

    it('does nothing for a service main no longer lists', () => {
      view.view.processId = 'se-fue';
      listWatched({});
      scope.syncWatched();
      expect(dom.argsFor('getLogs')).toEqual([]);
    });

    it('reloads the buffer when the watched process restarted', async () => {
      await scope.selectLog('api'); // startedAt 100
      listWatched({ startedAt: 999 });
      scope.syncWatched();
      await vi.advanceTimersByTimeAsync(0);
      expect(dom.argsFor('getLogs')).toEqual([['api'], ['api']]);
    });

    it('follows a retention change without reloading anything', async () => {
      await scope.selectLog('api');
      listWatched({ logLimit: 42 });
      scope.syncWatched();
      expect(view.view.memoryCap).toBe(42);
      expect(dom.argsFor('getLogs')).toEqual([['api']]);
    });

    it('drops the lines main has already forgotten when the cap shrinks', async () => {
      await open({
        api: {
          getLogs: () =>
            Promise.resolve(
              snapshot({
                lines: Array.from({ length: 400 }, (_, i) =>
                  entry(`line ${i}`, { ts: i }),
                ),
              }),
            ),
        },
      });
      await scope.selectLog('api');
      listWatched({ logLimit: 10 });
      scope.syncWatched();
      // Otherwise the viewer offers lines to the filter and to copy that the
      // process buffer behind it has already dropped.
      expect(buffer.buffer.entries).toHaveLength(10);
    });

    it('keeps the lines that arrived after main read its buffer', async () => {
      // Everything at or below the snapshot's own sequence is already in it:
      // the finished run's lines, and the '▶ start' of the new one.
      await open({
        api: { getLogs: () => Promise.resolve(snapshot({ seq: 5 })) },
      });
      const status = await import('../renderer/logs/status.js');
      await scope.selectLog('api');
      elements.pausedEl.checked = true;
      status.queueWhilePaused(entry('de la corrida vieja', { seq: 1 }));
      status.queueWhilePaused(entry('de la nueva', { seq: 9 }));
      listWatched({ startedAt: 999 });
      scope.syncWatched();
      await vi.advanceTimersByTimeAsync(0);
      expect(status.pendingQueue.map((held) => held.line)).toEqual([
        'de la nueva',
      ]);
    });

    it('abandons a reload whose target left the screen while it was in flight', async () => {
      const answers: ((value: unknown) => void)[] = [];
      await open({
        api: {
          getLogs: () =>
            new Promise((resolve) => {
              const nth = answers.length;
              answers.push(() =>
                resolve(
                  snapshot({ lines: nth === 0 ? [] : [entry('recargada')] }),
                ),
              );
            }),
        },
      });
      const opening = scope.selectLog('api');
      answers[0]?.(undefined);
      await opening;
      view.view.sideData = [];
      listWatched({ startedAt: 999 });
      scope.syncWatched();
      view.view.processId = 'otro'; // the view moved on mid-reload
      answers[1]?.(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(buffer.buffer.entries).toEqual([]);
    });
  });
});
