// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import { PIPELINE_LOG_GROUP_ID } from '../src/pipeline-labels.js';
import type { LogListGroup, LogListItem } from '../src/ipc-contract.js';

/**
 * `renderer/logs/sidebar-rows.ts` is the controls the tree is made of. What it
 * pins is the split between BUILDING and PAINTING: the tree is rebuilt only
 * when its shape changes, so anything that can change without the shape
 * changing — counters, dots, clocks, names, icons — has to arrive through a
 * paint function, or an open window keeps showing what the config said an hour
 * ago.
 *
 * The counter buttons open scopes through the real `scope.ts`, so what a press
 * is asserted by is the read it makes of main.
 */
type RowsModule = typeof import('../renderer/logs/sidebar-rows.js');
type ViewModule = typeof import('../renderer/logs/view.js');

function item(overrides: Partial<LogListItem> = {}): LogListItem {
  return {
    id: 'api',
    type: 'command',
    name: 'api',
    icon: null,
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

function group(overrides: Partial<LogListGroup> = {}): LogListGroup {
  return {
    groupId: 'g1',
    groupName: 'Back',
    groupIcon: '',
    items: [item()],
    ...overrides,
  };
}

describe('renderer/logs/sidebar-rows.ts', () => {
  let rows: RowsModule;
  let view: ViewModule;
  let dom: LogsDom;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0));
    dom = mountLogsDom({
      api: {
        getLogs: () =>
          Promise.resolve({
            target: { kind: 'unknown', group: null, target: { name: '?' } },
            lines: [],
            logLimit: 100,
            seq: 0,
            commandState: { status: 'stopped', startedAt: null },
          }),
        getMergedLogs: () =>
          Promise.resolve({
            groupName: 'Back',
            sources: [],
            lines: [],
            seqs: {},
          }),
      },
    });
    rows = await import('../renderer/logs/sidebar-rows.js');
    view = await import('../renderer/logs/view.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mount(node: HTMLElement): HTMLElement {
    document.body.appendChild(node);
    return node;
  }

  function badgeLabels(host: HTMLElement | null): string[] {
    return Array.from(host?.children ?? [], (el) => el.textContent ?? '');
  }

  describe('a service row', () => {
    function buildRow(shown: LogListItem): HTMLElement {
      const box = mount(rows.buildGroupRow(group({ items: [shown] })));
      const row = box.getElementsByClassName('side-item')[0] as HTMLElement;
      return row;
    }

    it('shows the name, and repeats it where the controls need it', () => {
      const row = buildRow(item({ name: 'api gateway' }));
      const name = row.getElementsByClassName('s-name')[0] as HTMLElement;
      expect(name.textContent).toBe('api gateway');
      expect(name.title).toBe('api gateway');
      const open = row.getElementsByClassName('s-open')[0] as HTMLElement;
      expect(open.getAttribute('aria-label')).toBe(
        'Ver los logs de api gateway',
      );
    });

    it('falls back to an icon for the kind of thing it is', () => {
      const icon = (shown: LogListItem): string =>
        buildRow(shown).getElementsByClassName('s-ico')[0]?.textContent ?? '';
      expect(icon(item({ icon: '🚀' }))).toBe('🚀');
      expect(icon(item({ icon: null, type: 'command' }))).toBe('⚙️');
      expect(icon(item({ icon: null, type: 'action' }))).toBe('⚡️');
      expect(icon(item({ icon: null, type: 'prescript' }))).toBe('🧪');
      expect(icon(item({ icon: null, type: 'pipeline' }))).toBe('🧩');
    });

    it('colours the dot by the loudest thing the service has to say', () => {
      const dot = (shown: LogListItem): string =>
        buildRow(shown).getElementsByClassName('dot')[0]?.className ?? '';
      expect(dot(item({ status: 'running' }))).toBe('dot running');
      expect(dot(item({ status: 'running', warnCount: 1 }))).toBe('dot warn');
      expect(
        dot(item({ status: 'running', errorCount: 1, warnCount: 9 })),
      ).toBe('dot error');
      expect(dot(item({ status: 'stopped', errorCount: 3 }))).toBe('dot');
    });

    it('counts the lines when there is nothing louder to show', () => {
      const row = buildRow(item({ lineCount: 42 }));
      expect(
        badgeLabels(row.getElementsByClassName('s-badges')[0] as HTMLElement),
      ).toEqual(['42 líneas']);
    });

    it('shows the warn and error counters, and the clock, instead', () => {
      const row = buildRow(
        item({
          warnCount: 2,
          errorCount: 1,
          lineCount: 99,
          status: 'running',
          startedAt: Date.now() - 5000,
        }),
      );
      expect(
        badgeLabels(row.getElementsByClassName('s-badges')[0] as HTMLElement),
      ).toEqual(['⚠ 2', '⛔ 1', '⏱ 5s']);
    });

    it('marks a live clock apart from a finished one', () => {
      const clock = (shown: LogListItem): HTMLElement =>
        buildRow(shown).getElementsByClassName('b time')[0] as HTMLElement;
      const live = clock(
        item({ status: 'running', startedAt: Date.now() - 1000 }),
      );
      expect(live.className).toBe('b time live');
      expect(live.title).toBe('Tiempo en ejecución');
      const past = clock(
        item({ status: 'stopped', startedAt: 1000, lastFinishedAt: 3000 }),
      );
      expect(past.className).toBe('b time');
      expect(past.title).toBe('Duración de la última ejecución');
    });

    it('offers to stop what is running and to start what is not', () => {
      const running = buildRow(
        item({ status: 'running', startedAt: Date.now() }),
      );
      const run = running.getElementsByClassName('s-run')[0] as HTMLElement;
      expect(run.textContent).toBe('■');
      expect(run.title).toBe('Parar');
      expect(run.classList.contains('on')).toBe(true);

      const stopped = buildRow(item({ status: 'stopped' }));
      const idle = stopped.getElementsByClassName('s-run')[0] as HTMLElement;
      expect(idle.textContent).toBe('▶');
      expect(idle.classList.contains('on')).toBe(false);
    });

    it('hides the run control for something the window cannot launch', () => {
      const row = buildRow(item({ type: 'prescript' }));
      const run = row.getElementsByClassName('s-run')[0] as HTMLElement;
      expect(run.style.display).toBe('none');
    });

    it('marks the row the window is actually showing', () => {
      view.view.processId = 'api';
      const row = buildRow(item({ id: 'api' }));
      expect(row.classList.contains('active')).toBe(true);
      const other = buildRow(item({ id: 'web' }));
      expect(other.classList.contains('active')).toBe(false);
    });

    it('opens that service when the row is pressed', () => {
      const row = buildRow(item({ id: 'g1:web' }));
      (row.getElementsByClassName('s-open')[0] as HTMLElement).click();
      expect(dom.argsFor('getLogs')).toEqual([['g1:web']]);
    });

    it('the run control acts without opening the row underneath it', () => {
      view.view.sideData = [group({ items: [item({ status: 'stopped' })] })];
      const row = buildRow(item({ status: 'stopped' }));
      (row.getElementsByClassName('s-run')[0] as HTMLElement).click();
      expect(dom.argsFor('startProcess')).toEqual([['api']]);
      expect(dom.argsFor('getLogs')).toEqual([]);
    });

    it('the run control resolves the CURRENT state, not the painted one', () => {
      // Rows are repainted in place, so the row was very likely built while
      // the service was still stopped.
      const row = buildRow(item({ status: 'stopped' }));
      view.view.sideData = [
        group({
          items: [item({ status: 'running', startedAt: Date.now() })],
        }),
      ];
      (row.getElementsByClassName('s-run')[0] as HTMLElement).click();
      expect(dom.argsFor('stopProcess')).toEqual([['api']]);
    });

    it('a counter opens that service already pinned to its level', () => {
      const row = buildRow(item({ id: 'g1:api', warnCount: 3, errorCount: 2 }));
      const badges = row.getElementsByClassName('s-badges')[0] as HTMLElement;
      (badges.children[1] as HTMLElement).click();
      expect(dom.argsFor('getLogs')).toEqual([['g1:api']]);
      expect([...view.view.levelFilter]).toEqual(['error']);
    });

    it('names in the counter tooltip what pressing it will show', () => {
      const row = buildRow(item({ name: 'api', warnCount: 3, errorCount: 2 }));
      const badges = row.getElementsByClassName('s-badges')[0] as HTMLElement;
      expect((badges.children[0] as HTMLElement).title).toBe(
        'Ver los 3 warning(s) de api',
      );
      expect((badges.children[1] as HTMLElement).title).toBe(
        'Ver los 2 error(es) de api',
      );
    });

    it('keeps the counter buttons alive across a repaint that changed nothing', () => {
      // They are BUTTONS, and this runs on the one-second tick: replacing one
      // between mousedown and mouseup means the click never fires.
      const shown = item({ warnCount: 1 });
      const row = buildRow(shown);
      const badges = row.getElementsByClassName('s-badges')[0] as HTMLElement;
      const button = badges.children[0];
      rows.paintSideItem(row, shown);
      expect(badges.children[0]).toBe(button);
    });

    it('rebuilds them when the tooltip they spell out would go stale', () => {
      const row = buildRow(item({ warnCount: 1 }));
      const badges = row.getElementsByClassName('s-badges')[0] as HTMLElement;
      const button = badges.children[0];
      rows.paintSideItem(row, item({ warnCount: 1, name: 'renombrado' }));
      expect(badges.children[0]).not.toBe(button);
      expect((badges.children[0] as HTMLElement).title).toBe(
        'Ver los 1 warning(s) de renombrado',
      );
    });

    it('a rename in the config reaches an open window through the paint', () => {
      const row = buildRow(item({ name: 'api' }));
      rows.paintSideItem(row, item({ name: 'api gateway', icon: '🚀' }));
      expect(row.getElementsByClassName('s-name')[0]?.textContent).toBe(
        'api gateway',
      );
      expect(row.getElementsByClassName('s-ico')[0]?.textContent).toBe('🚀');
    });
  });

  describe('a group header', () => {
    it('remembers whether it was left open', () => {
      localStorage.setItem('devbar.logs.group.g1', 'closed');
      const details = mount(rows.buildGroupRow(group())) as HTMLDetailsElement;
      expect(details.open).toBe(false);
    });

    it('starts open for a group nobody has folded yet', () => {
      const details = mount(rows.buildGroupRow(group())) as HTMLDetailsElement;
      expect(details.open).toBe(true);
    });

    it('writes down what the reader did with it', () => {
      const details = mount(rows.buildGroupRow(group())) as HTMLDetailsElement;
      details.open = false;
      details.dispatchEvent(new Event('toggle'));
      expect(localStorage.getItem('devbar.logs.group.g1')).toBe('closed');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      expect(localStorage.getItem('devbar.logs.group.g1')).toBe('open');
    });

    it('falls back to a folder when the group set no icon', () => {
      const plain = mount(rows.buildGroupRow(group({ groupIcon: '' })));
      expect(plain.getElementsByClassName('g-ico')[0]?.textContent).toBe('📁');
      const custom = mount(rows.buildGroupRow(group({ groupIcon: '🐍' })));
      expect(custom.getElementsByClassName('g-ico')[0]?.textContent).toBe('🐍');
    });

    it('lists one row per service inside it', () => {
      const details = mount(
        rows.buildGroupRow(
          group({ items: [item({ id: 'a' }), item({ id: 'b' })] }),
        ),
      );
      expect(details.getElementsByClassName('side-item')).toHaveLength(2);
      expect(details.getElementsByClassName('side-items')).toHaveLength(1);
    });

    it('rolls the worst state among its services up to the header', () => {
      // A failing service cannot hide behind a folded header.
      const details = mount(
        rows.buildGroupRow(
          group({
            items: [
              item({ id: 'a', status: 'running' }),
              item({ id: 'b', status: 'running', errorCount: 1 }),
            ],
          }),
        ),
      );
      const dot = details.getElementsByClassName('g-dot')[0] as HTMLElement;
      expect(dot.className).toBe('g-dot error');
      expect(dot.title).toBe('Estado del grupo: error');
    });

    it('leaves the rollup blank when nothing inside is running', () => {
      const details = mount(rows.buildGroupRow(group()));
      const dot = details.getElementsByClassName('g-dot')[0] as HTMLElement;
      expect(dot.className).toBe('g-dot');
      expect(dot.title).toBe('');
    });

    it('adds up the warnings and errors of everything inside', () => {
      const details = mount(
        rows.buildGroupRow(
          group({
            items: [
              item({ id: 'a', warnCount: 2, errorCount: 1 }),
              item({ id: 'b', warnCount: 3 }),
            ],
          }),
        ),
      );
      expect(
        badgeLabels(
          details.getElementsByClassName('g-badges')[0] as HTMLElement,
        ),
      ).toEqual(['⚠ 5', '⛔ 1']);
    });

    it('a group total opens the merged view already pinned to that level', () => {
      const details = mount(
        rows.buildGroupRow(group({ items: [item({ errorCount: 4 })] })),
      );
      const host = details.getElementsByClassName('g-badges')[0] as HTMLElement;
      (host.children[0] as HTMLElement).click();
      expect(dom.argsFor('getMergedLogs')).toEqual([['g1']]);
      expect([...view.view.levelFilter]).toEqual(['error']);
    });

    it('the 📜 control opens the whole group, without folding the header', () => {
      const details = mount(rows.buildGroupRow(group())) as HTMLDetailsElement;
      const all = details.getElementsByClassName('g-all')[0] as HTMLElement;
      expect(all.title).toBe('Ver todos los logs de Back juntos');
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      all.dispatchEvent(event);
      expect(dom.argsFor('getMergedLogs')).toEqual([['g1']]);
      expect(event.defaultPrevented).toBe(true);
    });

    it('a rename reaches an open window through the paint', () => {
      // The id does not change, so the tree is never rebuilt for a rename.
      const details = mount(rows.buildGroupRow(group()));
      rows.paintGroupSummary(details, group({ groupName: 'Backend' }));
      expect(details.getElementsByClassName('g-name')[0]?.textContent).toBe(
        'Backend',
      );
      expect(
        (details.getElementsByClassName('g-all')[0] as HTMLElement).title,
      ).toBe('Ver todos los logs de Backend juntos');
    });

    it('keeps the total buttons alive across a repaint that changed nothing', () => {
      const shape = group({ items: [item({ warnCount: 1 })] });
      const details = mount(rows.buildGroupRow(shape));
      const host = details.getElementsByClassName('g-badges')[0] as HTMLElement;
      const button = host.children[0];
      rows.paintGroupSummary(details, shape);
      expect(host.children[0]).toBe(button);
    });

    it('survives a header that has no badge host to paint into', () => {
      const bare = document.createElement('div');
      bare.className = 'side-group';
      expect(() => rows.paintGroupSummary(bare, group())).not.toThrow();
    });
  });

  describe('the pipeline row', () => {
    const pipeline = (): LogListGroup =>
      group({
        groupId: PIPELINE_LOG_GROUP_ID,
        groupName: 'Pipeline',
        groupIcon: '',
      });

    it('marks itself as the cross-cutting view it is', () => {
      const details = mount(rows.buildPipelineRow(pipeline()));
      expect(details.getElementsByClassName('g-ico')[0]?.textContent).toBe(
        '🧬',
      );
    });

    it('renders no per-run children to expand into', () => {
      // With a single run the bucket and its one child showed the same thing.
      const details = mount(rows.buildPipelineRow(pipeline()));
      expect(details.getElementsByClassName('side-item')).toHaveLength(0);
      expect(details.getElementsByClassName('chevron')).toHaveLength(0);
    });

    it('opens the merged pipeline view from anywhere on the row', () => {
      const details = mount(rows.buildPipelineRow(pipeline()));
      const summary = details.querySelector('summary') as HTMLElement;
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      summary.dispatchEvent(event);
      expect(dom.argsFor('getMergedLogs')).toEqual([[PIPELINE_LOG_GROUP_ID]]);
      // Otherwise the native <details> toggle would fold it instead.
      expect(event.defaultPrevented).toBe(true);
    });

    it('carries its opener label on the summary, having no 📜 control', () => {
      const details = mount(rows.buildPipelineRow(pipeline()));
      const summary = details.querySelector('summary') as HTMLElement;
      expect(summary.title).toBe('Ver todos los logs de Pipeline juntos');
    });
  });

  describe('the root row', () => {
    it('says what it is and what it opens', () => {
      const row = mount(rows.buildAllRow());
      expect(row.getElementsByClassName('a-name')[0]?.textContent).toBe('Todo');
      expect(row.title).toBe('Todos los logs de todos los grupos');
      row.click();
      expect(dom.argsFor('getMergedLogs')).toEqual([[null]]);
    });

    it('marks itself while the everything view is on screen', () => {
      view.view.mergedIsAll = true;
      expect(mount(rows.buildAllRow()).classList.contains('active')).toBe(true);
      view.view.mergedIsAll = false;
      expect(mount(rows.buildAllRow()).classList.contains('active')).toBe(
        false,
      );
    });

    it('adds up the warnings and errors of every group there is', () => {
      view.view.sideData = [
        group({ groupId: 'g1', items: [item({ warnCount: 2 })] }),
        group({
          groupId: 'g2',
          items: [item({ warnCount: 1, errorCount: 4 })],
        }),
      ];
      const row = mount(rows.buildAllRow());
      expect(
        badgeLabels(row.getElementsByClassName('a-badges')[0] as HTMLElement),
      ).toEqual(['⚠ 3', '⛔ 4']);
    });

    it('shows nothing at all when everything is quiet', () => {
      view.view.sideData = [group()];
      const row = mount(rows.buildAllRow());
      expect(
        badgeLabels(row.getElementsByClassName('a-badges')[0] as HTMLElement),
      ).toEqual([]);
    });

    it('a total opens the everything view already pinned to that level', () => {
      view.view.sideData = [group({ items: [item({ warnCount: 7 })] })];
      const row = mount(rows.buildAllRow());
      const host = row.getElementsByClassName('a-badges')[0] as HTMLElement;
      expect((host.children[0] as HTMLElement).title).toBe(
        'Ver los 7 warning(s) de todo',
      );
      (host.children[0] as HTMLElement).click();
      expect(dom.argsFor('getMergedLogs')).toEqual([[null]]);
      expect([...view.view.levelFilter]).toEqual(['warn']);
    });

    it('keeps the total buttons alive across a repaint that changed nothing', () => {
      view.view.sideData = [group({ items: [item({ errorCount: 1 })] })];
      const row = mount(rows.buildAllRow());
      const host = row.getElementsByClassName('a-badges')[0] as HTMLElement;
      const button = host.children[0];
      rows.paintAllRow(row);
      expect(host.children[0]).toBe(button);
    });

    it('survives a root row that has no badge host to paint into', () => {
      const bare = document.createElement('div');
      expect(() => rows.paintAllRow(bare)).not.toThrow();
    });
  });
});
