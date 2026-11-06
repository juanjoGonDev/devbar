import { afterEach, describe, expect, it } from 'vitest';
import { makeCommandId, makePreScriptId } from '../src/compound-id.js';
import type { LogEntry } from '../src/domain-types.js';
import type { WorkflowRunState } from '../src/ipc-contract/workflows-api.js';
import { READ_TOOLS } from '../src/main/mcp/tools/read-tools.js';
import { makeAction, makePreScript } from './helpers/main-fakes.js';
import {
  fakeRuntime,
  mcpHarness,
  resultData,
  settle,
  type McpHarness,
} from './helpers/mcp-fakes.js';
import { workflow } from './helpers/workflows.js';

const NORMAL = makeCommandId('back', 'normal');
const VPN = makePreScriptId('back', 'vpn');

const open: McpHarness[] = [];

async function harness(): Promise<McpHarness> {
  const runtime = fakeRuntime();
  const back = runtime.groups[0];
  if (back) {
    back.actions = [makeAction({ id: 'build', name: 'Build' })];
    back.preScripts = [makePreScript({ id: 'vpn', name: 'VPN' })];
  }
  runtime.workflows = [
    workflow(
      'boot',
      { kind: 'manual', confirm: false },
      {
        name: 'Arranque',
        graph: {
          blocks: [
            {
              id: 'b1',
              scripts: [{ groupId: 'back', scriptId: 'vpn' }],
              x: 0,
              y: 0,
              requireAll: true,
            },
          ],
          edges: [{ from: 'trigger', to: 'b1' }],
        },
      },
    ),
  ];
  const h = await mcpHarness(READ_TOOLS, { runtime });
  open.push(h);
  h.approve();
  await settle();
  return h;
}

const entry = (
  line: string,
  ts: number,
  level: LogEntry['level'] = null,
): LogEntry => ({ ts, stream: 'stdout', level, line });

async function call(
  h: McpHarness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ data: unknown; isError: boolean }> {
  const result = await h.client.callTool({ name, arguments: args });
  return { data: resultData(result), isError: result.isError === true };
}

const lines = (data: unknown): string[] =>
  (data as { line: string }[]).map((row) => row.line);

