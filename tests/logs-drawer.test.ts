// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import { REGEX_MARKER } from '../src/silence-pattern.js';
import type { LogEntry } from '../src/domain-types.js';
import type { LogsTarget, LogSource } from '../src/ipc-contract.js';

/**
 * `renderer/logs/drawer.ts` is the silenced panel: the rules that swallow
 * lines, a draft that previews — against the lines already held — what it
 * would swallow before it is saved, and the per-level "silence everything"
 * switch. Driven here against the real markup, because the point of the panel
 * is that the rule and the lines it eats are visible together.
 */
type DrawerModule = typeof import('../renderer/logs/drawer.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');
type BufferModule = typeof import('../renderer/logs/buffer.js');

function commandTarget(patterns?: {
  warn?: string[];
  error?: string[];
}): LogsTarget {
  return {
    kind: 'command',
    group: { id: 'g1', name: 'Back' },
    target: {
      id: 'c1',
      name: 'api',
      silenceWarnings: true,
      silenceErrors: false,
      ...(patterns
        ? {
            silencedPatterns: {
              warn: patterns.warn ?? [],
              error: patterns.error ?? [],
            },
          }
        : {}),
    },
  } as unknown as LogsTarget;
}

function source(id: string): LogSource {
  return { id, name: id, groupId: 'g1', groupName: 'Back' };
}

function warn(line: string): LogEntry {
  return entry(line, { level: 'warn', originalLevel: 'warn' });
}

function error(line: string): LogEntry {
  return entry(line, { level: 'error', originalLevel: 'error' });
}

const HELD: LogEntry[] = [
  warn('Successfully compiled src/a.ts'),
  entry('DEBUG reconnect'),
  warn('Successfully compiled src/b.ts'),
  error('Successfully compiled pero en error'),
  warn('otra advertencia'),
];

