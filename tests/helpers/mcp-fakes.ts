/**
 * Fakes shared by the MCP server tests: an in-memory app runtime over plain
 * groups (no process manager, no Electron), the client store / audit log /
 * confirmation desk wired to a fake clock, and a connected MCP client over
 * the SDK's in-memory transport — the same protocol an assistant speaks,
 * without a socket.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeCommandId } from '../../src/compound-id.js';
import type {
  Group,
  LogEntry,
  ProcessState,
  Workflow,
} from '../../src/domain-types.js';
import type {
  GroupState,
  WorkflowEntry,
  WorkflowRunState,
} from '../../src/ipc-contract.js';
import { createAuditLog } from '../../src/main/mcp/audit-log.js';
import { createClientStore } from '../../src/main/mcp/client-store.js';
import { createConfirmDesk } from '../../src/main/mcp/confirm-desk.js';
import { createConfigChanges } from '../../src/main/mcp/config-changes.js';
import type { McpRuntime } from '../../src/main/mcp/runtime.js';
import { fakeConfigPort, type FakeConfigPort } from './mcp-config-fakes.js';
import { createSession, type Session } from '../../src/main/mcp/session.js';
import type { ToolDef } from '../../src/main/mcp/tools/tool-kit.js';
import type {
  McpConfirmRequest,
  McpScopes,
} from '../../src/ipc-contract/mcp-api.js';
import { makeCommand, makeGroup } from './main-fakes.js';

export { fakeConfigPort };

export interface FakeRuntime extends McpRuntime {
  groups: Group[];
  workflows: Workflow[];
  logLines: Map<string, LogEntry[]>;
  states: Map<string, Partial<ProcessState>>;
  runStates: Map<string, WorkflowRunState>;
  calls: string[];
  /** Simulates the bus pulse. */
  emit(what: 'groups' | 'workflows'): void;
}

