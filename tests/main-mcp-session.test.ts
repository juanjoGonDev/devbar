import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RESOURCE_UPDATE_MS } from '../src/main/mcp/session-resources.js';
import { READ_TOOLS } from '../src/main/mcp/tools/read-tools.js';
import {
  defineTool,
  ToolError,
  type ToolDef,
} from '../src/main/mcp/tools/tool-kit.js';
import {
  logLine,
  mcpHarness,
  resultData,
  settle,
  type McpHarness,
} from './helpers/mcp-fakes.js';

const open: McpHarness[] = [];
async function harness(
  tools: readonly ToolDef[] = READ_TOOLS,
  name?: string,
): Promise<McpHarness> {
  const h = await mcpHarness(tools, name ? { name } : {});
  open.push(h);
  return h;
}

const toolNames = async (h: McpHarness): Promise<string[]> =>
  (await h.client.listTools()).tools.map((tool) => tool.name).sort();

const ECHO = defineTool({
  name: 'echo_config',
  scope: 'config',
  title: 'Echo',
  description: 'Test tool',
  input: { value: z.string() },
  run: ({ value }) =>
    Promise.resolve({ data: { value }, target: value, summary: 'eco' }),
});
const FAILING = defineTool({
  name: 'fail_read',
  scope: 'read',
  title: 'Fail',
  description: 'Test tool',
  input: {},
  run: () => Promise.reject(new ToolError('No se puede', 'error', 'Back')),
});
const CRASHING = defineTool({
  name: 'crash_read',
  scope: 'read',
  title: 'Crash',
  description: 'Test tool',
  input: {},
  run: () => Promise.reject(new Error('boom')),
});

