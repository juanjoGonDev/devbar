// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { iconText } from './helpers/icon-text.js';
import { tipOf } from './helpers/tip.js';
import {
  all,
  blk,
  blockEl,
  button,
  canvas,
  chain,
  click,
  DEPS,
  dragPointer,
  edgesOf,
  editorHarness,
  graph,
  groups,
  node,
  pipelineHost,
  pointer,
  press,
  query,
  ref,
  SEED,
  SETUP,
  textOf,
  tick,
} from './helpers/pipeline-editor.js';
import { loadRendererWindow } from './helpers/renderer-dom.js';
import { initPipelineEditor } from '../renderer/pipeline-editor.js';
import type { Pipeline } from '../src/domain-types.js';
import { startupEntries } from './helpers/startup-workflow.js';

describe('renderer/pipeline-editor.ts', () => {
  const { openWith, written, adopt } = editorHarness();

  describe('the canvas', () => {
    it('draws the fixed trigger as "Al iniciar" with a bolt and a lock only', async () => {
      await openWith(chain());
      const trigger = query('.pipeline-trigger');
      expect(trigger.textContent).toContain('Al iniciar');
      expect(iconText(trigger)).toMatch(/^\[zap\].*\[lock\]$/);
      // Not a node: nothing to select, drag or delete — it opens its settings.
      expect(trigger.getAttribute('role')).toBe('button');
      expect(trigger.getAttribute('aria-label')).toBe(
        'Desencadenante: Al iniciar',
      );
      expect(trigger.classList.contains('pipeline-node')).toBe(false);
    });

    it('draws every block at its stored position', async () => {
      await openWith(chain());
      expect(blockEl('a').style.left).toBe('300px');
      expect(blockEl('a').style.top).toBe('40px');
      expect(blockEl('b').style.left).toBe('600px');
    });

    it('shows the group tile and the script name only — no command', async () => {
      await openWith(chain());
      const setup = node('Make setup');
      expect(Array.from(setup.children, (child) => child.className)).toEqual([
        'group-tile pipeline-node-tile',
        'pipeline-node-name',
      ]);
      expect(setup.textContent).not.toContain('make setup');
      expect(iconText(setup.querySelector('.group-tile'))).toBe('[server]');
      expect(
        setup
          .querySelector<HTMLElement>('.group-tile')
          ?.style.getPropertyValue('--tile-color'),
      ).toBe('#3b82f6');
      expect(setup.getAttribute('aria-label')).toBe('Make setup, Back');
    });

    it('frames a parallel block as "En paralelo"', async () => {
      await openWith(graph([blk('p', [SETUP, DEPS], 300, 40)], ['trigger>p']));
      const frame = blockEl('p');
      expect(frame.classList.contains('is-frame')).toBe(true);
      expect(textOf(frame.querySelector('.pipeline-frame-label'))).toBe(
        'En paralelo',
      );
      expect(frame.querySelectorAll('.pipeline-node')).toHaveLength(2);
    });

    it('draws each connection as a curve between the two pins', async () => {
      await openWith(chain());
      const edges = all('.pipeline-edge');
      expect(edges.map((e) => `${e.dataset.from}>${e.dataset.to}`)).toEqual([
        'trigger>a',
        'a>b',
      ]);
      // Trigger out pin (172, 60) → setup's input pin (300, 60).
      expect(
        edges[0]?.querySelector('.pipeline-edge-line')?.getAttribute('d'),
      ).toBe('M 172 60 C 236 60, 236 60, 300 60');
    });

    it('dims a block that will not run and says why', async () => {
      await openWith(
        graph([blk('a', [SETUP], 300, 40), blk('b', [DEPS], 600, 40)], ['a>b']),
      );
      for (const id of ['a', 'b']) {
        const block = blockEl(id);
        expect(block.classList.contains('is-disconnected')).toBe(true);
        expect(tipOf(block.querySelector('.pipeline-block-warning'))).toBe(
          'Sin conectar: no se ejecutará',
        );
      }
      expect(node('Install deps').getAttribute('aria-label')).toBe(
        'Install deps, Front, sin conectar',
      );
    });

    it('offers a "+" only where an output has no connection', async () => {
      await openWith(chain());
      expect(all('.pipeline-stub').map((stub) => stub.dataset.block)).toEqual([
        'b',
      ]);
    });

    it('offers a "+" on the trigger of an empty pipeline', async () => {
      await openWith(graph([], []));
      expect(all('.pipeline-stub').map((stub) => stub.dataset.block)).toEqual([
        'trigger',
      ]);
    });

    it('draws a dangling ref as broken instead of throwing on it', async () => {
      await openWith(
        graph([blk('a', [ref('gone', 'x')], 300, 40)], ['trigger>a']),
      );
      expect(node('Referencia rota').classList.contains('is-broken')).toBe(
        true,
      );
    });

    it('counts the placed scripts in the status pill', async () => {
      await openWith(
        graph(
          [blk('p', [SETUP, DEPS], 300, 40), blk('s', [SEED], 600, 40)],
          ['trigger>p', 'p>s'],
        ),
      );
      expect(query('.wf-run-count').textContent).toBe('3 scripts');
    });
  });

  describe('edges', () => {
    it('deletes a connection from its ×', async () => {
      const { win } = await openWith(chain());
      click(query('.pipeline-edge-delete[data-from="a"]'));
      expect(edgesOf(await written(win))).toEqual(['trigger>a']);
    });

    it('names the connection its × removes, and takes Enter too', async () => {
      const { win } = await openWith(chain());
      const remove = query('.pipeline-edge-delete[data-from="a"]');
      expect(remove.getAttribute('aria-label')).toBe(
        'Quitar la conexión de Make setup a Install deps',
      );
      press(remove, 'Enter');
      expect(edgesOf(await written(win))).toEqual(['trigger>a']);
    });
  });

  describe('connecting', () => {
    const loose = (): Pipeline =>
      graph(
        [
          blk('a', [SETUP], 300, 40),
          blk('b', [DEPS], 600, 40),
          blk('c', [SEED], 600, 200),
        ],
        ['trigger>a'],
      );

    it('connects an output pin to the node it is dropped on', async () => {
      const { win } = await openWith(loose());
      const pin = query('.pipeline-pin.is-out[data-block="a"]');
      dragPointer(pin, [448, 60], [620, 60]);
      expect(edgesOf(await written(win))).toEqual(['trigger>a', 'a>b']);
    });

    it('draws a dashed line while dragging', async () => {
      await openWith(loose());
      const pin = query('.pipeline-pin.is-out[data-block="a"]');
      pointer(pin, 'pointerdown', 448, 60);
      pointer(window, 'pointermove', 520, 120);
      expect(query('.pipeline-edge-draft').getAttribute('d')).not.toBe('');
      pointer(window, 'pointerup', 520, 120);
      expect(query('.pipeline-edge-draft').getAttribute('d')).toBe('');
    });

    it('lets one output fan out into parallel branches', async () => {
      const { win } = await openWith(loose());
      dragPointer(
        query('.pipeline-pin.is-out[data-block="a"]'),
        [448, 60],
        [620, 60],
      );
      await written(win);
      dragPointer(
        query('.pipeline-pin.is-out[data-block="a"]'),
        [448, 60],
        [620, 220],
      );
      expect(edgesOf(await written(win))).toEqual(['trigger>a', 'a>b', 'a>c']);
    });

    it('refuses a connection that would close a cycle, and says so', async () => {
      const { win, toasts } = await openWith(chain());
      dragPointer(
        query('.pipeline-pin.is-out[data-block="b"]'),
        [748, 60],
        [320, 60],
      );
      expect(win.callCount('saveWorkflow')).toBe(0);
      expect(toasts).toEqual([
        { message: 'Esa conexión cerraría un ciclo', kind: 'error' },
      ]);
    });

    it('refuses a connection that already exists', async () => {
      const { toasts } = await openWith(chain());
      dragPointer(
        query('.pipeline-pin.is-out[data-block="a"]'),
        [448, 60],
        [620, 60],
      );
      expect(toasts.map((t) => t.message)).toEqual(['Esa conexión ya existe']);
    });

    it('drops a connection released over empty canvas', async () => {
      const { win, toasts } = await openWith(loose());
      dragPointer(
        query('.pipeline-pin.is-out[data-block="a"]'),
        [448, 60],
        [1000, 900],
      );
      expect(win.callCount('saveWorkflow')).toBe(0);
      expect(toasts).toEqual([]);
    });
  });

  describe('moving nodes', () => {
    it('moves a dragged node and writes its new position once', async () => {
      const { win } = await openWith(chain());
      dragPointer(node('Install deps'), [620, 60], [700, 160]);
      expect(blockEl('b').style.left).toBe('680px');
      await tick();
      expect(win.callCount('saveWorkflow')).toBe(1);
      const stored = await written(win);
      expect(stored.blocks.find((b) => b.id === 'b')).toMatchObject({
        x: 680,
        y: 140,
      });
    });

    it('treats a press without travel as a click, not a move', async () => {
      const { win } = await openWith(chain());
      dragPointer(node('Install deps'), [620, 60], [621, 60]);
      await tick();
      expect(win.callCount('saveWorkflow')).toBe(0);
    });

    it('joins a node dropped onto another one, in parallel', async () => {
      const { win } = await openWith(chain());
      dragPointer(node('Install deps'), [620, 60], [320, 60]);
      const stored = await written(win);
      expect(stored.blocks.map((b) => b.scripts)).toEqual([[SETUP, DEPS]]);
    });
  });

  describe('a selected node', () => {
    it('shows its toolbar: Editar and Quitar', async () => {
      await openWith(chain(), { editScript: () => undefined });
      click(node('Make setup'));
      expect(node('Make setup').classList.contains('is-selected')).toBe(true);
      const labels = all('.pipeline-node-toolbar button').map((b) =>
        b.getAttribute('aria-label'),
      );
      expect(labels).toEqual(['Editar', 'Quitar']);
    });

    it('offers "Sacar del grupo" inside a frame only', async () => {
      const { win } = await openWith(
        graph([blk('p', [SETUP, DEPS], 300, 40)], ['trigger>p']),
      );
      click(node('Install deps'));
      click(button('Sacar del grupo'));
      const stored = await written(win);
      expect(stored.blocks.map((b) => b.scripts)).toEqual([[SETUP], [DEPS]]);
      expect(stored.edges).toHaveLength(2);
    });

    it('opens the pre-script editor from "Editar"', async () => {
      const editScript = vi.fn();
      await openWith(chain(), { editScript });
      click(node('Make setup'));
      click(button('Editar'));
      expect(editScript).toHaveBeenCalledWith(
        'back',
        expect.objectContaining({ id: 'setup' }),
      );
    });

    it('takes the script out of the pipeline from "Quitar"', async () => {
      const { win } = await openWith(chain());
      click(node('Make setup'));
      click(button('Quitar'));
      const stored = await written(win);
      expect(stored.blocks.map((b) => b.id)).toEqual(['b']);
    });

    it('is deselected by Escape and by a click on empty canvas', async () => {
      await openWith(chain());
      click(node('Make setup'));
      press(node('Make setup'), 'Escape');
      expect(document.querySelector('.pipeline-node.is-selected')).toBeNull();
      click(node('Make setup'));
      click(canvas());
      expect(document.querySelector('.pipeline-node.is-selected')).toBeNull();
    });

    it('removes the focused node with Delete or Backspace', async () => {
      const { win } = await openWith(chain());
      press(node('Install deps'), 'Delete');
      expect((await written(win)).blocks.map((b) => b.id)).toEqual(['a']);
      press(node('Make setup'), 'Backspace');
      expect((await written(win)).blocks).toEqual([]);
    });
  });

  describe('reads and writes', () => {
    it('keeps the newer pipeline when an older read resolves after it', async () => {
      const { win, editor } = await openWith(graph([], []));
      void editor.refresh();
      void editor.refresh();
      await win.settleNewest('listWorkflows', startupEntries(chain()));
      await win.settle('listWorkflows', startupEntries(graph([], [])));
      expect(all('.pipeline-node')).toHaveLength(2);
    });

    it('says so and repaints from what is actually stored when a write fails', async () => {
      const { win, toasts } = await openWith(chain());
      press(node('Make setup'), 'Delete');
      expect(all('.pipeline-node')).toHaveLength(1);
      await tick();
      await win.fail('saveWorkflow', new Error('disco lleno'));
      await win.settle('listWorkflows', startupEntries(chain()));
      // Main's own reason, as it rejected the write.
      expect(toasts).toEqual([{ message: 'disco lleno', kind: 'error' }]);
      expect(all('.pipeline-node')).toHaveLength(2);
    });

    it('still settles when the recovery read fails too', async () => {
      const { win, toasts } = await openWith(chain());
      press(node('Make setup'), 'Delete');
      await tick();
      await win.fail('saveWorkflow', new Error('disco lleno'));
      await win.fail('listWorkflows', new Error('tampoco se puede leer'));
      expect(toasts.map((toast) => toast.message)).toEqual([
        'disco lleno',
        'No se pudo recargar el workflow',
      ]);
    });

    it('writes edits one after another, in order', async () => {
      const { win } = await openWith(chain());
      press(node('Install deps'), 'Delete');
      press(node('Make setup'), 'Delete');
      await tick();
      expect(win.callCount('saveWorkflow')).toBe(1);
      await written(win);
      expect(win.callCount('saveWorkflow')).toBe(2);
      expect((await written(win)).blocks).toEqual([]);
    });

    it('repaints from a refresh after the groups changed elsewhere', async () => {
      const known = groups();
      const win = await loadRendererWindow({
        html: 'config.html',
        load: () => Promise.resolve(),
        values: { platform: 'macos' },
      });
      adopt(win);
      const editor = initPipelineEditor(pipelineHost(), {
        getGroups: () => known,
        showToast: () => undefined,
      });
      void editor.refresh();
      await win.settle('listWorkflows', startupEntries(chain()));
      known[0].preScripts[0].name = 'Setup renombrado';
      void editor.refresh();
      await win.settle('listWorkflows', startupEntries(chain()));
      expect(node('Setup renombrado')).toBeTruthy();
    });
  });
});
