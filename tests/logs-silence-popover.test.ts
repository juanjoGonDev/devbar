// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import { REGEX_MARKER } from '../src/silence-pattern.js';
import type { LogEntry } from '../src/domain-types.js';
import type { LogsTarget, LogSource } from '../src/ipc-contract.js';

/**
 * `renderer/logs/silence-popover.ts` is the silenced popover: it floats over
 * the log, under its toolbar toggle, with a composer that previews — against
 * the lines already held — what a rule would swallow before it is saved, the
 * saved rules of both levels in one list, and the per-level "silence
 * everything" switches. Driven here against the real markup, because the
 * point of it is that the rule and the lines it eats are visible together.
 */
type PopoverModule = typeof import('../renderer/logs/silence-popover.js');
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

describe('renderer/logs/silence-popover.ts', () => {
  let popover: PopoverModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let buffer: BufferModule;
  let dom: LogsDom;

  async function load(): Promise<void> {
    popover = await import('../renderer/logs/silence-popover.js');
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
      const body = document.createElement('span');
      body.className = 'body';
      body.textContent = entries[index]?.line ?? '';
      row.appendChild(body);
      elements.linesEl.appendChild(row);
    });
  }

  /** What is painted as matched inside the drawn lines, in order. */
  function marks(): string[] {
    return Array.from(
      elements.linesEl.querySelectorAll('.line .body mark'),
      (mark) => mark.textContent ?? '',
    );
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

  function pressEscape(): void {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  }

  function pressOn(node: Element): void {
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }

  function ruleRows(): HTMLElement[] {
    return Array.from(
      elements.patternListEl.querySelectorAll<HTMLElement>('.rule'),
    );
  }

  function ruleTexts(): Array<string | null | undefined> {
    return ruleRows().map((row) => row.querySelector('code')?.textContent);
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
    it('shows the popover, expands the toggle and focuses the composer', () => {
      popover.setSilencePopover(true);
      expect(elements.popoverEl.hidden).toBe(false);
      expect(elements.silenceToggleBtn.getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(document.activeElement).toBe(elements.draftInputEl);
    });

    it('is a dialog named after what it holds', () => {
      expect(elements.popoverEl.getAttribute('role')).toBe('dialog');
      expect(elements.popoverEl.getAttribute('aria-label')).toBe('Silenciados');
    });

    it('the toolbar toggle opens it and closes it, handing focus back', () => {
      elements.silenceToggleBtn.click();
      expect(elements.popoverEl.hidden).toBe(false);
      elements.silenceToggleBtn.click();
      expect(elements.popoverEl.hidden).toBe(true);
      expect(elements.silenceToggleBtn.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(document.activeElement).toBe(elements.silenceToggleBtn);
    });

    it('Escape closes it and returns focus to the toggle', () => {
      popover.setSilencePopover(true);
      pressEscape();
      expect(elements.popoverEl.hidden).toBe(true);
      expect(document.activeElement).toBe(elements.silenceToggleBtn);
    });

    it('a press outside closes it', () => {
      popover.setSilencePopover(true);
      pressOn(elements.linesEl);
      expect(elements.popoverEl.hidden).toBe(true);
    });

    it('a press inside keeps it open', () => {
      popover.setSilencePopover(true);
      pressOn(elements.muteWarnEl);
      expect(elements.popoverEl.hidden).toBe(false);
    });

    it("a press on a row's silence action keeps it open, since that prefills it", () => {
      popover.setSilencePopover(true);
      const btn = document.createElement('button');
      const bar = document.createElement('div');
      bar.className = 'row-actions';
      bar.appendChild(btn);
      elements.linesEl.appendChild(bar);
      pressOn(btn);
      expect(elements.popoverEl.hidden).toBe(false);
    });

    it('closing takes the marks off the log', () => {
      ownCommand({ warn: [] });
      hold(HELD);
      popover.setSilencePopover(true);
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      popover.setSilencePopover(false);
      expect(markedRows()).toEqual([]);
      expect(marks()).toEqual([]);
      expect(elements.silencePreviewEl.hidden).toBe(true);
    });

    it('refuses to open in a merged scope, and says why', () => {
      view.view.groupSources = new Map([['api', source('api')]]);
      elements.silenceToggleBtn.click();
      expect(elements.popoverEl.hidden).toBe(true);
      expect(elements.statusEl.textContent).toBe(
        'Los silenciados son por servicio: elige uno',
      );
    });

    it('takes the message back down once it has been read', () => {
      view.view.groupSources = new Map([['api', source('api')]]);
      elements.silenceToggleBtn.click();
      vi.advanceTimersByTime(2500);
      expect(elements.statusEl.textContent).toBe('');
    });
  });

  describe('the toolbar toggle', () => {
    it('counts every active rule of the command on screen, both levels', () => {
      ownCommand({ warn: ['a'], error: ['b', 'c'] });
      popover.renderSilencePopover();
      expect(elements.silenceToggleCountEl.textContent).toBe('3');
    });

    it('shows no count when no single command owns the view', () => {
      view.view.currentTarget = null;
      popover.renderSilencePopover();
      expect(elements.silenceToggleCountEl.textContent).toBe('');
    });
  });

  describe('applyTargetSnapshot', () => {
    it("adopts main's view of the shown command, silence settings included", () => {
      popover.applyTargetSnapshot(commandTarget({ warn: ['x'] }));
      expect(view.view.currentTarget).not.toBeNull();
      expect(elements.muteWarnEl.checked).toBe(true);
      expect(elements.muteErrEl.checked).toBe(false);
      expect(elements.silenceToggleCountEl.textContent).toBe('1');
    });

    it('leaves the per-command switches alone for a target that has none', () => {
      elements.muteWarnEl.checked = true;
      popover.applyTargetSnapshot({
        kind: 'action',
        group: { id: 'g1', name: 'Back' },
        target: { id: 'a1', name: 'deploy' },
      } as unknown as LogsTarget);
      expect(elements.muteWarnEl.checked).toBe(true);
    });
  });

  describe('the level pills', () => {
    it('start on warnings', () => {
      popover.setSilencePopover(true);
      expect(elements.levelWarnBtn.getAttribute('aria-pressed')).toBe('true');
      expect(elements.levelErrBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('pick one level at a time', () => {
      popover.setSilencePopover(true);
      elements.levelErrBtn.click();
      expect(elements.levelErrBtn.getAttribute('aria-pressed')).toBe('true');
      expect(elements.levelWarnBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('re-preview the draft against the level picked', () => {
      ownCommand({ warn: [] });
      hold(HELD);
      popover.setSilencePopover(true);
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      elements.levelErrBtn.click();
      expect(markedRows()).toEqual([3]);
      expect(elements.draftCountEl.textContent).toBe('1');
    });

    it('remember the level across a reload', async () => {
      elements.levelErrBtn.click();
      expect(localStorage.getItem('devbar.logs.silence-level')).toBe('error');
      mountLogsDom();
      localStorage.setItem('devbar.logs.silence-level', 'error');
      await load();
      popover.setSilencePopover(true);
      expect(elements.levelErrBtn.getAttribute('aria-pressed')).toBe('true');
    });

    it('still work when storage refuses to answer', async () => {
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
      popover.setSilencePopover(true);
      elements.levelErrBtn.click();
      expect(elements.levelErrBtn.getAttribute('aria-pressed')).toBe('true');
      spy.mockRestore();
      setSpy.mockRestore();
    });
  });

  describe('the active rules', () => {
    it('lists both levels together, each with its level and its matches', () => {
      ownCommand({
        warn: ['Successfully compiled', `${REGEX_MARKER}otra.*`],
        error: ['Successfully compiled'],
      });
      hold(HELD);
      popover.setSilencePopover(true);
      const rows = ruleRows();
      expect(ruleTexts()).toEqual([
        'Successfully compiled',
        'otra.*',
        'Successfully compiled',
      ]);
      expect(rows.map((row) => row.dataset.level)).toEqual([
        'warn',
        'warn',
        'error',
      ]);
      expect(rows.map((row) => row.querySelector('.cnt')?.textContent)).toEqual(
        ['2', '1', '1'],
      );
      expect(rows[1]?.querySelector('code')?.getAttribute('title')).toBe(
        'otra.*',
      );
    });

    it('says so when there are no rules at all', () => {
      ownCommand({ warn: [] });
      popover.setSilencePopover(true);
      expect(elements.patternListEl.textContent).toBe('Sin reglas');
    });

    it('removing a rule asks main to drop exactly what is stored, at its own level', () => {
      ownCommand({ warn: ['ruido'], error: [`${REGEX_MARKER}grave.*`] });
      popover.setSilencePopover(true);
      ruleRows()[1]?.querySelector<HTMLElement>('.x')?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'error', `${REGEX_MARKER}grave.*`],
      ]);
    });

    it('keeps a rule removable while state pushes repaint the popover', () => {
      ownCommand({ warn: ['otra'] });
      popover.setSilencePopover(true);
      const remove = ruleRows()[0]?.querySelector<HTMLElement>('.x');
      // A busy service pushes state constantly; each push repaints the
      // popover. Rebuilding the rows between press and release lost the click.
      popover.renderSilencePopover();
      expect(remove?.isConnected).toBe(true);
      remove?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 'otra'],
      ]);
    });

    it('refreshes the counts of unchanged rules without rebuilding them', () => {
      ownCommand({ warn: ['otra'] });
      hold([]);
      popover.setSilencePopover(true);
      const row = ruleRows()[0];
      hold(HELD);
      popover.renderSilencePopover();
      expect(ruleRows()[0]).toBe(row);
      expect(row?.querySelector('.cnt')?.textContent).toBe('1');
    });

    it('asks nothing when no single command owns the view', () => {
      view.view.currentTarget = commandTarget({ warn: ['grave'] });
      view.view.currentGroupId = null;
      popover.setSilencePopover(true);
      ruleRows()[0]?.querySelector<HTMLElement>('.x')?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([]);
    });

    it('hovering a rule marks the lines it matches at its level, and leaving unmarks them', () => {
      ownCommand({ warn: ['Successfully compiled'], error: ['Successfully'] });
      hold(HELD);
      popover.setSilencePopover(true);
      ruleRows()[1]?.dispatchEvent(new MouseEvent('mouseenter'));
      expect(markedRows()).toEqual([3]);
      ruleRows()[1]?.dispatchEvent(new MouseEvent('mouseleave'));
      ruleRows()[0]?.dispatchEvent(new MouseEvent('mouseenter'));
      expect(markedRows()).toEqual([0, 2]);
      expect(elements.silencePreviewEl.hidden).toBe(false);
      expect(elements.silencePreviewTextEl.textContent).toBe(
        '2 coinciden con este patrón',
      );
      ruleRows()[0]?.dispatchEvent(new MouseEvent('mouseleave'));
      expect(markedRows()).toEqual([]);
      expect(marks()).toEqual([]);
      expect(elements.silencePreviewEl.hidden).toBe(true);
    });
  });

  describe('the composer', () => {
    beforeEach(() => {
      ownCommand({ warn: [] });
      hold(HELD);
      popover.setSilencePopover(true);
    });

    it('starts empty, with nothing to silence', () => {
      expect(elements.submitBtn.disabled).toBe(true);
      expect(elements.submitBtn.textContent?.trim()).toBe('Silenciar');
      expect(elements.draftCountEl.hidden).toBe(true);
    });

    it('waits for typing to settle before previewing', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(50);
      expect(markedRows()).toEqual([]);
      expect(marks()).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(markedRows()).toEqual([0, 2]);
    });

    it('counts the held lines of this level it would silence, in the field and on the button', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      expect(elements.draftCountEl.hidden).toBe(false);
      expect(elements.draftCountEl.textContent).toBe('2');
      expect(elements.submitBtn.textContent?.trim()).toBe('Silenciar 2');
      expect(elements.submitBtn.disabled).toBe(false);
    });

    it('still lets a rule that matches nothing yet be saved', () => {
      type('nada parecido');
      vi.advanceTimersByTime(100);
      expect(elements.draftCountEl.textContent).toBe('0');
      expect(elements.submitBtn.textContent?.trim()).toBe('Silenciar');
      expect(elements.submitBtn.disabled).toBe(false);
    });

    it('marks the log and says how many would go in the footer', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      expect(elements.silencePreviewTextEl.textContent).toBe(
        '2 se silenciarían con el patrón nuevo',
      );
      expect(view.view.silencePreview?.swallows(HELD[0])).toBe(true);
      expect(marks()).toEqual([
        'Successfully compiled',
        'Successfully compiled',
      ]);
    });

    it('clearing the draft takes the preview away', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      type('');
      vi.advanceTimersByTime(100);
      expect(markedRows()).toEqual([]);
      expect(marks()).toEqual([]);
      expect(elements.silencePreviewEl.hidden).toBe(true);
      expect(elements.draftCountEl.hidden).toBe(true);
      expect(elements.submitBtn.disabled).toBe(true);
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
      expect(marks()).toEqual([]);
    });

    it('the button does the same as Enter', () => {
      type('Successfully compiled');
      vi.advanceTimersByTime(100);
      elements.submitBtn.click();
      expect(dom.argsFor('addSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 'Successfully compiled'],
      ]);
      expect(elements.draftInputEl.value).toBe('');
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

    it('refuses an invalid regex inline, and neither Enter nor the button sends it', () => {
      elements.draftRegexBtn.click();
      type('(abc');
      vi.advanceTimersByTime(100);
      expect(elements.draftErrorEl.hidden).toBe(false);
      expect(elements.draftErrorEl.textContent).toBe('Regex no válida');
      expect(elements.composerEl.classList.contains('invalid')).toBe(true);
      expect(elements.submitBtn.disabled).toBe(true);
      pressEnter();
      elements.submitBtn.click();
      expect(dom.argsFor('addSilencePattern')).toEqual([]);
      expect(elements.draftInputEl.value).toBe('(abc');
    });

    it('adds to errors when errors is the level picked', () => {
      elements.levelErrBtn.click();
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
      popover.resetSilenceScope();
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
      expect(elements.popoverEl.hidden).toBe(false);
      expect(elements.levelErrBtn.getAttribute('aria-pressed')).toBe('true');
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
    it('shows both levels side by side', () => {
      popover.setSilencePopover(true);
      expect(elements.muteWarnEl.closest('[hidden]')).toBeNull();
      expect(elements.muteErrEl.closest('[hidden]')).toBeNull();
    });

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