export function fakeRuntime(groups: Group[] = defaultGroups()): FakeRuntime {
  const listeners = new Set<(what: 'groups' | 'workflows') => void>();
  const runtime: FakeRuntime = {
    groups,
    workflows: [],
    logLines: new Map(),
    states: new Map(),
    runStates: new Map(),
    calls: [],
    emit: (what) => {
      for (const listener of listeners) listener(what);
    },
    listGroups: () => structuredClone(runtime.groups),
    groupStates: (): GroupState[] =>
      runtime.groups.map((group) => ({
        groupId: group.id,
        group,
        currentBranch: 'main',
        color: 'running',
        lastError: null,
        commands: group.commands.map((command) => {
          const id = makeCommandId(group.id, command.id);
          const state = runtime.states.get(id);
          return {
            commandId: command.id,
            processId: id,
            status: state?.status ?? 'stopped',
            warnCount: 0,
            errorCount: 0,
            lastError: null,
            startedAt: state?.startedAt ?? null,
            color: 'stopped',
            muteWarn: false,
            muteErr: false,
            ports:
              state?.status === 'running'
                ? [
                    {
                      port: 5173,
                      url: 'http://localhost:5173/',
                      kind: 'web',
                      source: 'log',
                      lanReachable: false,
                    },
                  ]
                : [],
          };
        }),
        actions: group.actions.map((action) => ({
          actionId: action.id,
          processId: `act:${group.id}:${action.id}`,
          status: 'idle',
          lastExitCode: null,
          lastFinishedAt: null,
          startedAt: null,
        })),
      })),
    workflowEntries: (): WorkflowEntry[] =>
      runtime.workflows.map((workflow) => ({
        workflow,
        lastRun: null,
        nextRunAt: null,
        scriptCount: workflow.graph.blocks.flatMap((b) => b.scripts).length,
        running: null,
      })),
    workflowRunState: (id) => runtime.runStates.get(id) ?? null,
    logs: (id) => runtime.logLines.get(id) ?? [],
    processState: (id) => ({
      status: 'stopped',
      lastExitCode: null,
      lastFinishedAt: null,
      startedAt: null,
      ...runtime.states.get(id),
    }),
    startProcess: (id) => {
      runtime.calls.push(`start:${id}`);
      runtime.states.set(id, { status: 'running', startedAt: 1 });
      return Promise.resolve({ ok: true });
    },
    stopProcess: (id) => {
      runtime.calls.push(`stop:${id}`);
      runtime.states.set(id, { status: 'stopped' });
      return Promise.resolve({ ok: true });
    },
    runAction: (groupId, actionId) => {
      const processId = `act:${groupId}:${actionId}`;
      runtime.calls.push(`run:${processId}`);
      return Promise.resolve({ ok: true, processId });
    },
    runWorkflow: (id) => {
      runtime.calls.push(`workflow:${id}`);
      return Promise.resolve({ ok: true, runId: 1 });
    },
    stopWorkflow: (id) => {
      runtime.calls.push(`stopWorkflow:${id}`);
      return { ok: true };
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return runtime;
}

function defaultGroups(): Group[] {
  return [
    makeGroup({
      id: 'back',
      name: 'Back',
      path: '/work/back',
      env: [{ key: 'DB_PASSWORD', value: 'hunter2-secret', enabled: true }],
      commands: [
        makeCommand({
          id: 'normal',
          name: 'Normal',
          command: 'pnpm start:dev',
        }),
      ],
    }),
    makeGroup({
      id: 'front',
      name: 'Front',
      path: '/work/front',
      commands: [
        makeCommand({ id: 'vite', name: 'Vite', command: 'pnpm dev' }),
      ],
    }),
  ];
}

export function logLine(line: string, ts = 1000): LogEntry {
  return { ts, stream: 'stdout', level: null, line };
}

export interface McpHarness {
  runtime: FakeRuntime;
  session: Session;
  client: Client;
  clients: ReturnType<typeof createClientStore>;
  audit: ReturnType<typeof createAuditLog>;
  desk: ReturnType<typeof createConfirmDesk>;
  requests: McpConfirmRequest[];
  timers: { fn: () => void; ms: number }[];
  firstApprovals: Set<string>;
  port: FakeConfigPort;
  /** Approves the connected client with these scopes. */
  approve(scopes?: Partial<McpScopes>): void;
  close(): Promise<void>;
}

export async function mcpHarness(
  tools: readonly ToolDef[],
  options: { runtime?: FakeRuntime; name?: string } = {},
): Promise<McpHarness> {
  const runtime = options.runtime ?? fakeRuntime();
  let now = 1_000_000;
  let ids = 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const setTimer = (fn: () => void, ms: number): unknown => {
    const timer = { fn, ms };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (handle: unknown): void => {
    const index = timers.indexOf(handle as { fn: () => void; ms: number });
    if (index >= 0) timers.splice(index, 1);
  };
  const clients = createClientStore({
    read: () => undefined,
    write: () => undefined,
    now: () => now,
    newId: () => `client${++ids}`,
    setTimer,
    clearTimer,
  });
  const audit = createAuditLog({
    load: () => null,
    append: () => undefined,
    rewrite: () => undefined,
    now: () => now,
    newId: () => `audit${++ids}`,
    published: () => undefined,
  });
  const requests: McpConfirmRequest[] = [];
  const desk = createConfirmDesk({
    now: () => now,
    newId: () => `confirm${++ids}`,
    setTimer,
    clearTimer,
    requested: (request) => requests.push(request),
    closed: () => undefined,
  });
  const firstApprovals = new Set<string>();
  const port = fakeConfigPort(runtime);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const session = createSession(serverSide, {
    clients,
    audit,
    desk,
    runtime,
    changes: createConfigChanges(port),
    tools,
    version: '0.12.0',
    firstApprovals,
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    setTimer,
  });
  const client = new Client({
    name: options.name ?? 'claude-code',
    version: '2.0.0',
  });
  await client.connect(clientSide);
  return {
    runtime,
    session,
    client,
    clients,
    audit,
    desk,
    requests,
    timers,
    firstApprovals,
    port,
    approve: (scopes) => {
      const id = clients.list()[0]?.id;
      if (!id) throw new Error('no client identified yet');
      clients.approve(id, scopes);
    },
    close: async () => {
      await client.close();
      await session.close();
    },
  };
}

/** The text of a tool result, parsed when it is JSON. */
export function resultData(result: unknown): unknown {
  const content = (result as { content?: { type: string; text: string }[] })
    .content;
  const textValue = content?.[0]?.text ?? '';
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    return textValue;
  }
}

/** Lets the SDK deliver what is already queued (list_changed and friends). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
