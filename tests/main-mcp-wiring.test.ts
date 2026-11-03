import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const app = { isPackaged: false, getPath: () => os.tmpdir() };
  return { app, default: { app } };
});

import type { GlobalSettings } from '../src/domain-types.js';
import { createMcp, withMcpShutdown } from '../src/main/mcp/mcp-wiring.js';
import { makeSettings } from './helpers/main-fakes.js';

const created: string[] = [];

function harness() {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-mcp-'));
  created.push(appHome);
  let settings = makeSettings();
  let clients: unknown = undefined;
  const sent: { channel: string; payload: unknown }[] = [];
  const pushedSettings: GlobalSettings[] = [];
  let confirmationsShown = 0;
  const parts = createMcp(
    {
      appHome,
      mainDir: '/app/build/src',
      execPath: '/app/DevBar',
      platform: 'darwin',
      configStore: {
        getGlobalSettings: () => settings,
        saveGlobalSettings: (patch) => {
          settings = { ...settings, ...patch };
          return settings;
        },
        getMcpClients: () => clients,
        saveMcpClients: (value) => {
          clients = value;
        },
      },
      send: (channel, payload) => sent.push({ channel, payload }),
      sendSettings: (next) => pushedSettings.push(next),
      showConfirmations: () => {
        confirmationsShown += 1;
      },
    },
    () => ({
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      listening: () => false,
    }),
  );
  return {
    parts,
    appHome,
    sent,
    pushedSettings,
    clients: () => clients,
    confirmationsShown: () => confirmationsShown,
  };
}

describe('src/main/mcp/mcp-wiring.ts', () => {
  afterEach(() => {
    for (const dir of created.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps its files in an mcp folder only this user can open', () => {
    const h = harness();
    h.parts.audit.record({
      clientId: 'c1',
      clientName: 'Claude Code',
      tool: 'get_status',
      target: 'Back',
      result: 'ok',
      summary: '',
    });

    const dir = path.join(h.appHome, 'mcp');
    expect(h.parts.home).toBe(dir);
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'audit.jsonl')).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(h.sent.map((s) => s.channel)).toEqual(['mcp:audit']);
  });

  it('saves the switch in the global settings and pushes them', async () => {
    const h = harness();

    await h.parts.control.setEnabled(true);

    expect(h.pushedSettings.at(-1)?.mcp).toEqual({
      enabled: true,
      transport: 'stdio',
    });
    expect(h.sent.at(-1)?.channel).toBe('mcp:update');
  });

  it('stores the clients through the config store', () => {
    const h = harness();

    h.parts.clients.identify({ name: 'claude-code' });

    expect(h.clients()).toEqual([
      expect.objectContaining({ key: 'claude-code', status: 'pending' }),
    ]);
  });

  it('shows a confirmation in the windows and brings Settings up', () => {
    const h = harness();

    const asked = h.parts.desk.ask({
      clientName: 'Claude Code',
      title: 't',
      subtitle: 's',
      risk: 'executes',
      diff: [],
    });
    h.parts.desk.answer(asked.id, 'reject');

    expect(h.sent.map((s) => s.channel)).toEqual([
      'mcp:confirmRequest',
      'mcp:confirmClosed',
    ]);
    expect(h.confirmationsShown()).toBe(1);
  });

  it('points the connect lines at the bridge next to the main process', () => {
    const h = harness();

    expect(h.parts.control.state().connectCommand.claudeDesktopJson).toContain(
      '/app/build/src/mcp/cli.js',
    );
  });

  it('closes the MCP endpoint alongside «Control remoto»', () => {
    const calls: string[] = [];

    withMcpShutdown(
      { close: () => calls.push('remote') },
      {
        shutdown: () => {
          calls.push('mcp');
          return Promise.resolve();
        },
      },
    ).close();

    expect(calls).toEqual(['remote', 'mcp']);
  });
});
