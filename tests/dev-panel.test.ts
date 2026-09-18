// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { mountDevPanel } from '../renderer/dev/dev-panel.js';

/**
 * `renderer/dev/dev-panel.ts` builds the whole simulation panel in code so
 * `config.html` carries no dev markup. Every button is a label wired to one
 * `api.dev.*` call, so the panel is tested the way it is used: mount it, click
 * a button by its label, and check which simulation it actually triggered.
 */

interface DevCall {
  method: string;
  args: unknown[];
}

let calls: DevCall[];
let pending: { resolve: () => void; reject: (error: unknown) => void }[];
/** When set, every dev call parks until the test releases it. */
let deferCalls: boolean;

const DEV_METHODS = [
  'simulateUpdate',
  'simulateRealUpdate',
  'clearUpdate',
  'simulateTrayColor',
  'simulateTrayCount',
  'simulateBanner',
  'simulateFallbackBanner',
  'simulateSuccess',
  'simulatePrescriptConfirm',
  'simulateToast',
] as const;

function installApi(): void {
  const dev: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of DEV_METHODS) {
    dev[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      if (!deferCalls) return Promise.resolve({ ok: true });
      return new Promise<unknown>((resolve, reject) => {
        pending.push({ resolve: () => resolve({ ok: true }), reject });
      });
    };
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { dev },
  });
}

function mount(): { nav: HTMLElement; section: HTMLElement } {
  const nav = document.createElement('nav');
  const content = document.createElement('div');
  document.body.append(nav, content);
  const mounted = mountDevPanel(nav, content);
  return { nav, section: mounted.section };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`the panel drew no button labelled "${label}"`);
  return found;
}

/** Lets the click handler's promise chain settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('renderer/dev/dev-panel.ts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    calls = [];
    pending = [];
    deferCalls = false;
    installApi();
  });

  describe('mountDevPanel', () => {
    it('adds a nav entry config.ts can register as the dev target', () => {
      const { nav } = mount();

      const navButton = nav.querySelector('button');
      expect(navButton?.dataset.target).toBe('dev');
      expect(navButton?.className).toBe('nav-item');
      expect(navButton?.getAttribute('aria-label')).toBe('Dev');
      expect(navButton?.querySelector('.nav-label')?.textContent).toBe('Dev');
      expect(
        navButton?.querySelector('.nav-ico')?.getAttribute('aria-hidden'),
      ).toBe('true');
    });

    it('adds a section config.ts can show for that target', () => {
      const { section } = mount();

      expect(section.dataset.section).toBe('dev');
      expect(section.className).toBe('config-section');
      expect(section.querySelector('.section-title')?.textContent).toBe('Dev');
    });

    it('draws one card per simulation group, in order', () => {
      const { section } = mount();

      const headings = [...section.querySelectorAll('.settings-card h2')].map(
        (heading) => heading.textContent,
      );
      expect(headings).toEqual([
        'Actualización disponible',
        'Actualización real (end to end)',
        'Notificaciones',
        'Icono de la barra',
        'Diálogos y avisos',
      ]);
    });

    it('puts the version field in the update card and nowhere else', () => {
      const { section } = mount();

      const inputs = [...section.querySelectorAll('input.dev-version')];
      expect(inputs).toHaveLength(1);
      const card = inputs[0]?.closest('.settings-card');
      expect(card?.querySelector('h2')?.textContent).toBe(
        'Actualización disponible',
      );
      expect(inputs[0]?.getAttribute('aria-label')).toBe('Versión a simular');
    });
  });

  describe('the buttons', () => {
    it.each([
      ['Limpiar', 'clearUpdate', []],
      ['Simular actualización real', 'simulateRealUpdate', []],
      ['Aviso simple', 'simulateBanner', [false]],
      ['Aviso con acción', 'simulateBanner', [true]],
      ['Reserva (banner propio)', 'simulateFallbackBanner', [false]],
      ['Reserva con acción', 'simulateFallbackBanner', [true]],
      ['Notificación de éxito', 'simulateSuccess', []],
      ['Parado', 'simulateTrayColor', ['stopped']],
      ['Corriendo', 'simulateTrayColor', ['running']],
      ['Warning', 'simulateTrayColor', ['warn']],
      ['Error', 'simulateTrayColor', ['error']],
      ['Errores: 5', 'simulateTrayCount', [5]],
      ['Errores: 14', 'simulateTrayCount', [14]],
      ['Errores: 99+', 'simulateTrayCount', [1234]],
      ['Confirmación de pre-script', 'simulatePrescriptConfirm', []],
      ['Toast correcto', 'simulateToast', ['ok']],
      ['Toast de error', 'simulateToast', ['error']],
    ])('«%s» triggers its own simulation', async (label, method, args) => {
      const { section } = mount();

      button(section, label).click();
      await settle();

      expect(calls).toEqual([{ method, args }]);
    });

    it('releases both tray overrides at once, so a forced count cannot outlive the color', async () => {
      const { section } = mount();

      button(section, 'Soltar').click();
      await settle();

      expect(calls).toEqual([
        { method: 'simulateTrayColor', args: [null] },
        { method: 'simulateTrayCount', args: [null] },
      ]);
    });

    it('sends the typed version, trimmed', async () => {
      const { section } = mount();
      const input =
        section.querySelector<HTMLInputElement>('input.dev-version');
      if (!input) throw new Error('the panel drew no version field');
      input.value = '  2.3.4  ';

      button(section, 'Simular actualización').click();
      await settle();

      expect(calls).toEqual([{ method: 'simulateUpdate', args: ['2.3.4'] }]);
    });

    it.each([
      ['left empty', ''],
      ['only whitespace', '   '],
    ])(
      'lets main pick the version when the field is %s',
      async (_label, value) => {
        const { section } = mount();
        const input =
          section.querySelector<HTMLInputElement>('input.dev-version');
        if (!input) throw new Error('the panel drew no version field');
        input.value = value;

        button(section, 'Simular actualización').click();
        await settle();

        expect(calls).toEqual([
          { method: 'simulateUpdate', args: [undefined] },
        ]);
      },
    );

    it('marks only the destructive button as dangerous', () => {
      const { section } = mount();

      const dangerous = [...section.querySelectorAll('button.danger')].map(
        (candidate) => candidate.textContent,
      );
      expect(dangerous).toEqual(['Toast de error']);
    });

    it('turns a hint into the title installTooltips() styles', () => {
      const { section } = mount();

      expect(button(section, 'Errores: 99+').title).toBe(
        'Cualquier cifra ≥ 100 se pinta como 99+',
      );
      expect(button(section, 'Limpiar').title).toBe('');
    });
  });

  describe('while a simulation is running', () => {
    it('disables the button until the call comes back', async () => {
      deferCalls = true;
      const { section } = mount();
      const target = button(section, 'Simular actualización real');

      target.click();
      await settle();
      expect(target.disabled).toBe(true);

      pending[0]?.resolve();
      await settle();
      expect(target.disabled).toBe(false);
    });

    it('re-enables the button when the handler is missing, instead of leaving it dead', async () => {
      deferCalls = true;
      const { section } = mount();
      const target = button(section, 'Notificación de éxito');

      target.click();
      await settle();
      expect(target.disabled).toBe(true);

      // What a packaged build does: no `dev:` handler, so invoke rejects.
      pending[0]?.reject(new Error('No handler registered for dev:...'));
      await settle();
      expect(target.disabled).toBe(false);
    });
  });
});
