import { afterEach, describe, expect, it } from 'vitest';
import type { McpConfirmPolicy } from '../src/ipc-contract/mcp-api.js';
import { CONTROL_TOOLS } from '../src/main/mcp/tools/control-tools.js';
import { makeAction, makePreScript } from './helpers/main-fakes.js';
import {
  fakeRuntime,
  logLine,
  mcpHarness,
  resultData,
  settle,
  type McpHarness,
} from './helpers/mcp-fakes.js';

const open: McpHarness[] = [];

async function harness(
  policy: { control?: McpConfirmPolicy; workflows?: McpConfirmPolicy } = {},
): Promise<McpHarness> {
  const runtime = fakeRuntime();
  const back = runtime.groups[0];
  if (back) {
    back.actions = [makeAction({ id: 'build', name: 'Build' })];
    back.preScripts = [makePreScript({ id: 'vpn', name: 'VPN' })];
  }
  runtime.workflows = [
    {
      id: 'boot',
      name: 'Arranque',
      enabled: true,
      hidden: false,
      trigger: { kind: 'manual', confirm: false },
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
  ];
  const h = await mcpHarness(CONTROL_TOOLS, { runtime });
  open.push(h);
  h.approve();
  h.clients.update(h.clients.list()[0]?.id ?? '', {
    confirm: {
      control: policy.control ?? 'never',
      workflows: policy.workflows ?? 'never',
    },
  });
  await settle();
  return h;
}

const call = (h: McpHarness, name: string, args: Record<string, unknown>) =>
  h.client.callTool({ name, arguments: args });

/** Calls a tool and answers its confirmation in DevBar. */
async function callAnswering(
  h: McpHarness,
  name: string,
  args: Record<string, unknown>,
  answer: 'apply' | 'reject',
) {
  const pending = call(h, name, args);
  await settle();
  const request = h.requests.at(-1);
  if (!request) throw new Error('nothing was asked');
  h.desk.answer(request.id, answer);
  return pending;
}

describe('src/main/mcp/tools/control-tools.ts', () => {
  afterEach(async () => {
    for (const h of open.splice(0)) await h.close();
  });

  it('starts, stops and restarts a command by name', async () => {
    const h = await harness();

    await call(h, 'start', { group: 'Back', command: 'Normal' });
    await call(h, 'stop', { group: 'back', command: 'normal' });
    const restarted = await call(h, 'restart', {
      group: 'Back',
      command: 'Normal',
    });

    expect(h.runtime.calls).toEqual([
      'start:cmd:back:normal',
      'stop:cmd:back:normal',
      'stop:cmd:back:normal',
      'start:cmd:back:normal',
    ]);
    expect(resultData(restarted)).toEqual({ ok: true, status: 'running' });
    expect(h.requests).toEqual([]);
  });

  it('asks every time with «always», showing who and what', async () => {
    const h = await harness({ control: 'always' });

    await callAnswering(
      h,
      'start',
      { group: 'Back', command: 'Normal', reason: 'Depurar' },
      'apply',
    );
    await callAnswering(
      h,
      'start',
      { group: 'Back', command: 'Normal' },
      'apply',
    );

    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]).toMatchObject({
      clientName: 'Claude Code',
      title: 'Claude Code quiere arrancar un comando',
      subtitle: 'Grupo Back · comando Normal',
      risk: 'executes',
      reason: 'Depurar',
    });
  });

  it('asks only the first time per target with «first»', async () => {
    const h = await harness({ control: 'first' });

    await callAnswering(
      h,
      'start',
      { group: 'Back', command: 'Normal' },
      'apply',
    );
    await call(h, 'start', { group: 'Back', command: 'Normal' });
    await callAnswering(
      h,
      'start',
      { group: 'Front', command: 'Vite' },
      'apply',
    );

    expect(h.requests.map((r) => r.subtitle)).toEqual([
      'Grupo Back · comando Normal',
      'Grupo Front · comando Vite',
    ]);
  });

  it('asks again after a «first» that was rejected', async () => {
    const h = await harness({ control: 'first' });

    const rejected = await callAnswering(
      h,
      'start',
      { group: 'Back', command: 'Normal' },
      'reject',
    );
    await callAnswering(
      h,
      'start',
      { group: 'Back', command: 'Normal' },
      'apply',
    );

    expect(rejected.isError).toBe(true);
    expect(resultData(rejected)).toBe('El usuario lo ha rechazado en DevBar.');
    expect(h.requests).toHaveLength(2);
  });

  it('runs nothing when rejected and audits it as rejected, not pending', async () => {
    const h = await harness({ control: 'always' });

    await callAnswering(
      h,
      'stop',
      { group: 'Back', command: 'Normal' },
      'reject',
    );

    expect(h.runtime.calls).toEqual([]);
    expect(h.audit.list({ limit: 5 })).toEqual([
      expect.objectContaining({
        tool: 'stop',
        result: 'rejected',
        target: 'Grupo Back · comando Normal',
      }),
    ]);
  });

  it('is rejected on its own when nobody answers', async () => {
    const h = await harness({ control: 'always' });

    const pending = call(h, 'start', { group: 'Back', command: 'Normal' });
    await settle();
    h.timers.find((t) => t.ms === 60_000)?.fn();

    expect(resultData(await pending)).toContain('60 s');
  });

  it('reports a command the app could not start', async () => {
    const h = await harness();
    h.runtime.startProcess = () =>
      Promise.resolve({ ok: false, error: 'puerto ocupado' });

    const result = await call(h, 'start', { group: 'Back', command: 'Normal' });

    expect(result.isError).toBe(true);
    expect(resultData(result)).toBe('puerto ocupado');
  });

  it('reports a start the command’s own confirmation cancelled', async () => {
    const h = await harness();
    h.runtime.startProcess = () =>
      Promise.resolve({ ok: false, cancelled: true });

    const result = await call(h, 'start', { group: 'Back', command: 'Normal' });

    expect(resultData(result)).toBe(
      'Cancelado en el diálogo de confirmación de DevBar.',
    );
  });

  it('runs an action and, when asked, waits for its exit code and log tail', async () => {
    const h = await harness();
    h.runtime.runAction = (groupId, actionId) => {
      const processId = `act:${groupId}:${actionId}`;
      h.runtime.states.set(processId, { status: 'running' });
      h.runtime.logLines.set(processId, [
        logLine('compiling'),
        logLine('done'),
      ]);
      return Promise.resolve({ ok: true, processId });
    };
    let polls = 0;
    const realState = h.runtime.processState.bind(h.runtime);
    h.runtime.processState = (id) => {
      polls += 1;
      if (polls === 3)
        h.runtime.states.set(id, { status: 'done', lastExitCode: 0 });
      return realState(id);
    };

    const result = await call(h, 'run_action', {
      group: 'Back',
      action: 'Build',
      wait: 30,
      tail: 1,
    });

    expect(resultData(result)).toMatchObject({
      ok: true,
      finished: true,
      exitCode: 0,
      logs: [expect.objectContaining({ line: 'done' })],
    });
    expect(h.audit.list({ limit: 1 })[0]?.summary).toBe('código de salida 0');
  });

  it('says an action is still running when the wait runs out', async () => {
    const h = await harness();
    h.runtime.runAction = (groupId, actionId) => {
      h.runtime.states.set(`act:${groupId}:${actionId}`, { status: 'running' });
      return Promise.resolve({
        ok: true,
        processId: `act:${groupId}:${actionId}`,
      });
    };

    const result = await call(h, 'run_action', {
      group: 'Back',
      action: 'Build',
      wait: 2,
    });

    expect(resultData(result)).toMatchObject({ finished: false });
    expect(h.audit.list({ limit: 1 })[0]?.result).toBe('warning');
  });

  it('answers at once for an action it does not wait for', async () => {
    const h = await harness();

    const result = await call(h, 'run_action', {
      group: 'Back',
      action: 'Build',
    });

    expect(resultData(result)).toEqual({ ok: true, status: 'running' });
    expect(h.runtime.calls).toEqual(['run:act:back:build']);
  });

  it('waits for a port and answers with it, or times out', async () => {
    const h = await harness();
    h.runtime.states.set('cmd:back:normal', { status: 'running' });

    const found = await call(h, 'wait_for_port', {
      group: 'Back',
      command: 'Normal',
      port: 5173,
    });
    const missing = await call(h, 'wait_for_port', {
      group: 'Front',
      command: 'Vite',
      timeout: 1,
    });

    expect(resultData(found)).toEqual([
      expect.objectContaining({ port: 5173 }),
    ]);
    expect(resultData(missing)).toBe(
      '«Front › Vite» no escucha en ningún puerto tras 1 s',
    );
  });

  it('runs a workflow and waits for its result when asked', async () => {
    const h = await harness({ workflows: 'first' });

    const result = await callAnswering(
      h,
      'run_workflow',
      { workflow: 'Arranque', wait: true },
      'apply',
    );

    expect(h.runtime.calls).toEqual(['workflow:boot']);
    expect(resultData(result)).toMatchObject({ ok: true, status: 'success' });
    expect(h.requests[0]).toMatchObject({
      title: 'Claude Code quiere lanzar un workflow',
      subtitle: 'Workflow Arranque',
    });
  });

  it('starts a workflow without waiting, and stops it', async () => {
    const h = await harness();

    const started = await call(h, 'run_workflow', { workflow: 'boot' });
    await call(h, 'stop_workflow', { workflow: 'boot' });

    expect(resultData(started)).toEqual({ ok: true, started: true });
    expect(h.runtime.calls).toEqual(['workflow:boot', 'stopWorkflow:boot']);
  });

  it('hides a workflow that runs scripts of a group the client cannot see', async () => {
    const h = await harness();
    h.clients.update(h.clients.list()[0]?.id ?? '', { groups: ['front'] });

    const result = await call(h, 'run_workflow', { workflow: 'Arranque' });

    expect(resultData(result)).toBe(
      'No hay ningún workflow «Arranque» al que tengas acceso',
    );
  });
});
