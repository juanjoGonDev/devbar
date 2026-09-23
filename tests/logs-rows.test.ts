// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PIPELINE_LOG_GROUP_ID } from '../src/pipeline-labels.js';
import type { LogEntry } from '../src/domain-types.js';
import type {
  LogSource,
  SilenceLevel,
  SourcedLogEntry,
} from '../src/ipc-contract.js';

/**
 * `renderer/logs/rows.ts` builds one line of the log and nothing else — it
 * neither appends nor trims — so it is exercised directly here rather than
 * through the window. What it decides: which classes and data attributes the
 * row carries, which of the two "ways out" (source tags) it grows, and whether
 * the line gets a silence button and what that button does.
 */
type RowsModule = typeof import('../renderer/logs/rows.js');
type ViewModule = typeof import('../renderer/logs/view.js');
type BufferModule = typeof import('../renderer/logs/buffer.js');

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: text, ...extra };
}

function source(id: string, name: string, groupName: string): LogSource {
  return { id, name, groupId: `grp-${groupName}`, groupName };
}

function sourced(
  srcId: string,
  extra: Partial<LogEntry> = {},
): SourcedLogEntry {
  return { ...line('hola', extra), srcId };
}

describe('renderer/logs/rows.ts', () => {
  let rows: RowsModule;
  let viewModule: ViewModule;
  let bufferModule: BufferModule;
  let api: {
    buildSilencePattern: ReturnType<typeof vi.fn>;
    addSilencePattern: ReturnType<typeof vi.fn>;
    removeSilencePattern: ReturnType<typeof vi.fn>;
  };
  let opened: unknown[];
  let jumped: unknown[];

  beforeEach(async () => {
    document.body.innerHTML = '';
    opened = [];
    jumped = [];
    api = {
      buildSilencePattern: vi.fn((text: string) => `re:${text}`),
      addSilencePattern: vi.fn(() => Promise.resolve({ ok: true })),
      removeSilencePattern: vi.fn(() => Promise.resolve({ ok: true })),
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    vi.resetModules();
    rows = await import('../renderer/logs/rows.js');
    viewModule = await import('../renderer/logs/view.js');
    bufferModule = await import('../renderer/logs/buffer.js');
    viewModule.installNav({
      openScope: (scope, levels) => {
        opened.push([scope, levels]);
        return Promise.resolve();
      },
      jumpToLine: (srcId, ts) => {
        jumped.push([srcId, ts]);
        return Promise.resolve();
      },
    });
  });

  /** Build a row with the plumbing every test needs, and hand back both ends. */
  function build(
    entry: LogEntry,
    entryIndex = 0,
  ): { row: HTMLElement; contexted: HTMLElement[] } {
    const contexted: HTMLElement[] = [];
    const row = rows.buildRow(entry, entryIndex, (target) =>
      contexted.push(target),
    );
    document.body.appendChild(row);
    return { row, contexted };
  }

  describe('the row itself', () => {
    it('carries the stream, the level and the silenced mark as classes', () => {
      const { row } = build(
        line('boom', { stream: 'stderr', level: 'error', silenced: true }),
      );
      expect([...row.classList].sort()).toEqual([
        'error',
        'line',
        'silenced',
        'stderr',
      ]);
    });

    it('leaves out the classes a plain stdout line has no business carrying', () => {
      const { row } = build(line('hola'));
      expect([...row.classList]).toEqual(['line', 'stdout']);
    });

    it('stamps the handles the panes index it by', () => {
      const { row } = build(
        line('ojo', { ts: 1234, level: null, originalLevel: 'warn' }),
      );
      expect(row.dataset.line).toBe('ojo');
      expect(row.dataset.ts).toBe('1234');
      expect(row.dataset.eidx).toBe('0');
      expect(row.dataset.originalLevel).toBe('warn');
      // levelOf: a silenced line still counts as the level it came in as.
      expect(row.dataset.level).toBe('warn');
    });

    it('renders the ANSI colour as markup instead of showing the escapes', () => {
      const { row } = build(line('[31mrojo[0m'));
      const body = row.querySelector<HTMLElement>('.body');
      expect(body?.textContent).toBe('rojo');
      expect(body?.innerHTML).toContain('<span style=');
      expect(body?.innerHTML).not.toContain('');
    });

    it('marks a row whose entry is in the selection', () => {
      bufferModule.buffer.selected.add(7);
      const { row } = build(line('elegida'), 7);
      expect(row.classList.contains('selected')).toBe(true);
      bufferModule.buffer.selected.clear();
    });

    it('leaves an unselected entry unmarked', () => {
      bufferModule.buffer.selected.add(7);
      const { row } = build(line('otra'), 8);
      expect(row.classList.contains('selected')).toBe(false);
      bufferModule.buffer.selected.clear();
    });
  });

  describe('ways back to the line in context', () => {
    it('shows the timestamp as a clock, to the millisecond', () => {
      const ts = new Date(2024, 0, 2, 3, 4, 5, 6).getTime();
      const { row } = build(line('hola', { ts }));
      expect(row.querySelector<HTMLElement>('.ts')?.textContent).toBe(
        '03:04:05.006',
      );
    });

    it('clicking the timestamp asks for this very row, without disturbing the list', () => {
      const { row, contexted } = build(line('hola'));
      const stamp = row.querySelector<HTMLElement>('.ts');
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      const stop = vi.spyOn(event, 'stopPropagation');
      stamp?.dispatchEvent(event);
      expect(contexted).toEqual([row]);
      expect(stop).toHaveBeenCalled();
    });

    it('a secondary click anywhere on the row does the same', () => {
      const { row, contexted } = build(line('hola'));
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      row.dispatchEvent(event);
      expect(contexted).toEqual([row]);
      expect(event.defaultPrevented).toBe(true);
    });

    it('ctrl+click is left alone — this list spends it on selecting a row', () => {
      // macOS routes ctrl+click to `contextmenu` too. Without the guard the
      // row gets selected AND flashed, and the flash paints over the highlight.
      const { row, contexted } = build(line('hola'));
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      row.dispatchEvent(event);
      expect(contexted).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('source tags in a merged view', () => {
    beforeEach(() => {
      viewModule.view.groupSources = new Map([
        ['api', source('api', 'Api', 'Back')],
      ]);
      viewModule.view.levelFilter = new Set<SilenceLevel>(['warn']);
    });

    it('labels the row with its group and its service', () => {
      const { row } = build(sourced('api'));
      expect(
        Array.from(row.querySelectorAll('.src'), (el) => el.textContent),
      ).toEqual(['[Back]', '[Api]']);
      expect(row.dataset.src).toBe('Api');
      expect(row.dataset.group).toBe('Back');
    });

    it('drops the group tag inside one real group, where it says nothing', () => {
      viewModule.view.mergedGroupId = 'grp-Back';
      const { row } = build(sourced('api'));
      expect(
        Array.from(row.querySelectorAll('.src'), (el) => el.textContent),
      ).toEqual(['[Api]']);
    });

    it("keeps the group tag in the pipeline's own merged view", () => {
      // Its sources are whichever real groups took part, exactly like "Todo".
      viewModule.view.mergedGroupId = PIPELINE_LOG_GROUP_ID;
      const { row } = build(sourced('api'));
      expect(
        Array.from(row.querySelectorAll('.src'), (el) => el.textContent),
      ).toEqual(['[Back]', '[Api]']);
    });

    it('the group tag opens that group, keeping the level pin', () => {
      const { row } = build(sourced('api'));
      row.querySelector<HTMLElement>('.src.grp')?.click();
      expect(opened).toEqual([
        [{ kind: 'group', groupId: 'grp-Back' }, ['warn']],
      ]);
    });

    it('the group tag hands over a COPY of the level pin', () => {
      // `view.levelFilter` is a live Set the panes mutate; handing it over
      // would let the next scope switch edit what this call was given.
      const { row } = build(sourced('api'));
      row.querySelector<HTMLElement>('.src.grp')?.click();
      viewModule.view.levelFilter.clear();
      expect((opened[0] as [unknown, string[]])[1]).toEqual(['warn']);
    });

    it('the service tag jumps to this line in that service', () => {
      const { row } = build(sourced('api', { ts: 4242 }));
      const tags = row.querySelectorAll<HTMLElement>('.src');
      tags[tags.length - 1]?.click();
      expect(jumped).toEqual([['api', 4242]]);
    });

    it('a line from a service the view has never heard of goes untagged', () => {
      const { row } = build(sourced('desconocido'));
      expect(row.querySelectorAll('.src')).toHaveLength(0);
      expect(row.dataset.src).toBeUndefined();
    });
  });

  describe('the silence button', () => {
    beforeEach(() => {
      viewModule.view.groupSources = null;
      viewModule.view.mergedGroupId = null;
      viewModule.view.currentGroupId = 'g1';
      viewModule.view.currentCommandId = 'c1';
    });

    it('is offered on a warning', () => {
      const { row } = build(line('ojo', { originalLevel: 'warn' }));
      const btn = row.querySelector<HTMLElement>('.silence-btn');
      expect(btn?.textContent).toBe('🔕');
    });

    it('offers to UNDO it on a line a rule already swallowed', () => {
      const { row } = build(
        line('ojo', { originalLevel: 'error', silenced: true }),
      );
      const btn = row.querySelector<HTMLElement>('.silence-btn');
      expect(btn?.textContent).toBe('🔔');
      expect(btn?.title).toContain('Quitar silencio');
    });

    it('stays away from a line with no severity to silence', () => {
      const { row } = build(line('rutina'));
      expect(row.querySelector('.silence-btn')).toBeNull();
    });

    it('stays away when no single command owns the view', () => {
      // Silencing is per service: in a merged scope there is nothing to act on.
      viewModule.view.currentCommandId = null;
      const { row } = build(line('ojo', { originalLevel: 'warn' }));
      expect(row.querySelector('.silence-btn')).toBeNull();
    });

    it('silences the built pattern, not the raw line', async () => {
      const { row } = build(
        line('[33mfallo 42[0m  ', { originalLevel: 'warn' }),
      );
      row.querySelector<HTMLElement>('.silence-btn')?.click();
      await Promise.resolve();
      expect(api.buildSilencePattern).toHaveBeenCalledWith('fallo 42');
      expect(api.addSilencePattern).toHaveBeenCalledWith(
        'g1',
        'c1',
        'warn',
        're:fallo 42',
      );
    });

    it('falls back to the cleaned text when no pattern could be built', () => {
      api.buildSilencePattern.mockReturnValue('');
      const { row } = build(line('fallo', { originalLevel: 'error' }));
      row.querySelector<HTMLElement>('.silence-btn')?.click();
      expect(api.addSilencePattern).toHaveBeenCalledWith(
        'g1',
        'c1',
        'error',
        'fallo',
      );
    });

    it('unsilencing removes the built pattern AND the literal it may have been', async () => {
      const { row } = build(
        line('fallo 42', { originalLevel: 'warn', silenced: true }),
      );
      row.querySelector<HTMLElement>('.silence-btn')?.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(api.removeSilencePattern.mock.calls).toEqual([
        ['g1', 'c1', 'warn', 're:fallo 42'],
        ['g1', 'c1', 'warn', 'fallo 42'],
      ]);
    });

    it('unsilencing asks once when the pattern IS the literal', async () => {
      api.buildSilencePattern.mockImplementation((text: string) => text);
      const { row } = build(
        line('fallo', { originalLevel: 'warn', silenced: true }),
      );
      row.querySelector<HTMLElement>('.silence-btn')?.click();
      await Promise.resolve();
      expect(api.removeSilencePattern.mock.calls).toEqual([
        ['g1', 'c1', 'warn', 'fallo'],
      ]);
    });

    it('does not disturb the line-selection handler underneath it', () => {
      const { row } = build(line('ojo', { originalLevel: 'warn' }));
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      const stop = vi.spyOn(event, 'stopPropagation');
      row.querySelector<HTMLElement>('.silence-btn')?.dispatchEvent(event);
      expect(stop).toHaveBeenCalled();
    });

    it('resolves the command the row was BUILT for, not the one on screen now', async () => {
      // The view can switch between a row being drawn and its button pressed;
      // the pattern must land on the command whose line it is.
      const { row } = build(line('fallo', { originalLevel: 'warn' }));
      viewModule.view.currentGroupId = 'otro';
      viewModule.view.currentCommandId = 'otro-cmd';
      row.querySelector<HTMLElement>('.silence-btn')?.click();
      await Promise.resolve();
      expect(api.addSilencePattern.mock.calls[0]?.slice(0, 2)).toEqual([
        'g1',
        'c1',
      ]);
    });
  });
});
