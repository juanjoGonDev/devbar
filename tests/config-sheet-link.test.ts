// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  command,
  group,
  openConfigWindow,
  recordApiCalls,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { DetectedPort, Group } from '../src/domain-types.js';
import { tipOf } from './helpers/tip.js';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}

function input(id: string): HTMLInputElement {
  return el<HTMLInputElement>(id);
}

function click(target: Element | null | undefined): void {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function type(id: string, value: string): void {
  input(id).value = value;
  input(id).dispatchEvent(new Event('input', { bubbles: true }));
}

function blur(id: string): void {
  input(id).dispatchEvent(new Event('change', { bubbles: true }));
}

function pickMode(mode: 'auto' | 'custom' | 'none'): void {
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="sf-link-mode"][value="${mode}"]`,
  );
  if (!radio) throw new Error(`no ${mode} radio`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

function section(): HTMLElement {
  return el('sf-sec-link');
}

function badge(): string {
  return section().querySelector('.sheet-badge')?.textContent ?? '';
}

function submit(): void {
  el('sub-form').dispatchEvent(new Event('submit', { cancelable: true }));
}

function addButton(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#group-detail .sub-list-header .sub-add-btn',
    ),
  ].find((b) => b.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no add button "${label}"`);
  return found;
}

function editFirst(kind: 'command' | 'action'): void {
  const row = document.querySelector<HTMLElement>(
    `.sub-item-list[data-kind="${kind}"] .sub-item-row`,
  );
  click(
    [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => tipOf(b) === 'Editar',
    ),
  );
}

function savedLink(calls: unknown[][]): unknown {
  const last = calls.at(-1);
  if (!last) throw new Error('nothing was saved');
  return (last[1] as Record<string, unknown>).link;
}

function webPort(
  port: number,
  extra: Partial<DetectedPort> = {},
): DetectedPort {
  return {
    port,
    url: `http://localhost:${port}/`,
    kind: 'web',
    source: 'socket',
    lanReachable: false,
    ...extra,
  };
}

describe('renderer/config/sheet-link.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function open(extra: Partial<Group> = {}): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api', extra)]);
    return win;
  }

  async function running(w: RendererWindow, ports: DetectedPort[]) {
    await w.settle('getGroupStates', [
      {
        groupId: 'group-api',
        currentBranch: null,
        commands: [{ commandId: 'cmd-web', status: 'running', ports }],
        actions: [],
      },
    ]);
  }

  describe('which items have it', () => {
    it('shows the section for a command only', async () => {
      await open({});
      click(addButton('Añadir comando'));
      expect(section().hidden).toBe(false);
      click(addButton('Añadir acción'));
      expect(section().hidden).toBe(true);
      click(addButton('Añadir pre-script'));
      expect(section().hidden).toBe(true);
    });
  });

  describe('automatic mode', () => {
    it('is the default and waits for the command to start', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      expect(badge()).toBe('automático');
      expect(el('sf-link-auto').hidden).toBe(false);
      expect(el('sf-link-custom').hidden).toBe(true);
      expect(el('sf-link-detected').textContent).toBe(
        'Se detectará al arrancar el comando',
      );
      expect(el('sf-link-prefix').hidden).toBe(true);
    });

    it('names the primary web port the running command listens on', async () => {
      const w = await open({ commands: [command('web')] });
      await running(w, [
        webPort(5432, { kind: 'other' }),
        webPort(3000),
        webPort(3001),
      ]);
      editFirst('command');
      expect(el('sf-link-detected').textContent).toBe(
        'Detectado en la última ejecución: http://localhost:3000',
      );
      expect(el('sf-link-prefix').hidden).toBe(false);
      expect(el('sf-link-prefix').textContent).toBe('localhost:3000');
    });

    it('falls back to an HTTP API when there is no web page', async () => {
      const w = await open({ commands: [command('web')] });
      await running(w, [webPort(8080, { kind: 'http' })]);
      editFirst('command');
      expect(el('sf-link-detected').textContent).toBe(
        'Detectado en la última ejecución: http://localhost:8080',
      );
    });

    it('saves the path to open, starting with a slash', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      type('sf-link-path', 'api/docs ');
      blur('sf-link-path');
      expect(input('sf-link-path').value).toBe('/api/docs');
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(savedLink(saves)).toEqual({ mode: 'auto', path: '/api/docs' });
    });

    it('saves a bare automatic link when the path is empty', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(savedLink(saves)).toEqual({ mode: 'auto' });
    });

    it('fills the stored path back in', async () => {
      await open({
        commands: [command('web', { link: { mode: 'auto', path: '/admin' } })],
      });
      editFirst('command');
      expect(input('sf-link-path').value).toBe('/admin');
    });
  });

  describe('custom mode', () => {
    it('fills a stored custom URL and summarises it', async () => {
      await open({
        commands: [
          command('web', {
            link: { mode: 'custom', url: 'http://localhost:9000/x' },
          }),
        ],
      });
      editFirst('command');
      expect(badge()).toBe('personalizado');
      expect(el('sf-link-custom').hidden).toBe(false);
      expect(el('sf-link-auto').hidden).toBe(true);
      expect(input('sf-link-url').value).toBe('http://localhost:9000/x');
    });

    it('rejects a URL off this machine and blocks saving', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      pickMode('custom');
      type('sf-link-url', 'https://example.com');
      expect(el('sf-link-url-error').hidden).toBe(false);
      expect(input('sf-link-url').getAttribute('aria-invalid')).toBe('true');
      expect(el<HTMLButtonElement>('sf-submit').disabled).toBe(true);
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(saves).toHaveLength(0);
      expect(el<HTMLDialogElement>('sub-dialog').open).toBe(true);
    });

    it('blocks saving while the URL is empty', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      pickMode('custom');
      expect(el<HTMLButtonElement>('sf-submit').disabled).toBe(true);
    });

    it('saves a local URL', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      pickMode('custom');
      type('sf-link-url', ' http://192.168.1.20:8080/app ');
      expect(el('sf-link-url-error').hidden).toBe(true);
      expect(el<HTMLButtonElement>('sf-submit').disabled).toBe(false);
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(savedLink(saves)).toEqual({
        mode: 'custom',
        url: 'http://192.168.1.20:8080/app',
      });
    });

    it('lets saving again once another mode is picked', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      pickMode('custom');
      pickMode('auto');
      expect(el<HTMLButtonElement>('sf-submit').disabled).toBe(false);
    });
  });

  describe('no link', () => {
    it('saves a command without a link', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      pickMode('none');
      expect(badge()).toBe('ninguno');
      expect(el('sf-link-auto').hidden).toBe(true);
      expect(el('sf-link-custom').hidden).toBe(true);
      expect(el('sf-link-none').hidden).toBe(false);
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(savedLink(saves)).toEqual({ mode: 'none' });
    });

    it('does not block an action from saving', async () => {
      await open({ commands: [command('web')] });
      editFirst('command');
      pickMode('custom');
      click(addButton('Añadir acción'));
      expect(el<HTMLButtonElement>('sf-submit').disabled).toBe(false);
    });
  });
});
