// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { iconText } from './helpers/icon-text.js';
import { tipOf } from './helpers/tip.js';
import {
  all,
  blk,
  button,
  canvas,
  chain,
  chip,
  click,
  DEPS,
  dragPointer,
  dropChip,
  edgesOf,
  editorHarness,
  graph,
  groups,
  node,
  pointer,
  press,
  query,
  SEED,
  SETUP,
  textOf,
  transform,
  zoomText,
} from './helpers/pipeline-editor.js';
import { type PipelineEditorDeps } from '../renderer/pipeline-editor.js';
import { startupEntries } from './helpers/startup-workflow.js';

/**
 * The editor's floating tools: the pre-scripts panel, the "+" picker, the
 * zoom cluster with pan and fit, and the minimap.
 */
describe('renderer/pipeline-editor.ts', () => {
  const { openEditor, openWith, written } = editorHarness();

  describe('the pre-scripts panel', () => {
    it('lists every pre-script under its group, with the group tile', async () => {
      await openWith(chain());
      const names = all('.pipeline-palette-group-name').map(
        (n) => n.textContent,
      );
      expect(names).toEqual(['Back', 'Front']);
      expect(iconText(chip('Seed').querySelector('.group-tile'))).toBe(
        '[server]',
      );
    });

    it('dims a placed pre-script with a check and stops it from being dragged', async () => {
      await openWith(chain());
      const placed = chip('Make setup');
      expect(placed.classList.contains('is-placed')).toBe(true);
      expect(placed.draggable).toBe(false);
      expect(iconText(placed)).toMatch(/\[check\]$/);
      expect(chip('Seed').draggable).toBe(true);
    });

    it('filters by name as the user types', async () => {
      await openWith(chain());
      const search = query<HTMLInputElement>('.pipeline-palette-search');
      search.value = 'see';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(all('.pipeline-chip-name').map((n) => n.textContent)).toEqual([
        'Seed',
      ]);
    });

    it('places a pre-script dropped on empty canvas as a disconnected block there', async () => {
      const { win } = await openWith(chain());
      dropChip(chip('Seed'), canvas(), 474, 420);
      const stored = await written(win);
      const seed = stored.blocks.find((b) => b.scripts[0]?.scriptId === 'seed');
      expect(seed).toMatchObject({ x: 400, y: 400 });
      expect(stored.edges.some((edge) => edge.to === seed?.id)).toBe(false);
    });

    it('joins a pre-script dropped on a node', async () => {
      const { win } = await openWith(chain());
      dropChip(chip('Seed'), node('Make setup'));
      const stored = await written(win);
      expect(stored.blocks[0]?.scripts).toEqual([SETUP, SEED]);
    });

    it('wires a pre-script dropped on an output pin after that node', async () => {
      const { win } = await openWith(chain());
      dropChip(chip('Seed'), query('.pipeline-pin.is-out[data-block="b"]'));
      const stored = await written(win);
      const seed = stored.blocks.find((b) => b.scripts[0]?.scriptId === 'seed');
      expect(edgesOf(stored)).toContain(`b>${seed?.id}`);
    });

    it('refuses to drag a pre-script that is already placed', async () => {
      await openWith(chain());
      const event = new MouseEvent('dragstart', {
        bubbles: true,
        cancelable: true,
      });
      chip('Make setup').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('folds away and reopens from the breadcrumb, remembering it', async () => {
      await openWith(chain());
      const toggle = query('.wf-crumb-panel');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      click(button('Plegar panel'));
      expect(query('.pipeline-panel').hidden).toBe(true);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(localStorage.getItem('pipeline-panel-collapsed')).toBe('true');
      click(toggle);
      expect(query('.pipeline-panel').hidden).toBe(false);
      expect(localStorage.getItem('pipeline-panel-collapsed')).toBeNull();
    });

    it('starts collapsed when it was left collapsed', async () => {
      localStorage.setItem('pipeline-panel-collapsed', 'true');
      await openWith(chain());
      expect(query('.pipeline-panel').hidden).toBe(true);
    });

    it('resizes by its right edge between 180 and 360px, remembering it', async () => {
      await openWith(chain());
      const handle = query('.pipeline-panel-resize');
      expect(handle.getAttribute('aria-valuenow')).toBe('232');
      press(handle, 'ArrowRight');
      expect(localStorage.getItem('pipeline-panel-width')).toBe('248');
      pointer(handle, 'pointerdown', 100, 0);
      pointer(window, 'pointermove', 900, 0);
      pointer(window, 'pointerup', 900, 0);
      expect(handle.getAttribute('aria-valuenow')).toBe('360');
      expect(
        query('.pipeline-panel').style.getPropertyValue(
          '--pipeline-panel-width',
        ),
      ).toBe('360px');
      expect(localStorage.getItem('pipeline-panel-width')).toBe('360');
    });

    it('reads a stored width back, clamped', async () => {
      localStorage.setItem('pipeline-panel-width', '20');
      await openWith(chain());
      expect(
        query('.pipeline-panel-resize').getAttribute('aria-valuenow'),
      ).toBe('180');
    });
  });

  describe('the "+" picker', () => {
    it('opens with the search focused, placed scripts disabled', async () => {
      await openWith(chain());
      click(query('.pipeline-stub'));
      const picker = query('.pipeline-picker');
      expect(picker.getAttribute('aria-label')).toBe('Añadir pre-script');
      expect(document.activeElement).toBe(
        picker.querySelector('input[type="search"]'),
      );
      const setup = all('.pipeline-picker-option').find((o) =>
        o.textContent?.includes('Make setup'),
      ) as HTMLButtonElement;
      expect(setup.disabled).toBe(true);
      expect(setup.textContent).toContain('En el workflow');
    });

    it('adds the chosen script connected after that node with Enter', async () => {
      const { win } = await openWith(chain());
      click(query('.pipeline-stub'));
      press(query('.pipeline-picker input'), 'Enter');
      expect(document.querySelector('.pipeline-picker')).toBeNull();
      const stored = await written(win);
      const seed = stored.blocks.find((b) => b.scripts[0]?.scriptId === 'seed');
      expect(edgesOf(stored)).toContain(`b>${seed?.id}`);
      expect(seed?.x).toBe(600 + 280);
    });

    it('moves through the free options with the arrows and closes on Esc', async () => {
      await openWith(graph([], []), {
        createScript: () => undefined,
      });
      click(query('.pipeline-stub'));
      const input = query('.pipeline-picker input');
      const active = (): string =>
        textOf(query('.pipeline-picker-option.is-active'));
      expect(active()).toBe('Make setup');
      press(input, 'ArrowDown');
      expect(active()).toBe('Seed');
      press(input, 'ArrowUp');
      press(input, 'ArrowUp');
      expect(active()).toBe('Nuevo pre-script…');
      press(input, 'Escape');
      expect(document.querySelector('.pipeline-picker')).toBeNull();
    });

    it('filters as the user types', async () => {
      await openWith(graph([], []));
      click(query('.pipeline-stub'));
      const input = query<HTMLInputElement>('.pipeline-picker input');
      input.value = 'deps';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(all('.pipeline-picker-option').map((o) => textOf(o))).toEqual([
        'Install deps',
      ]);
    });

    it('disables every "+" once all the pre-scripts are placed', async () => {
      await openWith(
        graph([blk('p', [SETUP, DEPS, SEED], 300, 40)], ['trigger>p']),
      );
      const stub = query('.pipeline-stub');
      expect(stub.getAttribute('aria-disabled')).toBe('true');
      expect(tipOf(stub)).toBe('Todos los pre-scripts ya están en el workflow');
      click(stub);
      expect(document.querySelector('.pipeline-picker')).toBeNull();
    });

    it('creates a new pre-script after that node from its footer', async () => {
      const createScript = vi.fn();
      const { win } = await openWith(chain(), { createScript });
      click(query('.pipeline-stub'));
      click(button('Nuevo pre-script…', '.pipeline-picker'));
      expect(createScript).toHaveBeenCalledTimes(1);
      const request = createScript.mock.calls[0]?.[0] as Parameters<
        NonNullable<PipelineEditorDeps['createScript']>
      >[0];
      expect(request.after).toBe('Install deps');
      expect(request.groupId).toBe('front');
      await request.onCreated('back', {
        ...groups()[0].preScripts[1],
      });
      const stored = await written(win);
      const seed = stored.blocks.find((b) => b.scripts[0]?.scriptId === 'seed');
      expect(edgesOf(stored)).toContain(`b>${seed?.id}`);
    });
  });

  describe('"Nuevo pre-script" in the panel', () => {
    it('is offered only when the window can create one', async () => {
      await openWith(chain());
      expect(document.querySelector('.pipeline-panel-new')).toBeNull();
    });

    it('starts the chain from the trigger when the pipeline is empty', async () => {
      const createScript = vi.fn();
      const { win } = await openWith(graph([], []), { createScript });
      click(query('.pipeline-panel-new'));
      const request = createScript.mock.calls[0]?.[0] as Parameters<
        NonNullable<PipelineEditorDeps['createScript']>
      >[0];
      expect(request.after).toBeNull();
      expect(request.groups.map((g) => g.id)).toEqual(['back', 'front']);
      await request.onCreated('back', groups()[0].preScripts[1]);
      const stored = await written(win);
      expect(edgesOf(stored)).toEqual([`trigger>${stored.blocks[0]?.id}`]);
    });

    it('places it disconnected, in view, next to an existing graph', async () => {
      const createScript = vi.fn();
      const { win } = await openWith(chain(), { createScript });
      click(query('.pipeline-panel-new'));
      const request = createScript.mock.calls[0]?.[0] as Parameters<
        NonNullable<PipelineEditorDeps['createScript']>
      >[0];
      await request.onCreated('back', groups()[0].preScripts[1]);
      const stored = await written(win);
      expect(stored.blocks).toHaveLength(3);
      expect(stored.edges).toHaveLength(2);
    });
  });

  describe('zoom and pan', () => {
    it('starts at 100% and steps in and out with the buttons', async () => {
      await openWith(chain());
      expect(zoomText()).toBe('100%');
      click(button('Acercar'));
      expect(zoomText()).toBe('120%');
      click(button('Alejar'));
      click(button('Alejar'));
      expect(zoomText()).toBe('83%');
    });

    it('stops at 25%', async () => {
      await openWith(chain());
      for (let i = 0; i < 20; i++) click(button('Alejar'));
      expect(zoomText()).toBe('25%');
    });

    it('zooms around the cursor with Ctrl + wheel and pans with a plain wheel', async () => {
      await openWith(chain());
      canvas().dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
          clientX: 100,
          clientY: 100,
        }),
      );
      expect(zoomText()).not.toBe('100%');
      const zoomed = transform();
      canvas().dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: 30,
          deltaY: 40,
        }),
      );
      expect(transform()).not.toBe(zoomed);
      expect(transform()).toMatch(/scale\(2\)$/);
    });

    it('pans with Space held + drag, moving the grid along', async () => {
      await openWith(chain());
      canvas().dispatchEvent(new PointerEvent('pointerenter'));
      press(document.body, ' ', { code: 'Space' });
      expect(canvas().classList.contains('is-pan-ready')).toBe(true);
      dragPointer(node('Make setup'), [320, 60], [370, 90]);
      expect(transform()).toBe('translate(50px, 30px) scale(1)');
      expect(canvas().style.backgroundPosition).toBe('50px 30px');
      window.dispatchEvent(
        new KeyboardEvent('keyup', { key: ' ', code: 'Space' }),
      );
      expect(canvas().classList.contains('is-pan-ready')).toBe(false);
    });

    it('leaves Space alone while typing in a field', async () => {
      await openWith(chain());
      canvas().dispatchEvent(new PointerEvent('pointerenter'));
      const search = query('.pipeline-palette-search');
      const event = new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        bubbles: true,
        cancelable: true,
      });
      search.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(canvas().classList.contains('is-pan-ready')).toBe(false);
    });

    it('pans with a middle-button drag', async () => {
      await openWith(chain());
      dragPointer(canvas(), [10, 10], [30, 50], 1);
      expect(transform()).toBe('translate(20px, 40px) scale(1)');
    });

    it('fits every block into the view, beside the panel', async () => {
      await openWith(chain());
      Object.defineProperty(canvas(), 'clientWidth', { value: 500 });
      Object.defineProperty(canvas(), 'clientHeight', { value: 300 });
      click(button('Ajustar a la vista'));
      expect(Number.parseInt(zoomText(), 10)).toBeLessThan(100);
      // The panel covers the left 256px: the graph is centred in the rest.
      expect(transform()).toMatch(/^translate\((2[6-9]\d|3\d\d)/);
    });

    it('fits a large pipeline on the first open', async () => {
      const { win, editor } = await openEditor({ groups: groups() });
      Object.defineProperty(canvas(), 'clientWidth', { value: 600 });
      Object.defineProperty(canvas(), 'clientHeight', { value: 400 });
      void editor.refresh();
      await win.settle(
        'listWorkflows',
        startupEntries(
          graph(
            [blk('a', [SETUP], 300, 40), blk('b', [DEPS], 3000, 2000)],
            ['trigger>a', 'a>b'],
          ),
        ),
      );
      expect(Number.parseInt(zoomText(), 10)).toBeLessThan(50);
    });

    /** Gives the canvas a size; jsdom lays nothing out. */
    function sizeCanvas(width: number, height: number): void {
      Object.defineProperty(canvas(), 'clientWidth', {
        value: width,
        configurable: true,
      });
      Object.defineProperty(canvas(), 'clientHeight', {
        value: height,
        configurable: true,
      });
    }

    const big = () =>
      graph(
        [blk('a', [SETUP], 300, 40), blk('b', [DEPS], 3000, 2000)],
        ['trigger>a', 'a>b'],
      );

    it('fits again every time a workflow is opened, even the same one', async () => {
      const { win, editor } = await openEditor({ groups: groups() });
      sizeCanvas(600, 400);
      void editor.open('w-start');
      await win.settle('listWorkflows', startupEntries(big()));
      const fitted = zoomText();
      click(button('Acercar'));
      expect(zoomText()).not.toBe(fitted);

      void editor.open('w-start');
      await win.settle('listWorkflows', startupEntries(big()));

      expect(zoomText()).toBe(fitted);
    });

    it('refits when the window resizes, until the view is moved by hand', async () => {
      const observer = { resized: (): void => undefined };
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            observer.resized = callback;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      vi.stubGlobal('requestAnimationFrame', (frame: () => void) => {
        frame();
        return 0;
      });
      try {
        const { win, editor } = await openEditor({ groups: groups() });
        sizeCanvas(600, 400);
        void editor.open('w-start');
        await win.settle('listWorkflows', startupEntries(big()));
        const small = Number.parseInt(zoomText(), 10);

        sizeCanvas(1800, 1200);
        observer.resized();
        const large = Number.parseInt(zoomText(), 10);
        expect(large).toBeGreaterThan(small);

        click(button('Alejar'));
        const byHand = zoomText();
        sizeCanvas(600, 400);
        observer.resized();
        expect(zoomText(), 'a view moved by hand stays put').toBe(byHand);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('lays the graph out automatically and saves it', async () => {
      const { win } = await openWith(
        graph(
          [blk('a', [SETUP], 900, 900), blk('b', [DEPS], 10, 700)],
          ['trigger>a', 'a>b'],
        ),
      );
      click(button('Ordenar automáticamente'));
      const stored = await written(win);
      expect(stored.blocks.map((b) => [b.x, b.y])).toEqual([
        [320, 40],
        [600, 40],
      ]);
    });
  });

  describe('the minimap', () => {
    it('draws the trigger and each block, and hides on its toggle', async () => {
      await openWith(chain());
      const map = query('.pipeline-minimap');
      expect(map.querySelectorAll('.pipeline-minimap-item')).toHaveLength(3);
      const toggle = button('Mostrar minimapa');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      click(toggle);
      expect(map.hidden).toBe(true);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
    });

    it('centres the canvas on the spot clicked', async () => {
      await openWith(chain());
      const before = transform();
      pointer(query('.pipeline-minimap'), 'pointerdown', 150, 80);
      pointer(window, 'pointerup', 150, 80);
      expect(transform()).not.toBe(before);
    });
  });
});