describe('src/main/mcp/tools/read-tools.ts', () => {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });

  describe('list_groups', () => {
    it('lists every group with its env values masked', async () => {
      const h = await harness();

      const { data } = await call(h, 'list_groups');

      expect(data).toMatchObject([
        {
          name: 'Back',
          folder: '/work/back',
          commands: [{ name: 'Normal', command: 'pnpm start:dev' }],
          actions: [{ name: 'Build' }],
          preScripts: [{ name: 'VPN' }],
        },
        { name: 'Front' },
      ]);
      expect(JSON.stringify(data)).not.toContain('hunter2-secret');
    });
  });

  describe('get_status', () => {
    it('masks secrets in the last errors it reports', async () => {
      const h = await harness();
      h.runtime.states.set(NORMAL, {
        status: 'error',
        lastError: 'auth failed for hunter2-secret',
      });
      h.runtime.groupErrors.set('back', 'Bearer abcdefghijklmnop rejected');

      const { data } = await call(h, 'get_status', { group: 'Back' });

      expect(data).toMatchObject([
        {
          lastError: 'Bearer •••••• rejected',
          commands: [{ lastError: 'auth failed for ••••••' }],
        },
      ]);
    });
  });

  describe('get_ports', () => {
    it('lists the ports of running commands, for one group or all', async () => {
      const h = await harness();
      h.runtime.states.set(NORMAL, { status: 'running' });

      const all = await call(h, 'get_ports');
      const front = await call(h, 'get_ports', { group: 'Front' });

      expect(all.data).toMatchObject([
        { group: 'Back', command: 'Normal', ports: [{ port: 5173 }] },
      ]);
      expect(front.data).toEqual([]);
      expect(
        h.audit
          .list({ limit: 2 })
          .map((e) => e.summary)
          .sort(),
      ).toEqual([':5173', 'sin puertos']);
    });
  });

  describe('read_logs', () => {
    it('keeps the tail of the lines that pass the level and date filters', async () => {
      const h = await harness();
      h.runtime.logLines.set(NORMAL, [
        entry('booting', 1000),
        entry('slow query', 2000, 'warn'),
        entry('crash', 3000, 'error'),
        entry('retry', 4000, 'error'),
      ]);

      const tail = await call(h, 'read_logs', {
        group: 'back',
        target: 'normal',
        tail: 2,
      });
      const errors = await call(h, 'read_logs', {
        group: 'Back',
        target: 'Normal',
        level: 'error',
        since: new Date(3500).toISOString(),
      });
      const warnings = await call(h, 'read_logs', {
        group: 'Back',
        target: 'Normal',
        level: 'warn',
        since: 0,
      });

      expect(lines(tail.data)).toEqual(['crash', 'retry']);
      expect(lines(errors.data)).toEqual(['retry']);
      expect(lines(warnings.data)).toEqual(['slow query', 'crash', 'retry']);
    });

    it('reads a pre-script by name', async () => {
      const h = await harness();
      h.runtime.logLines.set(VPN, [entry('connected', 1000)]);

      const { data } = await call(h, 'read_logs', {
        group: 'Back',
        target: 'vpn',
      });

      expect(lines(data)).toEqual(['connected']);
    });

    it('says what is missing for an unknown target or a bad date', async () => {
      const h = await harness();

      const unknown = await call(h, 'read_logs', {
        group: 'Back',
        target: 'nope',
      });
      const badDate = await call(h, 'read_logs', {
        group: 'Back',
        target: 'Normal',
        since: 'yesterday-ish',
      });

      expect(unknown).toEqual({
        isError: true,
        data: 'El grupo «Back» no tiene ningún comando, acción ni pre-script «nope»',
      });
      expect(badDate).toEqual({
        isError: true,
        data: 'Fecha no válida: «yesterday-ish»',
      });
    });
  });

  describe('search_logs', () => {
    it('finds literal text in every log, oldest first', async () => {
      const h = await harness();
      h.runtime.logLines.set(NORMAL, [
        entry('GET /a.b 200', 3000),
        entry('GET /axb 200', 1000),
      ]);
      h.runtime.logLines.set(VPN, [entry('get /A.B again', 2000)]);
      h.runtime.logLines.set(makeCommandId('front', 'vite'), [
        entry('no match', 500),
      ]);

      const { data } = await call(h, 'search_logs', { query: 'a.b' });

      expect(data).toMatchObject([
        { group: 'Back', target: 'VPN', line: 'get /A.B again' },
        { group: 'Back', target: 'Normal', line: 'GET /a.b 200' },
      ]);
    });

    it('honours regex, case, target, level and limit', async () => {
      const h = await harness();
      h.runtime.logLines.set(NORMAL, [
        entry('Error 500', 1000, 'error'),
        entry('error 502', 2000, 'error'),
        entry('Error 404', 3000),
      ]);

      const { data } = await call(h, 'search_logs', {
        query: 'Error 5\\d\\d',
        regex: true,
        caseSensitive: true,
        group: 'Back',
        target: 'Normal',
        level: 'error',
        limit: 5,
      });
      const limited = await call(h, 'search_logs', {
        query: 'error',
        group: 'Back',
        limit: 1,
      });

      expect(lines(data)).toEqual(['Error 500']);
      expect(lines(limited.data)).toEqual(['Error 404']);
    });

    it('gives up on a regex that would freeze DevBar, and says so', async () => {
      const h = await harness();
      h.runtime.logLines.set(NORMAL, [entry(`${'a'.repeat(40)}!`, 1000)]);

      const started = Date.now();
      const result = await call(h, 'search_logs', {
        query: '(a+)+$',
        regex: true,
      });

      expect(result).toEqual({
        isError: true,
        data: 'La expresión regular tarda demasiado; simplifícala',
      });
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('refuses a broken regex and a target without its group', async () => {
      const h = await harness();

      const broken = await call(h, 'search_logs', {
        query: '(',
        regex: true,
      });
      const orphan = await call(h, 'search_logs', {
        query: 'x',
        target: 'Normal',
      });

      expect(broken).toEqual({
        isError: true,
        data: 'Expresión regular no válida: «(»',
      });
      expect(orphan).toEqual({
        isError: true,
        data: 'Indica también el grupo del objetivo',
      });
    });
  });

  describe('workflows', () => {
    it('lists the workflows with their graph and run info', async () => {
      const h = await harness();

      const { data } = await call(h, 'list_workflows');

      expect(data).toMatchObject([
        { id: 'boot', name: 'Arranque', enabled: true, scripts: 1 },
      ]);
    });

    it('reports a workflow that never ran, then its latest run', async () => {
      const h = await harness();

      const never = await call(h, 'workflow_status', { workflow: 'Arranque' });
      h.runtime.runStates.set('boot', {
        workflowId: 'boot',
        runId: 1,
        status: 'success',
      } as WorkflowRunState);
      const ran = await call(h, 'workflow_status', { workflow: 'boot' });

      expect(never.data).toEqual({ workflowId: 'boot', status: 'never-run' });
      expect(ran.data).toMatchObject({ runId: 1, status: 'success' });
    });
  });
});
