// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import type { LogsTarget, LogSource } from '../src/ipc-contract.js';

/**
 * `renderer/logs/drawer.ts` is the silenced drawer: the rules that swallow
 * lines on the left, and the lines they are actually swallowing on the right.
 * Both halves are driven here against the real drawer markup, because the
 * point of the pane is that the two agree — a rule you cannot inspect is a
 * rule you stop trusting.
 */
type DrawerModule = typeof import('../renderer/logs/drawer.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

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

describe('renderer/logs/drawer.ts', () => {
  let drawer: DrawerModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let dom: LogsDom;

  beforeEach(async () => {
    vi.useFakeTimers();
    dom = mountLogsDom({
      api: { buildSilencePattern: (text: string) => `re:${text}` },
    });
    drawer = await import('../renderer/logs/drawer.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function warnRows(): HTMLElement[] {
    return Array.from(elements.warnFeedEl.children) as HTMLElement[];
  }

  function countBadge(level: 'warn' | 'error'): string {
    const badge = elements.drawerEl.querySelector<HTMLElement>(
      `.drawer-count[data-count="${level}"]`,
    );
    return badge?.textContent ?? '';
  }

  describe('opening and closing', () => {
    it('shows the drawer and marks the control that opened it', () => {
      drawer.setDrawer(true);
      expect(elements.drawerEl.hidden).toBe(false);
      expect(elements.togglePanelBtn.classList.contains('on')).toBe(true);
    });

    it('hides it again from the close button', () => {
      drawer.setDrawer(true);
      elements.drawerCloseBtn.click();
      expect(elements.drawerEl.hidden).toBe(true);
      expect(elements.togglePanelBtn.classList.contains('on')).toBe(false);
    });

    it('the toolbar control toggles it', () => {
      elements.togglePanelBtn.click();
      expect(elements.drawerEl.hidden).toBe(false);
      elements.togglePanelBtn.click();
      expect(elements.drawerEl.hidden).toBe(true);
    });

    it('refuses to open in a merged scope, and says why', () => {
      // Patterns would list empty — reading as "nothing is silenced" — and a
      // typed pattern would be dropped without a word.
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

  describe('applyTargetSnapshot', () => {
    it("adopts main's view of the shown command, silence settings included", () => {
      drawer.applyTargetSnapshot(commandTarget());
      expect(view.view.currentTarget).not.toBeNull();
      expect(elements.muteWarnEl.checked).toBe(true);
      expect(elements.muteErrEl.checked).toBe(false);
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

  describe('renderDrawer', () => {
    it('stays quiet while the drawer is closed', () => {
      view.view.currentTarget = commandTarget({ warn: ['ruido'] });
      drawer.renderDrawer();
      expect(elements.warnListEl.childElementCount).toBe(0);
    });

    it('lists the patterns of the command on screen', () => {
      view.view.currentTarget = commandTarget({
        warn: ['ruido', 'otro'],
        error: ['grave'],
      });
      drawer.setDrawer(true);
      expect(
        Array.from(
          elements.warnListEl.querySelectorAll('.pattern'),
          (el) => el.textContent,
        ),
      ).toEqual(['ruido', 'otro']);
      expect(
        Array.from(
          elements.errListEl.querySelectorAll('.pattern'),
          (el) => el.textContent,
        ),
      ).toEqual(['grave']);
    });

    it('says so when a level has no rules at all', () => {
      view.view.currentTarget = commandTarget({ warn: [] });
      drawer.setDrawer(true);
      expect(elements.warnListEl.textContent).toBe('Ninguno');
    });

    it('names what the drawer is acting on, group first', () => {
      view.view.displayName = 'api';
      view.view.groupName = 'Back';
      drawer.setDrawer(true);
      expect(elements.drawerTargetEl.textContent).toBe('Back · api');
    });

    it('drops the qualifier when there is no group to qualify with', () => {
      view.view.displayName = 'api';
      view.view.groupName = '';
      drawer.setDrawer(true);
      expect(elements.drawerTargetEl.textContent).toBe('api');
    });

    it('removing a rule from the list asks main to drop it', () => {
      view.view.currentTarget = commandTarget({ warn: ['ruido'] });
      view.view.currentGroupId = 'g1';
      view.view.currentCommandId = 'c1';
      drawer.setDrawer(true);
      elements.warnListEl.querySelector<HTMLElement>('.unsilence')?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 'ruido'],
      ]);
    });

    it('asks nothing when no single command owns the view', () => {
      view.view.currentTarget = commandTarget({ error: ['grave'] });
      view.view.currentGroupId = null;
      drawer.setDrawer(true);
      elements.errListEl.querySelector<HTMLElement>('.unsilence')?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([]);
    });
  });

  describe('the feed of swallowed lines', () => {
    it('mirrors a swallowed warning, with its clock and its text', () => {
      const ts = new Date(2024, 0, 2, 3, 4, 5, 6).getTime();
      drawer.pushMutedLine(
        entry('[33mruido[0m', { originalLevel: 'warn', ts }),
      );
      expect(warnRows()).toHaveLength(1);
      expect(warnRows()[0]?.querySelector('.ts')?.textContent).toBe(
        '03:04:05.006',
      );
      expect(warnRows()[0]?.querySelector('.body')?.textContent).toBe('ruido');
    });

    it('sends an error to the error feed instead', () => {
      drawer.pushMutedLine(entry('grave', { originalLevel: 'error' }));
      expect(elements.warnFeedEl.childElementCount).toBe(0);
      expect(elements.errFeedEl.childElementCount).toBe(1);
    });

    it('ignores a line with no severity behind it', () => {
      drawer.pushMutedLine(entry('rutina'));
      expect(elements.warnFeedEl.childElementCount).toBe(0);
      expect(elements.errFeedEl.childElementCount).toBe(0);
    });

    it('ignores everything in a merged scope, where no command owns the row', () => {
      // Unsilencing acts on the CURRENT selection, so a row here would remove
      // a pattern from whichever command happened to be selected.
      view.view.groupSources = new Map([['api', source('api')]]);
      drawer.pushMutedLine(entry('ruido', { originalLevel: 'warn' }));
      expect(elements.warnFeedEl.childElementCount).toBe(0);
    });

    it('counts a repeat of the same event instead of listing it again', () => {
      // The skeleton is what tells two sightings of one event apart from two
      // different events: the number varies, the shape does not.
      drawer.pushMutedLine(entry('fallo 1', { originalLevel: 'warn' }));
      drawer.pushMutedLine(entry('fallo 2', { originalLevel: 'warn' }));
      expect(warnRows()).toHaveLength(1);
      expect(warnRows()[0]?.dataset.count).toBe('2');
      const badge = warnRows()[0]?.querySelector<HTMLElement>('.rep');
      expect(badge?.textContent).toBe('×2');
      expect(badge?.hidden).toBe(false);
    });

    it('floats the noisy one back to the bottom, showing its latest sighting', () => {
      const later = new Date(2024, 0, 2, 9, 9, 9, 999).getTime();
      drawer.pushMutedLine(entry('fallo 1', { originalLevel: 'warn', ts: 0 }));
      drawer.pushMutedLine(entry('otra cosa', { originalLevel: 'warn' }));
      drawer.pushMutedLine(
        entry('fallo 2', { originalLevel: 'warn', ts: later }),
      );
      expect(
        warnRows().map((row) => row.querySelector('.body')?.textContent),
      ).toEqual(['otra cosa', 'fallo 1']);
      expect(warnRows().at(-1)?.querySelector('.ts')?.textContent).toBe(
        '09:09:09.999',
      );
    });

    it('counts total sightings in the header, not distinct rows', () => {
      drawer.pushMutedLine(entry('fallo 1', { originalLevel: 'warn' }));
      drawer.pushMutedLine(entry('fallo 2', { originalLevel: 'warn' }));
      drawer.pushMutedLine(entry('otra', { originalLevel: 'warn' }));
      expect(countBadge('warn')).toBe('3');
      expect(countBadge('error')).toBe('0');
    });

    it('drops the oldest row once the feed is full', () => {
      for (let i = 0; i < 61; i += 1)
        drawer.pushMutedLine(
          entry(`ruido ${'x'.repeat(i)}`, {
            originalLevel: 'warn',
          }),
        );
      expect(warnRows()).toHaveLength(60);
      expect(warnRows()[0]?.querySelector('.body')?.textContent).toBe(
        `ruido ${'x'.repeat(1)}`,
      );
    });

    it('wiping the feeds resets their counters too', () => {
      drawer.pushMutedLine(entry('ruido', { originalLevel: 'warn' }));
      drawer.pushMutedLine(entry('grave', { originalLevel: 'error' }));
      drawer.clearMutedFeeds();
      expect(elements.warnFeedEl.childElementCount).toBe(0);
      expect(elements.errFeedEl.childElementCount).toBe(0);
      expect(countBadge('warn')).toBe('0');
      expect(countBadge('error')).toBe('0');
    });

    it('one click on a row drops whichever rule is swallowing it', async () => {
      view.view.currentGroupId = 'g1';
      view.view.currentCommandId = 'c1';
      drawer.pushMutedLine(entry('  fallo 42  ', { originalLevel: 'warn' }));
      warnRows()[0]?.click();
      await vi.advanceTimersByTimeAsync(0);
      // The built pattern first, then the literal it may have been stored as.
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 're:fallo 42'],
        ['g1', 'c1', 'warn', 'fallo 42'],
      ]);
    });

    it('a click asks nothing while no single command owns the view', () => {
      view.view.currentGroupId = null;
      view.view.currentCommandId = null;
      drawer.pushMutedLine(entry('fallo', { originalLevel: 'warn' }));
      warnRows()[0]?.click();
      expect(dom.argsFor('removeSilencePattern')).toEqual([]);
    });
  });

  describe('adding a rule by hand', () => {
    it('sends what was typed and empties the box', () => {
      view.view.currentGroupId = 'g1';
      view.view.currentCommandId = 'c1';
      elements.warnInputEl.value = '  ruido  ';
      elements.warnAddBtn.click();
      expect(dom.argsFor('addSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 'ruido'],
      ]);
      expect(elements.warnInputEl.value).toBe('');
    });

    it('does the same for errors, from the keyboard', () => {
      view.view.currentGroupId = 'g1';
      view.view.currentCommandId = 'c1';
      elements.errInputEl.value = 'grave';
      elements.errInputEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      expect(dom.argsFor('addSilencePattern')).toEqual([
        ['g1', 'c1', 'error', 'grave'],
      ]);
    });

    it('sends nothing when no single command owns the view', () => {
      view.view.currentGroupId = null;
      elements.warnInputEl.value = 'ruido';
      elements.warnAddBtn.click();
      expect(dom.argsFor('addSilencePattern')).toEqual([]);
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
