// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  action,
  command,
  group,
  openConfigWindow,
  preScript,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { Group } from '../src/domain-types.js';

/**
 * The group editor's tabs: «Procesos», «Pre-scripts», «Entorno» and
 * «Ajustes», each with its own panel, keyboard-driven like a native tablist
 * and remembered for as long as the window is open.
 */

function tabs(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#group-detail [role="tablist"] [role="tab"]',
    ),
  ];
}

function tab(label: string): HTMLButtonElement {
  const found = tabs().find((t) => t.textContent?.startsWith(label));
  if (!found) throw new Error(`no tab "${label}"`);
  return found;
}

function panelOf(t: HTMLButtonElement): HTMLElement {
  const id = t.getAttribute('aria-controls');
  const el = id ? document.getElementById(id) : null;
  if (!el) throw new Error(`tab ${t.textContent} controls no panel`);
  return el;
}

function visiblePanels(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '#group-detail [role="tabpanel"]',
    ),
  ].filter((p) => !p.hidden);
}

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function key(el: Element, name: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
}

describe('renderer/config/group-tabs.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  async function open(...groups: Group[]): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', groups.length ? groups : [group('api')]);
    return win;
  }

  it('names each tab with how many items it holds', async () => {
    await open(
      group('api', {
        commands: [command('web'), command('worker')],
        actions: [action('seed')],
        preScripts: [preScript('up')],
        env: [{ key: 'A', value: '1', enabled: true }],
      }),
    );
    expect(tabs().map((t) => t.textContent)).toEqual([
      'Procesos3',
      'Pre-scripts1',
      'Entorno1',
      'Ajustes',
    ]);
  });

  it('opens on «Procesos», showing only its panel', async () => {
    await open();
    expect(tab('Procesos').getAttribute('aria-selected')).toBe('true');
    expect(visiblePanels()).toEqual([panelOf(tab('Procesos'))]);
    expect(panelOf(tab('Procesos')).querySelector('.sub-item-list')).not.toBe(
      null,
    );
  });

  it('puts every section in its tab', async () => {
    await open();
    expect(
      panelOf(tab('Pre-scripts')).querySelector('.presteps-section'),
    ).not.toBeNull();
    expect(panelOf(tab('Entorno')).querySelector('.env-editor')).not.toBeNull();
    expect(
      panelOf(tab('Ajustes')).querySelector('.detail-wait-pipeline'),
    ).not.toBeNull();
  });

  it('switches panel on click', async () => {
    await open();
    click(tab('Entorno'));
    expect(tab('Entorno').getAttribute('aria-selected')).toBe('true');
    expect(tab('Procesos').getAttribute('aria-selected')).toBe('false');
    expect(visiblePanels()).toEqual([panelOf(tab('Entorno'))]);
  });

  it('moves with the arrow keys, Home and End, keeping one tab stop', async () => {
    await open();
    key(tab('Procesos'), 'ArrowRight');
    expect(document.activeElement).toBe(tab('Pre-scripts'));
    expect(tab('Pre-scripts').getAttribute('aria-selected')).toBe('true');
    key(tab('Pre-scripts'), 'End');
    expect(document.activeElement).toBe(tab('Ajustes'));
    key(tab('Ajustes'), 'ArrowRight');
    expect(document.activeElement).toBe(tab('Procesos'));
    key(tab('Procesos'), 'ArrowLeft');
    expect(document.activeElement).toBe(tab('Ajustes'));
    key(tab('Ajustes'), 'Home');
    expect(document.activeElement).toBe(tab('Procesos'));
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('remembers the tab across groups for as long as the window is open', async () => {
    await open(group('api'), group('web'));
    click(tab('Ajustes'));
    click(
      document.querySelector('#groups-list .nav-card[data-id="group-web"]'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      document.querySelector<HTMLInputElement>('.detail-name-input')?.value,
    ).toBe('web');
    expect(tab('Ajustes').getAttribute('aria-selected')).toBe('true');
  });

  it('counts a variable as soon as it is added', async () => {
    await open();
    click(document.querySelector('#group-detail .env-add-btn'));
    expect(tab('Entorno').textContent).toBe('Entorno1');
  });
});
