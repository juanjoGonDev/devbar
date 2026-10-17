// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { iconText } from './helpers/icon-text.js';
import { tipOf } from './helpers/tip.js';
import {
  DEPS,
  SEED,
  SETUP,
  all,
  blk,
  blockEl,
  button,
  chain,
  click,
  editorHarness,
  graph,
  node,
  press,
  query,
  textOf,
  tick,
} from './helpers/pipeline-editor.js';
import { runState } from './helpers/workflows.js';
import { startupEntries } from './helpers/startup-workflow.js';
import type { Pipeline, Workflow } from '../src/domain-types.js';

/** 12.3s after the fixture run started at t=1000. */
const NOW = 13_300;

const parallel = (): Pipeline =>
  graph(
    [blk('p', [SETUP, DEPS], 300, 40), blk('s', [SEED], 600, 40)],
    ['trigger>p', 'p>s'],
  );

function edge(id: string): Element {
  const [from, to] = id.split('>');
  const found = all('.pipeline-edge').find(
    (e) => e.dataset.from === from && e.dataset.to === to,
  );
  if (!found) throw new Error(`no ${id} edge`);
  return found;
}

describe('renderer/pipeline-editor.ts (runs)', () => {
  const { openWith, written } = editorHarness();

  async function openRun(
    pipeline: Pipeline,
    status: Parameters<typeof runState>[2],
    blocks: Parameters<typeof runState>[3],
  ) {
    const opened = await openWith(pipeline, {
      entries: () => startupEntries(pipeline),
      now: () => NOW,
    });
    opened.editor.setRun(runState('w-start', pipeline, status, blocks));
    return opened;
  }

  describe('the canvas', () => {
    it('paints each node with how its script is doing', async () => {
      await openRun(chain(), 'running', { a: 'success', b: 'running' });
      const done = node('Make setup');
      expect(done.classList.contains('is-run-success')).toBe(true);
      expect(iconText(done.querySelector('.pipeline-node-state'))).toBe(
        '[check]',
      );
      expect(textOf(done.querySelector('.pipeline-node-caption'))).toBe('3s');
      const busy = node('Install deps');
      expect(busy.classList.contains('is-run-running')).toBe(true);
      expect(busy.querySelector('.pipeline-spinner')).not.toBeNull();
      expect(textOf(busy.querySelector('.pipeline-node-caption'))).toBe(
        'ejecutando · 0:12',
      );
    });

    it('marks waiting, failed and skipped scripts their own way', async () => {
      await openRun(parallel(), 'error', { p: 'error', s: 'skipped' });
      expect(blockEl('p').classList.contains('is-run-error')).toBe(true);
      const skipped = node('Seed');
      expect(skipped.classList.contains('is-run-skipped')).toBe(true);
      expect(textOf(skipped.querySelector('.pipeline-node-skipped'))).toBe(
        'omitido',
      );
      expect(skipped.querySelector('.pipeline-node-state')).toBeNull();
      // Inside a frame the duration goes to the tooltip, not under the node.
      expect(
        node('Make setup').querySelector('.pipeline-node-caption'),
      ).toBeNull();
      expect(tipOf(node('Make setup'))).toBe('3s');
    });

    it('draws a waiting script with a clock ring', async () => {
      await openRun(chain(), 'running', { a: 'running', b: 'waiting' });
      expect(
        iconText(node('Install deps').querySelector('.pipeline-node-state')),
      ).toBe('[clock]');
    });

    it('colours each edge by the block it leads into, flowing into a running one', async () => {
      await openRun(chain(), 'running', { a: 'success', b: 'running' });
      expect(edge('trigger>a').classList.contains('is-run-success')).toBe(true);
      expect(edge('a>b').classList.contains('is-run-running')).toBe(true);
      expect(edge('a>b').classList.contains('is-flowing')).toBe(true);
      expect(edge('trigger>a').classList.contains('is-flowing')).toBe(false);
    });

    it('shows the legend only while a run is on the canvas', async () => {
      const { editor } = await openWith(chain());
      expect(query('.wf-legend').hidden).toBe(true);
      editor.setRun(runState('w-start', chain(), 'running', { a: 'running' }));
      expect(query('.wf-legend').hidden).toBe(false);
      expect(textOf(query('.wf-legend'))).toBe(
        'En esperaEjecutandoCorrectoCon avisosErrorOmitido',
      );
    });
  });

  describe('the status pill', () => {
    it('counts the scripts and runs the workflow when idle', async () => {
      const { win } = await openWith(chain(), {
        entries: () =>
          startupEntries(chain()).map((e) => ({ ...e, scriptCount: 2 })),
      });
      expect(textOf(query('.wf-run-status'))).toBe('2 scriptsEjecutar');
      click(button('Ejecutar'));
      expect(win.argsFor('runWorkflow')).toEqual([['w-start']]);
      await win.settle('runWorkflow', { ok: true });
    });

    it('explains why there is nothing to run', async () => {
      const { win } = await openWith(chain(), {
        entries: () => startupEntries(chain()),
      });
      const run = button('Ejecutar');
      expect(run.getAttribute('aria-disabled')).toBe('true');
      expect(tipOf(run)).toBe('Sin scripts conectados');
      click(run);
      expect(win.callCount('runWorkflow')).toBe(0);
    });

    it('shows progress and time while running, with a stop button', async () => {
      const { editor, win } = await openWith(chain(), { now: () => NOW });
      editor.setRun(
        runState(
          'w-start',
          chain(),
          'running',
          { a: 'running' },
          {
            doneScripts: 1,
            totalScripts: 2,
          },
        ),
      );
      expect(textOf(query('.wf-run-status'))).toBe(
        'Ejecutando · 1/212sDetener',
      );
      click(button('Detener'));
      expect(win.argsFor('stopWorkflow')).toEqual([['w-start']]);
    });

    it('says how the last run ended and when', async () => {
      const { editor } = await openWith(chain(), {
        now: () => 5_000 + 600_000,
      });
      editor.setRun(runState('w-start', chain(), 'error', { a: 'error' }));
      expect(textOf(query('.wf-run-status'))).toBe('Errorhace 10 min');
      expect(
        query('.wf-run-status .wf-dot').classList.contains('is-error'),
      ).toBe(true);
      expect(query('.wf-run-btn').getAttribute('aria-label')).toBe('Ejecutar');
    });
  });

  describe('editing during a run', () => {
    it('refuses structural edits while it runs', async () => {
      const { win, toasts } = await openRun(chain(), 'running', {
        a: 'running',
      });
      press(node('Install deps'), 'Delete');
      await tick();
      expect(win.callCount('saveWorkflow')).toBe(0);
      expect(toasts.at(-1)?.message).toBe('No disponible durante la ejecución');
      expect(all('.pipeline-node')).toHaveLength(2);
    });

    it('disables what would change the structure, saying why', async () => {
      await openRun(parallel(), 'running', { p: 'running' });
      click(node('Seed'));
      const remove = button('Quitar');
      expect(remove.getAttribute('aria-disabled')).toBe('true');
      expect(tipOf(remove)).toBe('No disponible durante la ejecución');
      expect(query('.pipeline-stub').getAttribute('aria-disabled')).toBe(
        'true',
      );
      click(remove);
      expect(all('.pipeline-node')).toHaveLength(3);
    });

    it('still lets the layout be tidied', async () => {
      const { win } = await openRun(chain(), 'running', { a: 'running' });
      click(button('Ordenar automáticamente'));
      expect((await written(win)).blocks).toHaveLength(2);
    });
  });

  describe('node toolbar', () => {
    it('offers the log only for a script the run has seen', async () => {
      const { editor } = await openWith(chain());
      click(node('Make setup'));
      expect(() => button('Ver log')).toThrow();
      editor.setRun(runState('w-start', chain(), 'running', { a: 'running' }));
      click(node('Make setup'));
      click(node('Make setup'));
      expect(button('Ver log')).toBeTruthy();
    });

    it('retries from a failed block once the run has ended', async () => {
      const { win, editor } = await openWith(chain());
      editor.setRun(
        runState('w-start', chain(), 'running', { a: 'success', b: 'error' }),
      );
      click(node('Install deps'));
      expect(() => button('Reintentar')).toThrow();
      editor.setRun(
        runState('w-start', chain(), 'error', { a: 'success', b: 'error' }),
      );
      click(button('Reintentar'));
      expect(win.argsFor('retryWorkflowFrom')).toEqual([['w-start', 'b']]);
      await win.settle('retryWorkflowFrom', { ok: false, error: 'not_ready' });
    });
  });

  describe('frame toolbar', () => {
    it('toggles «Todos OK», marked on the label with a shield', async () => {
      const { win } = await openWith(parallel());
      const frame = blockEl('p');
      expect(iconText(frame.querySelector('.pipeline-frame-label'))).toBe(
        'En paralelo[shield-check]',
      );
      const toggle = frame.querySelector<HTMLElement>('.pipeline-require-all');
      expect(toggle?.getAttribute('aria-pressed')).toBe('true');
      expect(tipOf(toggle)).toBe('Si uno falla, se para');
      click(query('.pipeline-block[data-block="p"] .pipeline-require-all'));
      const saved = await written(win);
      expect(saved.blocks.find((b) => b.id === 'p')?.requireAll).toBe(false);
      expect(blockEl('p').querySelector('.pipeline-frame-shield')).toBeNull();
    });

    it('splits a frame back into single blocks, wired the same', async () => {
      const { win } = await openWith(parallel());
      click(
        query('.pipeline-block[data-block="p"] [aria-label="Deshacer grupo"]'),
      );
      const saved = await written(win);
      expect(saved.blocks.map((b) => b.scripts.length)).toEqual([1, 1, 1]);
      const split = saved.blocks.find((b) => b.scripts[0]?.scriptId === 'deps');
      expect(saved.edges).toContainEqual({ from: 'trigger', to: split?.id });
      expect(saved.edges).toContainEqual({ from: split?.id, to: 's' });
    });

    it('opens the log on the frame’s first script', async () => {
      const { editor, win } = await openWith(parallel());
      expect(blockEl('p').querySelector('[aria-label="Ver logs"]')).toBeNull();
      editor.setRun(
        runState('w-start', parallel(), 'running', { p: 'running' }),
      );
      click(query('.pipeline-block[data-block="p"] [aria-label="Ver logs"]'));
      expect(query('.wf-log').hidden).toBe(false);
      expect(win.argsFor('getWorkflowScriptLog')[0]).toEqual([
        'w-start',
        'latest',
        SETUP,
      ]);
    });
  });

  describe('breadcrumb', () => {
    it('names the workflow and its trigger, and goes back to the list', async () => {
      let back = 0;
      await openWith(chain(), {
        onBack: () => {
          back += 1;
        },
      });
      expect(query<HTMLInputElement>('.wf-crumb-name').value).toBe('Arranque');
      expect(textOf(query('.wf-crumb .wf-pill'))).toBe('Al arrancar');
      click(button('Workflows'));
      expect(back).toBe(1);
    });

    it('renames in place', async () => {
      const { win } = await openWith(chain());
      const name = query<HTMLInputElement>('.wf-crumb-name');
      name.focus();
      name.value = 'Entorno';
      name.dispatchEvent(new Event('change'));
      await tick();
      const saved = win.argsFor('saveWorkflow').at(-1)?.[0] as Workflow;
      expect(saved.name).toBe('Entorno');
      expect(saved.graph).toEqual(chain());
    });

    it('puts a blank name back as it was', async () => {
      const { win } = await openWith(chain());
      const name = query<HTMLInputElement>('.wf-crumb-name');
      name.value = '   ';
      name.dispatchEvent(new Event('change'));
      expect(name.value).toBe('Arranque');
      press(name, 'Escape');
      expect(win.callCount('saveWorkflow')).toBe(0);
    });
  });
});
