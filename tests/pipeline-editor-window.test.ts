// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import {
  initPipelineEditor,
  type PipelineEditorHandle,
} from '../renderer/pipeline-editor.js';
import type { PreStep } from '../src/domain-types.js';

function step(id: string): PreStep {
  return { id, mode: 'parallel', scripts: [] };
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

describe('renderer/pipeline-editor.ts', () => {
  let editorWindow: RendererWindow | null = null;

  afterEach(() => {
    editorWindow?.close();
    editorWindow = null;
  });

  async function openEditor(): Promise<{
    win: RendererWindow;
    editor: PipelineEditorHandle;
  }> {
    const win = await loadRendererWindow({
      html: 'config.html',
      // The editor is a factory the config window mounts, not an entry point
      // of its own, so there is nothing to evaluate on load.
      load: () => Promise.resolve(),
      values: { platform: 'macos' },
    });
    editorWindow = win;
    const editor = initPipelineEditor(pipelineHost(), {
      getGroups: () => [],
      showToast: () => undefined,
    });
    // The auto-run setting is read once at mount; the first render waits for
    // it either way.
    await win.settle('getSettings', { preScriptsAutoRun: false });
    return { win, editor };
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
  });
});
