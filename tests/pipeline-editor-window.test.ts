// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import {
  initPipelineEditor,
  type PipelineEditorHandle,
} from '../renderer/pipeline-editor.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { Group, PreStep, PreStepScriptRef } from '../src/domain-types.js';

function step(id: string): PreStep {
  return { id, mode: 'parallel', scripts: [] };
}

function ref(groupId: string, scriptId: string): PreStepScriptRef {
  return { groupId, scriptId };
}

function filledStep(
  id: string,
  refs: PreStepScriptRef[],
  mode: PreStep['mode'] = 'parallel',
): PreStep {
  return { id, mode, scripts: refs };
}

/** Two groups, so the picker and the badges have something to distinguish. */
function groups(): Group[] {
  return [
    normalizeGroup({
      id: 'back',
      name: 'Back',
      path: '/repos/back',
      preScripts: [
        { id: 'setup', name: 'Make setup', command: 'make', args: ['setup'] },
        { id: 'seed', name: 'Seed', command: 'pnpm', timeoutMs: 90_000 },
      ],
    }),
    normalizeGroup({
      id: 'front',
      name: 'Front',
      path: '/repos/front',
      preScripts: [{ id: 'deps', name: 'Install deps', command: 'pnpm i' }],
    }),
  ];
}

function pipelineHost(): HTMLElement {
  const el = document.getElementById('prescripts-pipeline-root');
  if (!el) throw new Error('config.html has no pipeline host');
  return el;
}

function stepIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.prestep-card'),
    (card) => card.dataset.id ?? '',
  );
}

function scriptRowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.prescript-row'),
    (row) => row.dataset.id ?? '',
  );
}

function autoRunToggle(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    '#prescripts-pipeline-root .toggle input[type="checkbox"]',
  );
  if (!el) throw new Error('the pipeline editor drew no auto-run toggle');
  return el;
}

function addStepButton(): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.sub-list-header button'),
  ).find((candidate) => candidate.textContent?.includes('Añadir paso'));
  if (!button) throw new Error('the pipeline editor drew no "add step" button');
  return button;
}

/** The `+ Añadir script` button of the nth step card. */
function addScriptButton(index = 0): HTMLButtonElement {
  const card = document.querySelectorAll<HTMLElement>('.prestep-card')[index];
  const button = Array.from(
    card?.querySelectorAll<HTMLButtonElement>('button') ?? [],
  ).find((candidate) => candidate.textContent?.includes('Añadir script'));
  if (!button) throw new Error(`step #${index} drew no "add script" button`);
  return button;
}

function pickerItems(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.script-picker-item'),
  );
}

function pickerItem(name: string): HTMLButtonElement {
  const item = pickerItems().find(
    (candidate) => candidate.textContent === name,
  );
  if (!item) throw new Error(`the picker offers no "${name}"`);
  return item;
}

/** The trailing `×` of an element (script row or step header). */
function removeButton(scope: Element): HTMLButtonElement {
  const button = Array.from(
    scope.querySelectorAll<HTMLButtonElement>('button.danger'),
  ).find((candidate) => candidate.textContent === '×');
  if (!button) throw new Error('no remove button in that scope');
  return button;
}

function modeButton(cardIndex: number, label: string): HTMLButtonElement {
  const card =
    document.querySelectorAll<HTMLElement>('.prestep-card')[cardIndex];
  const button = Array.from(
    card?.querySelectorAll<HTMLButtonElement>('.mode-btn') ?? [],
  ).find((candidate) => candidate.textContent?.startsWith(label));
  if (!button) throw new Error(`step #${cardIndex} has no "${label}" button`);
  return button;
}

