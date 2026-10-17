// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { iconText } from './helpers/icon-text.js';
import { tipOf } from './helpers/tip.js';
import { group, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

/**
 * «Ocultar de la barra»: the eye on each groups-list row and the
 * Visible/Oculto button in the group's header both fold a group into the
 * tray's «N oculto(s)» (`setGroupHiddenInTray`) — without selecting the row,
 * dirtying the draft or getting in the way of a drag.
 */

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `#groups-list .nav-card[data-id="${id}"]`,
  );
  if (!el) throw new Error(`no nav card for ${id}`);
  return el;
}

function eye(id: string): HTMLButtonElement {
  const el = card(id).querySelector<HTMLButtonElement>('.nav-eye');
  if (!el) throw new Error(`no eye on ${id}`);
  return el;
}

function headerToggle(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('.detail-visibility');
  if (!el) throw new Error('the header has no visibility button');
  return el;
}

function click(el: Element | null): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('renderer/config/groups-list.ts (visibility)', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  async function boot(): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [
      group('api'),
      group('web', { hiddenInTray: true }),
    ]);
    return win;
  }

  it('offers to hide a visible group, and marks a hidden one dimmed', async () => {
    await boot();
    expect(iconText(eye('group-api'))).toBe('[eye]');
    expect(eye('group-api').getAttribute('aria-label')).toBe(
      'Ocultar api de la barra',
    );
    expect(tipOf(eye('group-api'))).toBe('Ocultar de la barra');
    expect(card('group-api').classList.contains('is-hidden-in-tray')).toBe(
      false,
    );
    expect(iconText(eye('group-web'))).toBe('[eye-off]');
    expect(eye('group-web').getAttribute('aria-label')).toBe(
      'Mostrar web en la barra',
    );
    expect(card('group-web').classList.contains('is-hidden-in-tray')).toBe(
      true,
    );
  });

  it('hides from the row without selecting it', async () => {
    const w = await boot();
    expect(card('group-api').classList.contains('selected')).toBe(true);
    click(eye('group-web'));
    expect(w.argsFor('setGroupHiddenInTray')).toEqual([['group-web', false]]);
    expect(card('group-api').classList.contains('selected')).toBe(true);
    await w.settle(
      'setGroupHiddenInTray',
      group('web', { hiddenInTray: false }),
    );
    expect(card('group-web').classList.contains('is-hidden-in-tray')).toBe(
      false,
    );
  });

  it('keeps the eye out of a drag', async () => {
    await boot();
    expect(eye('group-api').draggable).toBe(false);
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    eye('group-api').dispatchEvent(down);
    expect(card('group-api').classList.contains('dragging')).toBe(false);
  });

  it('toggles from the group header, leaving the draft clean', async () => {
    const w = await boot();
    const toggle = headerToggle();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent?.replace(/[-]/g, '').trim()).toBe('Visible');
    click(toggle);
    expect(w.argsFor('setGroupHiddenInTray')).toEqual([['group-api', true]]);
    await w.settle(
      'setGroupHiddenInTray',
      group('api', { hiddenInTray: true }),
    );
    const after = headerToggle();
    expect(after.getAttribute('aria-pressed')).toBe('false');
    expect(after.textContent?.replace(/[-]/g, '').trim()).toBe('Oculto');
    expect(card('group-api').classList.contains('is-hidden-in-tray')).toBe(
      true,
    );
    expect(
      document.querySelector<HTMLButtonElement>('#detail-save')?.disabled,
    ).toBe(true);
  });

  it('says so when the change could not be saved', async () => {
    const w = await boot();
    click(eye('group-api'));
    await w.fail('setGroupHiddenInTray', new Error('disco lleno'));
    expect(document.getElementById('toast')?.textContent).toBe(
      'No se pudo guardar el ajuste',
    );
    expect(card('group-api').classList.contains('is-hidden-in-tray')).toBe(
      false,
    );
  });
});

describe('renderer/config/group-detail.ts (startup wait)', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  it('names the wait after the startup workflow, the reason in its tooltip', async () => {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api')]);
    const label = document
      .querySelector('.detail-wait-pipeline')
      ?.closest('label');
    expect(label?.textContent).toBe('Esperar al workflow de arranque');
    expect(tipOf(label)).toContain('workflow de arranque');
    expect(document.getElementById('group-detail')?.textContent).not.toMatch(
      /pipeline/i,
    );
  });
});
