// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { group, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { Group } from '../src/domain-types.js';

/**
 * The «Ajustes» tab: GENERAL, COMPORTAMIENTO and ZONA DE PELIGRO cards, each
 * row a label (and hint) with its control at the trailing edge.
 */

function panel(): HTMLElement {
  const el = document.getElementById('group-panel-settings');
  if (!el) throw new Error('no «Ajustes» panel');
  return el;
}

function input(selector: string): HTMLInputElement {
  const el = panel().querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`no ${selector} in «Ajustes»`);
  return el;
}

function headerName(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    '#group-detail .detail-header .detail-name-input',
  );
  if (!el) throw new Error('no header name');
  return el;
}

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function check(el: HTMLInputElement, value: boolean): void {
  el.checked = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function saveDisabled(): boolean {
  return (document.getElementById('detail-save') as HTMLButtonElement).disabled;
}

describe('renderer/config/group-settings-tab.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  async function open(extra: Partial<Group> = {}): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api', extra)]);
    return win;
  }

  it('groups the settings in three titled cards', async () => {
    await open();
    expect(
      [...panel().querySelectorAll('.settings-group-title')].map(
        (t) => t.textContent,
      ),
    ).toEqual(['General', 'Comportamiento', 'Zona de peligro']);
  });

  it('keeps the name here and in the header in step', async () => {
    await open();
    type(input('#grp-name'), 'api-2');
    expect(headerName().value).toBe('api-2');
    expect(saveDisabled()).toBe(false);
    type(headerName(), 'api-3');
    expect(input('#grp-name').value).toBe('api-3');
  });

  it('shows the folder in the header as it is typed', async () => {
    await open();
    type(input('#grp-path'), '/srv/api');
    expect(
      document.querySelector('.detail-header .detail-path-text')?.textContent,
    ).toBe('/srv/api');
  });

  it('offers the mode as «Varios | Uno» over multi and single', async () => {
    await open({ mode: 'single' });
    const options = [...panel().querySelectorAll('.mode-segment')];
    expect(options.map((o) => o.textContent)).toEqual(['Varios', 'Uno']);
    expect(input('.mode-segmented input[value="single"]').checked).toBe(true);
    check(input('.mode-segmented input[value="multi"]'), true);
    expect(saveDisabled()).toBe(false);
  });

  it('names both silencing switches in Spanish', async () => {
    await open();
    expect(input('.detail-silence-warn').closest('label')?.textContent).toBe(
      'Warnings',
    );
    expect(input('.detail-silence-err').closest('label')?.textContent).toBe(
      'Errores',
    );
  });

  it('flips «Visible en la barra y el móvil» as an instant write', async () => {
    const w = await open();
    const visible = input('.detail-visible');
    expect(visible.checked).toBe(true);
    check(visible, false);
    expect(w.argsFor('setGroupHiddenInTray')).toEqual([['group-api', true]]);
    expect(saveDisabled()).toBe(true);
  });

  it('shows a hidden group as not visible', async () => {
    await open({ hiddenInTray: true });
    expect(input('.detail-visible').checked).toBe(false);
  });

  it('moves the delete button into the danger zone only', async () => {
    await open();
    expect(document.querySelector('.detail-btn-row')).toBeNull();
    expect(
      panel().querySelector('.detail-danger-zone .danger')?.textContent,
    ).toBe('Borrar grupo…');
  });
});