describe('renderer/pipeline-editor.ts', () => {
  let editorWindow: RendererWindow | null = null;

  afterEach(() => {
    editorWindow?.close();
    editorWindow = null;
    vi.restoreAllMocks();
  });

  async function openEditor(options: { groups?: Group[] } = {}): Promise<{
    win: RendererWindow;
    editor: PipelineEditorHandle;
    toasts: Array<{ message: string; kind?: string | undefined }>;
  }> {
    const win = await loadRendererWindow({
      html: 'config.html',
      // The editor is a factory the config window mounts, not an entry point
      // of its own, so there is nothing to evaluate on load.
      load: () => Promise.resolve(),
      values: { platform: 'macos' },
    });
    editorWindow = win;
    const toasts: Array<{ message: string; kind?: string | undefined }> = [];
    const known = options.groups ?? [];
    const editor = initPipelineEditor(pipelineHost(), {
      getGroups: () => known,
      showToast: (message, kind) => toasts.push({ message, kind }),
    });
    // The auto-run setting is read once at mount; the first render waits for
    // it either way.
    await win.settle('getSettings', { preScriptsAutoRun: false });
    return { win, editor, toasts };
  }

  /** Opens the editor and lands `steps` as the first pipeline read. */
  async function openWith(steps: PreStep[]): Promise<{
    win: RendererWindow;
    editor: PipelineEditorHandle;
    toasts: Array<{ message: string; kind?: string | undefined }>;
  }> {
    const opened = await openEditor({ groups: groups() });
    void opened.editor.refresh();
    await opened.win.settle('getPreSteps', steps);
    return opened;
  }

  describe('pipeline steps', () => {
    it('renders the read when nothing newer has landed', async () => {
      const { win, editor } = await openEditor();
      void editor.refresh();
      await win.settle('getPreSteps', [step('uno')]);
      expect(stepIds()).toEqual(['uno']);
    });

    it('keeps the newer pipeline when an older read resolves after it', async () => {
      // Every mutation here is an instant write followed by a full re-read,
      // and nothing serializes them: two quick clicks on «+ Añadir paso» put
      // two reads in flight, and the older one landing last drops the step
      // the second click just created.
      const { win, editor } = await openEditor();
      void editor.refresh();
      await win.settle('getPreSteps', [step('uno')]);

      const addStep = addStepButton();
      addStep.click();
      addStep.click();
      await win.settle('savePreStep', { ok: true });
      await win.settle('savePreStep', { ok: true });
      expect(
        win.callCount('getPreSteps'),
        'both clicks must have issued their own re-read',
      ).toBe(3);

      await win.settleNewest('getPreSteps', [
        step('uno'),
        step('dos'),
        step('tres'),
      ]);
      await win.settle('getPreSteps', [step('uno'), step('dos')]);
      expect(stepIds()).toEqual(['uno', 'dos', 'tres']);
    });

    it('invites the user to create the first step when the pipeline is empty', async () => {
      await openWith([]);
      expect(document.querySelector('.prestep-empty')?.textContent).toBe(
        'Sin pasos. Pulsa «+ Añadir paso» para comenzar.',
      );
      expect(stepIds()).toEqual([]);
    });

    it('offers an empty step as a drop target instead of a blank card', async () => {
      await openWith([step('uno')]);
      const list = document.querySelector('.prescript-list');
      expect(list?.classList.contains('prestep-empty-dropzone')).toBe(true);
      expect(list?.querySelector('.prestep-drop-hint')?.textContent).toBe(
        'Suelta un script aquí',
      );
    });
  });

  describe('a step that holds scripts', () => {
    it('draws one row per ref, keyed by group and script', async () => {
      await openWith([
        filledStep('uno', [ref('back', 'setup'), ref('front', 'deps')]),
      ]);
      expect(scriptRowIds()).toEqual(['back::setup', 'front::deps']);
    });

    it('names the script and the group that owns it', async () => {
      await openWith([filledStep('uno', [ref('back', 'setup')])]);
      const row = document.querySelector('.prescript-row');
      expect(row?.querySelector('strong')?.textContent).toBe('Make setup');
      expect(row?.querySelector('.pipeline-group-name')?.textContent).toBe(
        'Back',
      );
      expect(
        row?.querySelector('.pipeline-group-badge')?.getAttribute('title'),
      ).toBe('Back — /repos/back');
    });

    it('prints the command with its arguments', async () => {
      await openWith([filledStep('uno', [ref('back', 'setup')])]);
      expect(document.querySelector('.prescript-row code')?.textContent).toBe(
        'make setup',
      );
    });

    it('shows the timeout of a script that has one, in seconds', async () => {
      await openWith([filledStep('uno', [ref('back', 'seed')])]);
      const badges = Array.from(
        document.querySelectorAll('.prescript-row .muted.small'),
        (el) => el.textContent,
      );
      expect(badges).toContain('⏱ 90s');
    });

    it('renders a dangling ref instead of throwing on it', async () => {
      // Referential integrity is enforced on every persist, but a
      // hand-edited store file can still leave a ref pointing at nothing.
      await openWith([filledStep('uno', [ref('back', 'deleted')])]);
      expect(document.querySelector('.prescript-row')?.textContent).toContain(
        'Referencia rota (script eliminado)',
      );
      expect(scriptRowIds()).toEqual(['back::deleted']);
    });

    it('marks which execution mode the step is in', async () => {
      await openWith([filledStep('uno', [ref('back', 'setup')], 'serial')]);
      expect(modeButton(0, 'Paralelo').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(modeButton(0, 'Serie').getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('the summary strip', () => {
    it('counts steps, scripts and the groups they come from', async () => {
      await openWith([
        filledStep('uno', [ref('back', 'setup'), ref('front', 'deps')]),
        filledStep('dos', [ref('back', 'seed')]),
      ]);
      expect(
        document.querySelector('.pipeline-summary-count')?.textContent,
      ).toBe('2 pasos · 3 scripts · 2 grupos');
    });

    it('uses singular wording for a one-of-everything pipeline', async () => {
      await openWith([filledStep('uno', [ref('back', 'setup')])]);
      expect(
        document.querySelector('.pipeline-summary-count')?.textContent,
      ).toBe('1 paso · 1 script · 1 grupo');
    });

    it('highlights a step that really runs in parallel', async () => {
      // A single-script "parallel" step behaves exactly like a serial one,
      // so only a step with more than one script earns the accent.
      await openWith([
        filledStep('uno', [ref('back', 'setup'), ref('front', 'deps')]),
        filledStep('dos', [ref('back', 'seed')]),
      ]);
      const blocks = document.querySelectorAll('.pipeline-summary-step');
      expect(blocks[0]?.classList.contains('is-parallel')).toBe(true);
      expect(blocks[1]?.classList.contains('is-parallel')).toBe(false);
      expect(
        blocks[0]?.querySelector('.pipeline-summary-step-head')?.textContent,
      ).toBe('1 · ∥');
    });

    it('marks an empty step as empty rather than drawing no lane', async () => {
      await openWith([step('uno')]);
      const block = document.querySelector('.pipeline-summary-step');
      expect(block?.classList.contains('is-empty')).toBe(true);
      expect(block?.querySelector('.pipeline-summary-lane')?.textContent).toBe(
        'vacío',
      );
    });

    it('shows a broken lane for a ref that no longer resolves', async () => {
      await openWith([filledStep('uno', [ref('back', 'deleted')])]);
      expect(
        document.querySelector('.pipeline-summary-lane')?.textContent,
      ).toBe('Referencia rota');
    });

    it('labels a serial step with an arrow instead of the parallel bars', async () => {
      await openWith([
        filledStep(
          'uno',
          [ref('back', 'setup'), ref('front', 'deps')],
          'serial',
        ),
      ]);
      expect(
        document.querySelector('.pipeline-summary-step-head')?.textContent,
      ).toBe('1 · →');
    });
  });

  describe('the script picker', () => {
    it('lists every group that defines a pre-script', async () => {
      await openWith([step('uno')]);
      addScriptButton().click();
      expect(pickerItems().map((item) => item.textContent)).toEqual([
        'Make setup',
        'Seed',
        'Install deps',
      ]);
    });

    it('closes again on a second click of the same button', async () => {
      await openWith([step('uno')]);
      addScriptButton().click();
      expect(pickerItems()).not.toHaveLength(0);
      addScriptButton().click();
      expect(pickerItems()).toHaveLength(0);
    });

    it('disables a script that is already somewhere in the pipeline', async () => {
      // A ref placed twice shares one process id, so the second placement
      // would never really run — the picker is where that is prevented.
      await openWith([filledStep('uno', [ref('back', 'setup')]), step('dos')]);
      addScriptButton(1).click();
      expect(pickerItem('Make setup').disabled).toBe(true);
      expect(pickerItem('Make setup').title).toBe('Ya está en el pipeline');
      expect(pickerItem('Seed').disabled).toBe(false);
    });

    it('explains where to create scripts when no group defines any', async () => {
      const { win, editor } = await openEditor({
        groups: [normalizeGroup({ id: 'back', name: 'Back', path: '/b' })],
      });
      void editor.refresh();
      await win.settle('getPreSteps', [step('uno')]);
      addScriptButton().click();
      expect(document.querySelector('.script-picker p')?.textContent).toBe(
        'No hay pre-scripts definidos. Créalos primero en la ficha de cada grupo.',
      );
      expect(pickerItems()).toHaveLength(0);
    });

    it('assigns the chosen script to that step and re-reads the pipeline', async () => {
      const { win } = await openWith([step('uno')]);
      addScriptButton().click();
      pickerItem('Seed').click();
      await win.settle('assignScriptToStep', { ok: true });
      await win.settle('getPreSteps', [
        filledStep('uno', [ref('back', 'seed')]),
      ]);
      expect(scriptRowIds()).toEqual(['back::seed']);
      // The picker closes once the choice lands.
      expect(pickerItems()).toHaveLength(0);
    });
  });

  describe('mutating a step', () => {
    it('removes a script from the step it was clicked in', async () => {
      const { win } = await openWith([
        filledStep('uno', [ref('back', 'setup'), ref('front', 'deps')]),
      ]);
      const row = document.querySelectorAll('.prescript-row')[0];
      if (!row) throw new Error('no script row to remove');
      removeButton(row).click();
      await win.settle('unassignScriptFromStep', { ok: true });
      await win.settle('getPreSteps', [
        filledStep('uno', [ref('front', 'deps')]),
      ]);
      expect(scriptRowIds()).toEqual(['front::deps']);
    });

    it('switches the step to the mode that was clicked', async () => {
      const { win } = await openWith([
        filledStep('uno', [ref('back', 'setup')]),
      ]);
      modeButton(0, 'Serie').click();
      await win.settle('savePreStep', { ok: true });
      await win.settle('getPreSteps', [
        filledStep('uno', [ref('back', 'setup')], 'serial'),
      ]);
      expect(modeButton(0, 'Serie').getAttribute('aria-pressed')).toBe('true');
    });

    it('asks before deleting a step, and does nothing when told no', async () => {
      const { win } = await openWith([step('uno')]);
      const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const header = document.querySelector('.prestep-card-header');
      if (!header) throw new Error('no step header');
      removeButton(header).click();
      expect(confirmed).toHaveBeenCalledWith('¿Eliminar el paso 1?');
      expect(win.callCount('deletePreStep')).toBe(0);
      expect(stepIds()).toEqual(['uno']);
    });

    it('deletes the step once the confirmation is accepted', async () => {
      const { win } = await openWith([step('uno'), step('dos')]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const header = document.querySelector('.prestep-card-header');
      if (!header) throw new Error('no step header');
      removeButton(header).click();
      expect(win.callCount('deletePreStep')).toBe(1);
      await win.settle('deletePreStep', { ok: true });
      await win.settle('getPreSteps', [step('dos')]);
      expect(stepIds()).toEqual(['dos']);
    });
  });

  describe('when a write fails', () => {
    it('says so and repaints from what is actually stored', async () => {
      // Without this the handlers left the screen showing a change that was
      // never persisted, and the rejection surfaced as an unhandled promise.
      const { win, toasts } = await openWith([step('uno')]);
      addStepButton().click();
      await win.fail('savePreStep', new Error('disco lleno'));
      await win.settle('getPreSteps', [step('uno')]);
      expect(toasts).toEqual([
        { message: 'No se pudo guardar el pipeline', kind: 'error' },
      ]);
      expect(stepIds()).toEqual(['uno']);
    });

    it('still settles when the recovery read fails too', async () => {
      const { win, toasts } = await openWith([step('uno')]);
      addStepButton().click();
      await win.fail('savePreStep', new Error('disco lleno'));
      await win.fail('getPreSteps', new Error('tampoco se puede leer'));
      expect(toasts.map((toast) => toast.message)).toEqual([
        'No se pudo guardar el pipeline',
        'No se pudo recargar el pipeline',
      ]);
    });
  });

  describe('auto-run toggle', () => {
    it('rolls the control back when its own save fails', async () => {
      const { win, editor } = await openEditor();
      void editor.refresh();
      await win.settle('getPreSteps', []);
      const toggle = autoRunToggle();
      toggle.click();
      await win.fail('saveSettings', new Error('no se pudo escribir'));
      expect(toggle.checked).toBe(false);
    });

    it('leaves a newer toggle alone when an older save fails', async () => {
      // The rollback is an async result written straight into the control:
      // two quick clicks, and a rejection from the FIRST one flips a checkbox
      // whose value the second one already persisted.
      const { win, editor } = await openEditor();
      void editor.refresh();
      await win.settle('getPreSteps', []);
      const toggle = autoRunToggle();
      toggle.click();
      toggle.click();
      expect(
        win.callCount('saveSettings'),
        'both clicks must have issued their own save',
      ).toBe(2);
      await win.settleNewest('saveSettings', { ok: true });
      await win.fail('saveSettings', new Error('no se pudo escribir'));
      expect(toggle.checked).toBe(false);
    });

    it('confirms a save that landed', async () => {
      const { win, editor, toasts } = await openEditor();
      void editor.refresh();
      await win.settle('getPreSteps', []);
      autoRunToggle().click();
      await win.settle('saveSettings', { ok: true });
      expect(toasts).toEqual([{ message: 'Ajustes guardados', kind: 'ok' }]);
      expect(autoRunToggle().checked).toBe(true);
    });

    it('paints the stored value once the setting has been read', async () => {
      const win = await loadRendererWindow({
        html: 'config.html',
        load: () => Promise.resolve(),
        values: { platform: 'macos' },
      });
      editorWindow = win;
      initPipelineEditor(pipelineHost(), {
        getGroups: () => [],
        showToast: () => undefined,
      });
      await win.settle('getSettings', { preScriptsAutoRun: true });
      expect(autoRunToggle().checked).toBe(true);
      expect(autoRunToggle().disabled).toBe(false);
    });

    it('says so and leaves the control usable when the setting cannot be read', async () => {
      const win = await loadRendererWindow({
        html: 'config.html',
        load: () => Promise.resolve(),
        values: { platform: 'macos' },
      });
      editorWindow = win;
      const toasts: string[] = [];
      initPipelineEditor(pipelineHost(), {
        getGroups: () => [],
        showToast: (message) => toasts.push(message),
      });
      await win.fail('getSettings', new Error('sin ajustes'));
      expect(toasts).toEqual(['No se pudieron leer los ajustes']);
      // Still enabled: the read is over, so a click is no longer racing it.
      expect(autoRunToggle().disabled).toBe(false);
      expect(autoRunToggle().checked).toBe(false);
    });
  });
});