describe('src/main/mcp/session.ts', () => {
  afterEach(async () => {
    for (const h of open.splice(0)) await h.close();
  });

  describe('a client that is not approved yet', () => {
    it('is stored as pending under the name it announced', async () => {
      const h = await harness();

      expect(h.clients.list()).toEqual([
        expect.objectContaining({ name: 'Claude Code', status: 'pending' }),
      ]);
    });

    it('sees only the tool that explains how to get access', async () => {
      const h = await harness();

      expect(await toolNames(h)).toEqual(['devbar_access']);
      const result = await h.client.callTool({
        name: 'devbar_access',
        arguments: {},
      });
      expect(resultData(result)).toContain('Ajustes › MCP');
    });

    it('is told it was revoked when it was', async () => {
      const h = await harness();
      const id = h.clients.list()[0]?.id ?? '';
      h.clients.revoke(id);

      const result = await h.client.callTool({
        name: 'devbar_access',
        arguments: {},
      });

      expect(resultData(result)).toContain('revocado');
    });

    it('cannot read any resource', async () => {
      const h = await harness();

      expect((await h.client.listResources()).resources).toEqual([]);
    });
  });

  describe('permissions', () => {
    it('gets the tools of each allowed scope once approved, and is told so', async () => {
      const h = await harness([...READ_TOOLS, ECHO]);
      let changed = 0;
      h.client.setNotificationHandler(
        (await import('@modelcontextprotocol/sdk/types.js'))
          .ToolListChangedNotificationSchema,
        () => {
          changed += 1;
        },
      );

      h.approve();
      await settle();

      expect(changed).toBeGreaterThan(0);
      expect(await toolNames(h)).toEqual(
        READ_TOOLS.map((tool) => tool.name).sort(),
      );
    });

    it('adds the config tools when that scope is switched on', async () => {
      const h = await harness([...READ_TOOLS, ECHO]);

      h.approve({ config: true, read: false });
      await settle();

      expect(await toolNames(h)).toEqual(['echo_config']);
    });

    it('loses every tool the moment it is revoked', async () => {
      const h = await harness();
      h.approve();
      await settle();

      h.clients.revoke(h.clients.list()[0]?.id ?? '');
      await settle();

      expect(await toolNames(h)).toEqual(['devbar_access']);
    });

    it('refuses a call whose scope was switched off, even if it raced the list', async () => {
      const h = await harness([...READ_TOOLS, ECHO]);
      h.approve({ config: true });
      await settle();
      const id = h.clients.list()[0]?.id ?? '';
      // The store changes without the session hearing it (a race).
      const realGet = h.clients.get.bind(h.clients);
      h.clients.get = (clientId) => {
        const client = realGet(clientId);
        return client
          ? { ...client, scopes: { ...client.scopes, config: false } }
          : null;
      };

      const result = await h.client.callTool({
        name: 'echo_config',
        arguments: { value: 'x' },
      });

      expect(result.isError).toBe(true);
      expect(resultData(result)).toContain('no tiene permiso');
      expect(h.audit.list({ limit: 5, clientId: id })[0]).toMatchObject({
        tool: 'echo_config',
        result: 'rejected',
      });
    });
  });

  describe('calls', () => {
    it('answers with JSON data, counts the call and audits it', async () => {
      const h = await harness();
      h.approve();
      await settle();

      const result = await h.client.callTool({
        name: 'get_ports',
        arguments: {},
      });

      expect(resultData(result)).toEqual([]);
      const client = h.clients.list()[0];
      expect(client?.callsToday).toBeGreaterThan(0);
      expect(h.audit.list({ limit: 1 })[0]).toMatchObject({
        clientName: 'Claude Code',
        tool: 'get_ports',
        result: 'ok',
        summary: 'sin puertos',
      });
    });

    it("reports each group's git branch, asked from git", async () => {
      const h = await harness();
      h.runtime.branches.set('back', 'fix/date-index');
      h.approve();
      await settle();

      const result = await h.client.callTool({
        name: 'get_status',
        arguments: {},
      });

      expect(resultData(result)).toMatchObject([
        { name: 'Back', branch: 'fix/date-index' },
        { name: 'Front', branch: null },
      ]);
    });

    it('turns a ToolError into an error result the assistant can read', async () => {
      const h = await harness([FAILING]);
      h.approve();
      await settle();

      const result = await h.client.callTool({
        name: 'fail_read',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(resultData(result)).toBe('No se puede');
      expect(h.audit.list({ limit: 1 })[0]).toMatchObject({
        result: 'error',
        target: 'Back',
        summary: 'No se puede',
      });
    });

    it('reports anything else as an internal error', async () => {
      const h = await harness([CRASHING]);
      h.approve();
      await settle();

      const result = await h.client.callTool({
        name: 'crash_read',
        arguments: {},
      });

      expect(resultData(result)).toBe('Error de DevBar: boom');
    });

    it('validates the arguments against the tool schema', async () => {
      const h = await harness([ECHO]);
      h.approve({ config: true });
      await settle();

      const result = await h.client.callTool({
        name: 'echo_config',
        arguments: { value: 42 },
      });

      expect(result.isError).toBe(true);
    });

    it('masks secrets in what a redacting client reads', async () => {
      const h = await harness();
      h.approve();
      await settle();
      h.runtime.logLines.set('cmd:back:normal', [
        logLine('connecting with password=hunter2-secret'),
      ]);

      const result = await h.client.callTool({
        name: 'read_logs',
        arguments: { group: 'Back', target: 'Normal' },
      });

      expect(JSON.stringify(resultData(result))).not.toContain('hunter2');
    });

    it('shows secrets to a client that does not redact', async () => {
      const h = await harness();
      h.approve();
      h.clients.update(h.clients.list()[0]?.id ?? '', {
        redactSecrets: false,
      });
      await settle();
      h.runtime.logLines.set('cmd:back:normal', [logLine('token hunter2')]);

      const result = await h.client.callTool({
        name: 'read_logs',
        arguments: { group: 'back', target: 'normal' },
      });

      expect(JSON.stringify(resultData(result))).toContain('hunter2');
    });

    it('hides the groups a client was not given', async () => {
      const h = await harness();
      h.approve();
      h.clients.update(h.clients.list()[0]?.id ?? '', { groups: ['front'] });
      await settle();

      const listed = resultData(
        await h.client.callTool({ name: 'list_groups', arguments: {} }),
      ) as { name: string }[];
      const denied = await h.client.callTool({
        name: 'read_logs',
        arguments: { group: 'Back', target: 'Normal' },
      });

      expect(listed.map((g) => g.name)).toEqual(['Front']);
      expect(resultData(denied)).toBe(
        'No hay ningún grupo «Back» al que tengas acceso',
      );
    });
  });

  describe('resources', () => {
    it('lists the groups, workflows and every command log once readable', async () => {
      const h = await harness();
      h.approve();
      await settle();

      const { resources } = await h.client.listResources();

      expect(resources.map((r) => r.uri)).toEqual([
        'devbar://groups',
        'devbar://workflows',
        'devbar://logs/back/normal',
        'devbar://logs/front/vite',
      ]);
    });

    it('reads a command log through the redactor and audits it', async () => {
      const h = await harness();
      h.approve();
      await settle();
      h.runtime.logLines.set('cmd:front:vite', [
        logLine('ready in 300ms'),
        logLine('Authorization: Bearer abcdefghijklmnop'),
      ]);

      const read = await h.client.readResource({
        uri: 'devbar://logs/front/vite',
      });

      expect(read.contents[0]).toMatchObject({
        text: 'ready in 300ms\nAuthorization: Bearer ••••••',
      });
      expect(h.audit.list({ limit: 1 })[0]?.tool).toBe('logs');
    });

    it('reads the groups with their live status', async () => {
      const h = await harness();
      h.approve();
      await settle();

      const read = await h.client.readResource({ uri: 'devbar://groups' });

      const body = JSON.parse((read.contents[0] as { text: string }).text) as {
        groups: unknown[];
        status: unknown[];
      };
      expect(body.groups).toHaveLength(2);
      expect(body.status).toHaveLength(2);
    });

    it('tells a subscriber when the state changes, at most once a second', async () => {
      const h = await harness();
      h.approve();
      await settle();
      const updates: string[] = [];
      h.client.setNotificationHandler(
        (await import('@modelcontextprotocol/sdk/types.js'))
          .ResourceUpdatedNotificationSchema,
        (notification) => {
          updates.push(notification.params.uri);
        },
      );
      await h.client.subscribeResource({ uri: 'devbar://groups' });
      h.timers.length = 0;

      h.runtime.emit('groups');
      h.runtime.emit('groups');
      h.runtime.emit('workflows');

      expect(h.timers.map((t) => t.ms)).toEqual([RESOURCE_UPDATE_MS]);
      h.timers.splice(0).forEach((t) => t.fn());
      await settle();
      expect(updates).toEqual(['devbar://groups']);
    });

    it('stops telling once unsubscribed', async () => {
      const h = await harness();
      h.approve();
      await settle();
      await h.client.subscribeResource({ uri: 'devbar://workflows' });
      await h.client.unsubscribeResource({ uri: 'devbar://workflows' });
      h.timers.length = 0;

      h.runtime.emit('workflows');

      expect(h.timers).toEqual([]);
    });
  });

  it('identifies another assistant by its own name', async () => {
    const h = await harness(READ_TOOLS, 'cursor-vscode');

    expect(h.clients.list()[0]).toMatchObject({
      name: 'Cursor',
      kind: 'cursor',
    });
  });
});
