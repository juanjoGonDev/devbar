// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush, openConfigWindow } from './helpers/config-window.js';
import { iconText } from './helpers/icon-text.js';
import {
  click,
  el,
  mcpClient,
  mcpState,
  openMcp,
  pick,
  visible,
} from './helpers/mcp.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

/**
 * The «MCP» section of the config window, driven through the real window
 * (config.html + config.ts) with a hand-driven `window.api`: the server card
 * and the ready-to-paste connect commands. The client list and its sheet are
 * tests/config-mcp-clients.test.ts; the audit log is
 * tests/config-mcp-activity.test.ts.
 */

const ACTIVE = {
  settings: {
    enabled: true,
    transport: 'stdio' as const,
    auditRetentionDays: 30,
  },
};

function navItem(): HTMLElement {
  const item = document.querySelector<HTMLElement>(
    '.nav-item[data-target="mcp"]',
  );
  if (!item) throw new Error('no MCP nav item');
  return item;
}
const status = (): HTMLElement => el('mcp-status');
const kind = (value: string): HTMLInputElement =>
  el<HTMLElement>('mcp-connect-kinds').querySelector<HTMLInputElement>(
    `input[value="${value}"]`,
  ) as HTMLInputElement;

describe('renderer/config/mcp-pane.ts', () => {
  let win: RendererWindow | null = null;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('the nav item', () => {
    it('sits right after «Control remoto», with the plug icon', async () => {
      win = await openMcp(mcpState());
      const prev = navItem().previousElementSibling as HTMLElement | null;
      expect(prev?.dataset.target).toBe('remote');
      expect(iconText(navItem().querySelector('.nav-ico'))).toBe('[plug]');
      expect(visible(navItem())).toBe('MCP');
    });

    it('opens the section when main asks for the «mcp» target', async () => {
      win = await openMcp(mcpState());
      await win.push('onConfigGoto', 'mcp');
      const section = document.querySelector('[data-section="mcp"]');
      expect(section?.classList.contains('active')).toBe(true);
      expect(navItem().classList.contains('active')).toBe(true);
    });
  });

  describe('the server card', () => {
    it('says «Detenido» while the switch is off', async () => {
      win = await openMcp(mcpState());
      expect(visible(status())).toBe('Detenido');
      expect(el<HTMLInputElement>('mcp-enabled').checked).toBe(false);
      expect(el<HTMLInputElement>('mcp-enabled').disabled).toBe(false);
      expect(el('mcp-error').hidden).toBe(true);
    });

    it('counts the allowed clients while it listens', async () => {
      win = await openMcp(
        mcpState({
          ...ACTIVE,
          listening: true,
          clients: [
            mcpClient('Claude Code'),
            mcpClient('Cursor', { status: 'pending' }),
            mcpClient('Claude Desktop'),
          ],
        }),
      );
      expect(visible(status())).toBe('Activo · 2 clientes');
      expect(status().classList.contains('is-on')).toBe(true);
      expect(el<HTMLInputElement>('mcp-enabled').checked).toBe(true);
    });

    it('says «1 cliente» for a single one', async () => {
      win = await openMcp(
        mcpState({
          ...ACTIVE,
          listening: true,
          clients: [mcpClient('Claude Code')],
        }),
      );
      expect(visible(status())).toBe('Activo · 1 cliente');
    });

    it('shows why the server could not start, in red', async () => {
      win = await openMcp(
        mcpState({ ...ACTIVE, error: 'No se pudo abrir el socket.' }),
      );
      expect(status().classList.contains('is-error')).toBe(true);
      expect(visible(status())).toBe('Error');
      expect(el('mcp-error').hidden).toBe(false);
      expect(el('mcp-error').textContent).toBe('No se pudo abrir el socket.');
    });

    it('asks main to turn the server on and paints its answer', async () => {
      win = await openMcp(mcpState());
      const toggle = el<HTMLInputElement>('mcp-enabled');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      expect(win.argsFor('setMcpEnabled')).toEqual([[true]]);
      expect(toggle.disabled).toBe(true);
      await win.settle(
        'setMcpEnabled',
        mcpState({ ...ACTIVE, listening: true }),
      );
      expect(toggle.disabled).toBe(false);
      expect(visible(status())).toBe('Activo · 0 clientes');
    });

    it('puts the switch back and says so when main fails', async () => {
      win = await openMcp(mcpState());
      const toggle = el<HTMLInputElement>('mcp-enabled');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await win.fail('setMcpEnabled', new Error('boom'));
      expect(toggle.checked).toBe(false);
      expect(el('toast').textContent).toBe('Error: boom');
    });

    it('repaints from every state main pushes', async () => {
      win = await openMcp(mcpState());
      await win.push('onMcpUpdate', mcpState({ ...ACTIVE, listening: true }));
      expect(visible(status())).toBe('Activo · 0 clientes');
    });

    it('offers no transport choice: assistants connect locally only', async () => {
      win = await openMcp(mcpState());
      expect(document.querySelector('[name="mcp-transport"]')).toBeNull();
    });

    it('says so when the first read fails', async () => {
      win = await openConfigWindow();
      await win.fail('getMcpState', new Error('down'));
      expect(el('toast').textContent).toBe('Error al leer el MCP: down');
    });
  });

  describe('connecting a client', () => {
    it('shows the Claude Code command first', async () => {
      win = await openMcp(mcpState());
      expect(el('mcp-connect-code').textContent).toBe(
        'claude mcp add devbar -- devbar mcp',
      );
      expect(visible(el('mcp-connect-hint'))).toContain('terminal');
    });

    it('pretty-prints the JSON blocks of Claude Desktop and Cursor', async () => {
      win = await openMcp(mcpState());
      pick(kind('claude-desktop'));
      expect(el('mcp-connect-code').textContent).toBe(
        JSON.stringify(
          { mcpServers: { devbar: { command: 'devbar' } } },
          null,
          2,
        ),
      );
      expect(visible(el('mcp-connect-hint'))).toContain(
        'claude_desktop_config.json',
      );
      pick(kind('cursor'));
      expect(el('mcp-connect-code').textContent).toContain('cursor-devbar');
      expect(visible(el('mcp-connect-hint'))).toContain('mcp.json');
    });

    it('offers the OpenCode JSON block and the Codex TOML table', async () => {
      win = await openMcp(mcpState());
      pick(kind('opencode'));
      expect(el('mcp-connect-code').textContent).toBe(
        JSON.stringify({ mcp: { devbar: { type: 'local' } } }, null, 2),
      );
      expect(visible(el('mcp-connect-hint'))).toContain('opencode.json');
      pick(kind('codex'));
      expect(el('mcp-connect-code').textContent).toBe('[mcp_servers.devbar]');
      expect(visible(el('mcp-connect-hint'))).toContain('config.toml');
      expect(visible(el('mcp-connect-hint'))).toContain('app de ChatGPT');
    });

    it('shows the bare command line for any other client', async () => {
      win = await openMcp(mcpState());
      pick(kind('other'));
      expect(el('mcp-connect-code').textContent).toBe(
        'ELECTRON_RUN_AS_NODE=1 devbar mcp',
      );
    });

    it('keeps a block that is not JSON as main wrote it', async () => {
      win = await openMcp(
        mcpState({
          connectCommand: {
            ...mcpState().connectCommand,
            cursorJson: 'not json',
          },
        }),
      );
      pick(kind('cursor'));
      expect(el('mcp-connect-code').textContent).toBe('not json');
    });

    it('copies what it shows and confirms it', async () => {
      win = await openMcp(mcpState());
      pick(kind('other'));
      click(el('mcp-copy'));
      await flush();
      expect(writeText).toHaveBeenCalledWith(
        'ELECTRON_RUN_AS_NODE=1 devbar mcp',
      );
      expect(el('toast').textContent).toBe('Copiado');
    });

    it('says so when the clipboard refuses', async () => {
      writeText.mockRejectedValue(new Error('denied'));
      win = await openMcp(mcpState());
      click(el('mcp-copy'));
      await flush();
      expect(el('toast').textContent).toBe('No se pudo copiar: denied');
    });
  });
});
