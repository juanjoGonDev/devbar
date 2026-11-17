import { afterEach, describe, expect, it } from 'vitest';
import type { McpConfirmPolicy } from '../src/ipc-contract/mcp-api.js';
import { ENTITY_CONFIG_TOOLS } from '../src/main/mcp/tools/config-entity-tools.js';
import { WORKFLOW_CONFIG_TOOLS } from '../src/main/mcp/tools/config-workflow-tools.js';
import {
  mcpHarness,
  resultData,
  settle,
  type McpHarness,
} from './helpers/mcp-fakes.js';

/**
 * The client's confirmation policy for configuration changes: «never»
 * applies them without asking, «first» asks once per client and target per
 * app session, «always» (the default) asks every time. Whatever the policy,
 * the change is backed up and audited with its diff and undo token.
 */

const TOOLS = [...ENTITY_CONFIG_TOOLS, ...WORKFLOW_CONFIG_TOOLS];
const open: McpHarness[] = [];

async function harness(config?: McpConfirmPolicy): Promise<McpHarness> {
  const h = await mcpHarness(TOOLS);
  open.push(h);
  h.approve({ config: true });
  if (config)
    h.clients.update(h.clients.list()[0]?.id ?? '', { confirm: { config } });
  await settle();
  return h;
}

const call = (h: McpHarness, name: string, args: Record<string, unknown>) =>
  h.client.callTool({ name, arguments: args });

/** Calls a tool and answers the confirmation it raises. */
async function answering(
  h: McpHarness,
  name: string,
  args: Record<string, unknown>,
  answer: 'apply' | 'reject' = 'apply',
) {
  const asked = h.requests.length;
  const pending = call(h, name, args);
  for (let i = 0; i < 20 && h.requests.length === asked; i++) await settle();
  const request = h.requests.at(-1);
  if (!request || h.requests.length === asked)
    throw new Error('nothing was asked');
  h.desk.answer(request.id, answer);
  return pending;
}

const back = (h: McpHarness) => h.runtime.groups.find((g) => g.id === 'back');
const commandLine = (h: McpHarness) => back(h)?.commands[0]?.command;
const edit = (command: string) => ({
  group: 'Back',
  target: 'Normal',
  command,
});

describe('src/main/mcp/session-calls.ts', () => {
  afterEach(async () => {
    for (const h of open.splice(0)) await h.close();
  });

  describe('configuration changes with «never»', () => {
    it('applies the change without asking, audited with its diff and undo token', async () => {
      const h = await harness('never');

      const result = await call(h, 'update_command', edit('pnpm dev:debug'));

      expect(h.requests).toEqual([]);
      expect(resultData(result)).toMatchObject({
        ok: true,
        changed: ['comando'],
      });
      expect(commandLine(h)).toBe('pnpm dev:debug');
      const entry = h.audit.list({ limit: 1 })[0];
      expect(entry).toMatchObject({
        tool: 'update_command',
        result: 'ok',
        undoToken: 'undo-token-1',
      });
      expect(entry?.diff).toEqual(
        expect.arrayContaining([
          { kind: 'add', field: 'comando', text: 'pnpm dev:debug' },
        ]),
      );
      expect(h.port.backups.get('undo-token-1')).toBeDefined();
    });

    it('undoes the change, also without asking', async () => {
      const h = await harness('never');
      await call(h, 'update_command', edit('pnpm dev:debug'));

      const undone = await call(h, 'undo_last_change', {});

      expect(h.requests).toEqual([]);
      expect(resultData(undone)).toMatchObject({
        ok: true,
        undone: 'update_command',
      });
      expect(commandLine(h)).toBe('pnpm start:dev');
    });
  });

  describe('configuration changes with «first»', () => {
    it('asks once per target, then applies the same change on that target silently', async () => {
      const h = await harness('first');

      await answering(h, 'update_command', edit('pnpm dev:a'));
      const second = await call(h, 'update_command', edit('pnpm dev:b'));
      await answering(h, 'update_group', { group: 'Back', name: 'Backend' });

      expect(h.requests.map((r) => r.subtitle)).toEqual([
        'Grupo Back · comando Normal',
        'Grupo Back',
      ]);
      expect(resultData(second)).toMatchObject({ ok: true });
      expect(commandLine(h)).toBe('pnpm dev:b');
      const entry = h.audit
        .list({ limit: 10 })
        .find((e) => e.summary === 'comando' && e.undoToken === 'undo-token-2');
      expect(entry?.diff).toEqual(
        expect.arrayContaining([
          { kind: 'add', field: 'comando', text: 'pnpm dev:b' },
        ]),
      );
    });

    it('asks again after a first answer that was a rejection', async () => {
      const h = await harness('first');

      const rejected = await answering(
        h,
        'update_command',
        edit('pnpm dev:a'),
        'reject',
      );
      await answering(h, 'update_command', edit('pnpm dev:a'));

      expect(rejected.isError).toBe(true);
      expect(h.requests).toHaveLength(2);
      expect(commandLine(h)).toBe('pnpm dev:a');
    });

    it('keeps what one client was allowed apart from another', async () => {
      const h = await harness('first');
      await answering(h, 'update_command', edit('pnpm dev:a'));

      expect([...h.firstApprovals]).toEqual([
        expect.stringMatching(/^client\d+\|/),
      ]);
    });
  });

  describe('what the assistant is told', () => {
    it('says a diff is shown unless the user let this client skip it', async () => {
      const h = await harness();

      const instructions = h.client.getInstructions() ?? '';

      expect(instructions).toContain(
        'Configuration changes show the user a diff to approve, unless the user allowed this client to skip it',
      );
      expect(instructions).not.toContain('always show');
    });
  });

  describe('configuration changes with «always»', () => {
    it('asks every time, by default', async () => {
      const h = await harness();

      await answering(h, 'update_command', edit('pnpm dev:a'));
      await answering(h, 'update_command', edit('pnpm dev:b'));

      expect(h.clients.list()[0]?.confirm.config).toBe('always');
      expect(h.requests).toHaveLength(2);
      expect(h.firstApprovals.size).toBe(0);
    });
  });
});