describe('renderer/logs/drawer.ts', () => {
  let drawer: DrawerModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let buffer: BufferModule;
  let dom: LogsDom;

  async function load(): Promise<void> {
    drawer = await import('../renderer/logs/drawer.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
    buffer = await import('../renderer/logs/buffer.js');
  }

  /** Hold `entries` and draw each as a row, the way the pane would. */
  function hold(entries: LogEntry[]): void {
    buffer.buffer.entries = entries;
    elements.linesEl.textContent = '';
    entries.forEach((_, index) => {
      const row = document.createElement('div');
      row.className = 'line';
      row.dataset.eidx = String(index);
      elements.linesEl.appendChild(row);
    });
  }

  function markedRows(): number[] {
    return Array.from(
      elements.linesEl.querySelectorAll<HTMLElement>('.line.would-silence'),
      (row) => Number(row.dataset.eidx),
    );
  }

  function ownCommand(patterns?: { warn?: string[]; error?: string[] }): void {
    view.view.currentTarget = commandTarget(patterns);
    view.view.currentGroupId = 'g1';
    view.view.currentCommandId = 'c1';
  }

  function type(text: string): void {
    elements.draftInputEl.value = text;
    elements.draftInputEl.dispatchEvent(new Event('input'));
  }

  function pressEnter(): void {
    elements.draftInputEl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  }

  function patternRows(): HTMLElement[] {
    return Array.from(
      elements.patternListEl.querySelectorAll<HTMLElement>('.pat'),
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    dom = mountLogsDom({
      api: { buildSilencePattern: (text: string) => `re:${text}` },
    });
    await load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('opening and closing', () => {
    it('shows the panel, presses the control that opened it and focuses the draft', () => {
      drawer.setDrawer(true);
      expect(elements.drawerEl.hidden).toBe(false);
      expect(elements.togglePanelBtn.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(elements.draftInputEl);
    });

    it('hides it again from the close button', () => {
      drawer.setDrawer(true);
      elements.drawerCloseBtn.click();
      expect(elements.drawerEl.hidden).toBe(true);
      expect(elements.togglePanelBtn.getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    it('the toolbar control toggles it', () => {
      elements.togglePanelBtn.click();
      expect(elements.drawerEl.hidden).toBe(false);
      elements.togglePanelBtn.click();
      expect(elements.drawerEl.hidden).toBe(true);
    });

    it('refuses to open in a merged scope, and says why', () => {
      view.view.groupSources = new Map([['api', source('api')]]);
      elements.togglePanelBtn.click();
      expect(elements.drawerEl.hidden).toBe(true);
      expect(elements.statusEl.textContent).toBe(
        'Los silenciados son por servicio: elige uno',
      );
    });

    it('takes the message back down once it has been read', () => {
      view.view.groupSources = new Map([['api', source('api')]]);
      elements.togglePanelBtn.click();
      vi.advanceTimersByTime(2500);
      expect(elements.statusEl.textContent).toBe('');
    });
  });

  describe('the toolbar toggle', () => {
    it('counts every active rule of the command on screen', () => {
      ownCommand({ warn: ['a'], error: ['b', 'c'] });
      drawer.renderDrawer();
      expect(elements.toggleLabelEl.textContent).toBe('Silenciados · 3');
    });

    it('drops the count when no single command owns the view', () => {
      view.view.currentTarget = null;
      drawer.renderDrawer();
      expect(elements.toggleLabelEl.textContent).toBe('Silenciados');
    });
  });

  describe('applyTargetSnapshot', () => {
    it("adopts main's view of the shown command, silence settings included", () => {
      drawer.applyTargetSnapshot(commandTarget({ warn: ['x'] }));
      expect(view.view.currentTarget).not.toBeNull();
      expect(elements.muteWarnEl.checked).toBe(true);
      expect(elements.muteErrEl.checked).toBe(false);
      expect(elements.toggleLabelEl.textContent).toBe('Silenciados · 1');
    });

    it('leaves the per-command switches alone for a target that has none', () => {
      elements.muteWarnEl.checked = true;
      drawer.applyTargetSnapshot({
        kind: 'action',
        group: { id: 'g1', name: 'Back' },
        target: { id: 'a1', name: 'deploy' },
      } as unknown as LogsTarget);
      expect(elements.muteWarnEl.checked).toBe(true);
    });
  });

  describe('the level switcher', () => {
    it('counts the rules of each level', () => {
      ownCommand({ warn: ['a'], error: ['b', 'c'] });
      drawer.setDrawer(true);
      expect(elements.segWarnCountEl.textContent).toBe('1');
      expect(elements.segErrCountEl.textContent).toBe('2');
    });

    it('starts on warnings and lists only that level', () => {
      ownCommand({ warn: ['ruido'], error: ['grave'] });
      drawer.setDrawer(true);
      expect(elements.segWarnBtn.getAttribute('aria-selected')).toBe('true');
      expect(
        patternRows().map((row) => row.querySelector('code')?.textContent),
      ).toEqual(['ruido']);
    });

    it('switches level, its list and its switch', () => {
      ownCommand({ warn: ['ruido'], error: ['grave'] });
      drawer.setDrawer(true);
      elements.segErrBtn.click();
      expect(elements.segErrBtn.getAttribute('aria-selected')).toBe('true');
      expect(elements.segWarnBtn.getAttribute('aria-selected')).toBe('false');
      expect(
        patternRows().map((row) => row.querySelector('code')?.textContent),
      ).toEqual(['grave']);
      const switches = Array.from(
        elements.drawerEl.querySelectorAll<HTMLElement>('.switch-row'),
      );
      expect(switches.map((row) => row.hidden)).toEqual([true, false]);
    });

    it('remembers the level across a reload', async () => {
      elements.segErrBtn.click();
      expect(localStorage.getItem('devbar.logs.silence-level')).toBe('error');
      mountLogsDom();
      localStorage.setItem('devbar.logs.silence-level', 'error');
      await load();
      drawer.setDrawer(true);
      expect(elements.segErrBtn.getAttribute('aria-selected')).toBe('true');
    });

    it('still works when storage refuses to answer', async () => {
      mountLogsDom();
      const spy = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(() => {
          throw new Error('blocked');
        });
      const setSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('blocked');
        });
      await load();
      drawer.setDrawer(true);
      elements.segErrBtn.click();
      expect(elements.segErrBtn.getAttribute('aria-selected')).toBe('true');
      spy.mockRestore();
      setSpy.mockRestore();
    });
  });

  describe('the active rules', () => {
    it('shows each rule as typed, with how many held lines it matches', () => {
      ownCommand({ warn: ['Successfully compiled', `${REGEX_MARKER}otra.*`] });
      hold(HELD);
      drawer.setDrawer(true);
      const rows = patternRows();
      expect(rows.map((row) => row.querySelector('code')?.textContent)).toEqual(
        ['Successfully compiled', 'otra.*'],
      );
      expect(rows.map((row) => row.querySelector('.cnt')?.textContent)).toEqual(
        ['2', '1'],
      );
      expect(rows[1]?.querySelector('code')?.getAttribute('title')).toBe(
        'otra.*',
      );
    });

    it('says so when a level has no rules at all', () => {
      ownCommand({ warn: [] });
      drawer.setDrawer(true);
      expect(elements.patternListEl.textContent).toBe('Ninguno');
    });

    it('removing a rule asks main to drop exactly what is stored', () => {
      ownCommand({ warn: [`${REGEX_MARKER}otra.*`] });
      drawer.setDrawer(true);
      patternRows()[0]?.querySelector<HTMLElement>('.x')?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', `${REGEX_MARKER}otra.*`],
      ]);
    });

    it('keeps a rule removable while state pushes repaint the panel', () => {
      ownCommand({ warn: ['otra'] });
      drawer.setDrawer(true);
      const remove = patternRows()[0]?.querySelector<HTMLElement>('.x');
      // A busy service pushes state constantly; each push repaints the
      // panel. Rebuilding the rows between press and release lost the click.
      drawer.renderDrawer();
      expect(remove?.isConnected).toBe(true);
      remove?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 'otra'],
      ]);
    });

    it('asks nothing when no single command owns the view', () => {
      view.view.currentTarget = commandTarget({ warn: ['grave'] });
      view.view.currentGroupId = null;
      drawer.setDrawer(true);
      patternRows()[0]?.querySelector<HTMLElement>('.x')?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([]);
    });

    it('hovering a rule marks the lines it matches, and leaving unmarks them', () => {
      ownCommand({ warn: ['Successfully compiled'] });
      hold(HELD);
      drawer.setDrawer(true);
      patternRows()[0]?.dispatchEvent(new MouseEvent('mouseenter'));
      expect(markedRows()).toEqual([0, 2]);
      expect(elements.silencePreviewEl.hidden).toBe(false);
      expect(elements.silencePreviewTextEl.textContent).toBe(
        '2 coinciden con este patrón',
      );
      patternRows()[0]?.dispatchEvent(new MouseEvent('mouseleave'));
      expect(markedRows()).toEqual([]);
      expect(elements.silencePreviewEl.hidden).toBe(true);
    });
  });

  describe('the draft', () => {
    beforeEach(() => {
      ownCommand({ warn: [] });
      hold(HELD);
      drawer.setDrawer(true);
    });

    it('waits for typing to settle before previewing', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(50);
      expect(markedRows()).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(markedRows()).toEqual([0, 2]);
    });

    it('counts and samples the held lines of this level it would silence', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      expect(elements.draftMetaEl.hidden).toBe(false);
      expect(elements.draftCountEl.textContent).toBe('2 líneas de este log');
      const samples = Array.from(elements.draftSamplesEl.children);
      expect(samples.map((s) => s.textContent)).toEqual([
        'Successfully compiled src/a.ts',
        'Successfully compiled src/b.ts',
      ]);
      expect(samples[0]?.querySelector('mark')?.textContent).toBe(
        'Successfully compiled',
      );
    });

    it('marks the log and says how many would go in the footer', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      expect(elements.silencePreviewTextEl.textContent).toBe(
        '2 se silenciarían con el patrón nuevo',
      );
      expect(view.view.silencePreview?.(HELD[0])).toBe(true);
    });

    it('clearing the draft takes the preview away', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      type('');
      vi.advanceTimersByTime(100);
      expect(markedRows()).toEqual([]);
      expect(elements.silencePreviewEl.hidden).toBe(true);
      expect(elements.draftMetaEl.hidden).toBe(true);
      expect(elements.draftSamplesEl.childElementCount).toBe(0);
      expect(view.view.silencePreview).toBeNull();
    });

    it('Enter adds the draft to the selected level and empties it', () => {
      type('  Successfully compiled ');
      pressEnter();
      expect(dom.argsFor('addSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 'Successfully compiled'],
      ]);
      expect(elements.draftInputEl.value).toBe('');
      expect(markedRows()).toEqual([]);
    });

    it('stores a regex with no backslash so it is read back as one', () => {
      elements.draftRegexBtn.click();
      expect(elements.draftRegexBtn.getAttribute('aria-pressed')).toBe('true');
      type('compiled src/[ab]');
      pressEnter();
      expect(dom.argsFor('addSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', `${REGEX_MARKER}compiled src/[ab]`],
      ]);
    });

    it('previews a regex as a regex', () => {
      elements.draftRegexBtn.click();
      type('src/[a]');
      vi.advanceTimersByTime(100);
      expect(markedRows()).toEqual([0]);
    });

    it('refuses an invalid regex inline, and Enter does nothing', () => {
      elements.draftRegexBtn.click();
      type('(abc');
      vi.advanceTimersByTime(100);
      expect(elements.draftErrorEl.hidden).toBe(false);
      expect(elements.draftErrorEl.textContent).toBe('Regex no válida');
      expect(elements.draftCardEl.classList.contains('invalid')).toBe(true);
      pressEnter();
      expect(dom.argsFor('addSilencePattern')).toEqual([]);
      expect(elements.draftInputEl.value).toBe('(abc');
    });

    it('adds to errors when errors is the level on screen', () => {
      elements.segErrBtn.click();
      type('grave');
      pressEnter();
      expect(dom.argsFor('addSilencePattern')).toEqual([
        ['g1', 'c1', 'error', 'grave'],
      ]);
    });

    it('sends nothing when no single command owns the view', () => {
      view.view.currentGroupId = null;
      type('ruido');
      pressEnter();
      expect(dom.argsFor('addSilencePattern')).toEqual([]);
    });

    it('a scope switch drops the draft and its preview', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      drawer.resetSilenceScope();
      expect(elements.draftInputEl.value).toBe('');
      expect(view.view.silencePreview).toBeNull();
      expect(elements.silencePreviewEl.hidden).toBe(true);
    });
  });

  describe('prefilling from a line', () => {
    it('opens on that level with the line as the draft, previewed at once', () => {
      ownCommand({ warn: [] });
      hold(HELD);
      view.silenceHooks.prefill('error', 'Successfully compiled');
      expect(elements.drawerEl.hidden).toBe(false);
      expect(elements.segErrBtn.getAttribute('aria-selected')).toBe('true');
      expect(elements.draftInputEl.value).toBe('Successfully compiled');
      expect(elements.draftRegexBtn.getAttribute('aria-pressed')).toBe('false');
      expect(markedRows()).toEqual([3]);
      expect(dom.argsFor('addSilencePattern')).toEqual([]);
    });

    it('turns the regex toggle on for a built pattern', () => {
      ownCommand({ warn: [] });
      view.silenceHooks.prefill('warn', 'fallo \\d+');
      expect(elements.draftInputEl.value).toBe('fallo \\d+');
      expect(elements.draftRegexBtn.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('the per-command mute switches', () => {
    it('forwards a warning mute to main', () => {
      view.view.currentGroupId = 'g1';
      view.view.currentCommandId = 'c1';
      elements.muteWarnEl.checked = true;
      elements.muteWarnEl.dispatchEvent(new Event('change'));
      expect(dom.argsFor('setCommandSilence')).toEqual([
        ['g1', 'c1', 'warn', true],
      ]);
    });

    it('forwards an error un-mute to main', () => {
      view.view.currentGroupId = 'g1';
      view.view.currentCommandId = 'c1';
      elements.muteErrEl.checked = false;
      elements.muteErrEl.dispatchEvent(new Event('change'));
      expect(dom.argsFor('setCommandSilence')).toEqual([
        ['g1', 'c1', 'error', false],
      ]);
    });

    it('forwards nothing while no single command owns the view', () => {
      view.view.currentGroupId = null;
      view.view.currentCommandId = null;
      elements.muteWarnEl.dispatchEvent(new Event('change'));
      elements.muteErrEl.dispatchEvent(new Event('change'));
      expect(dom.argsFor('setCommandSilence')).toEqual([]);
    });
  });
});
