import {
  McpServer,
  type RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClient } from '../../ipc-contract/mcp-api.js';
import type { AuditLog } from './audit-log.js';
import type { ClientStore } from './client-store.js';
import type { ConfirmDesk } from './confirm-desk.js';
import type { McpRuntime } from './runtime.js';
import { createCalls, isAllowed, text } from './session-calls.js';
import { registerResources } from './session-resources.js';
import type { ToolDef } from './tools/tool-kit.js';

/**
 * One assistant connection: an MCP server over its transport, the client it
 * turned out to be, and the tools that client may use right now.
 *
 * The client is identified by the name it gives in `initialize`. Until the
 * user approves it in Settings › MCP the session lists a single tool that
 * says so; once approved, the tools of each allowed scope appear (the SDK
 * tells the assistant the list changed), and they disappear the moment a
 * scope is switched off or the client is revoked. Each call checks the
 * permission again anyway, records the call and audits it.
 */

export interface SessionDeps {
  clients: ClientStore;
  audit: AuditLog;
  desk: ConfirmDesk;
  runtime: McpRuntime;
  tools: readonly ToolDef[];
  version: string;
  /** «Ask the first time» answers, shared by every session of the app. */
  firstApprovals: Set<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
}

export interface Session {
  server: McpServer;
  close(): Promise<void>;
}

const PENDING_TOOL = 'devbar_access';
const INSTRUCTIONS = `DevBar is a menu-bar launcher for local development services. A group is a project folder with commands (long-running services such as dev servers), actions (one-off tasks such as a build) and pre-scripts (steps that workflows run). Wherever a tool asks for a group, command, action, pre-script or workflow, its id or its name is accepted. The user grants this client its permissions in DevBar › Settings › MCP; some calls wait until the user confirms them in DevBar, and are rejected when nobody answers within 60 seconds. Configuration changes always show the user a diff first and can be undone (undo_last_change).`;

function pendingText(client: McpClient | null): string {
  if (client?.status === 'revoked')
    return `El acceso de «${client.name}» a DevBar está revocado. Para volver a usarlo, permítelo en DevBar › Ajustes › MCP.`;
  return `DevBar todavía no ha autorizado a este asistente${client ? ` («${client.name}»)` : ''}. Pide al usuario que abra DevBar › Ajustes › MCP y pulse «Permitir…»; las herramientas aparecerán en cuanto lo haga.`;
}

export function createSession(
  transport: Transport,
  deps: SessionDeps,
): Session {
  const server = new McpServer(
    { name: 'devbar', title: 'DevBar', version: deps.version },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );
  let clientId: string | null = null;
  const current = (): McpClient | null =>
    clientId === null ? null : deps.clients.get(clientId);
  const allowed = isAllowed;

  const { call, contextFor } = createCalls(deps, current);

  // ── Tools ─────────────────────────────────────────────────────────────

  const registered = new Map<ToolDef, RegisteredTool>();
  for (const def of deps.tools) {
    const tool = server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        ...(def.annotations ? { annotations: def.annotations } : {}),
      },
      (args: unknown) => call(def, args),
    );
    tool.disable();
    registered.set(def, tool);
  }
  const pendingTool = server.registerTool(
    PENDING_TOOL,
    {
      title: 'DevBar access',
      description:
        'Explains why DevBar shows no other tools yet: this assistant must be approved in DevBar › Settings › MCP first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => Promise.resolve(text(pendingText(current()))),
  );

  const { resources, stop: stopListening } = registerResources(
    server,
    deps,
    current,
    contextFor,
  );

  // ── Permissions follow the client ─────────────────────────────────────

  const sync = (): void => {
    const client = current();
    const ok = allowed(client);
    for (const [def, tool] of registered) {
      const want = ok && client.scopes[def.scope];
      if (want !== tool.enabled) {
        if (want) tool.enable();
        else tool.disable();
      }
    }
    if (ok === pendingTool.enabled) {
      if (ok) pendingTool.disable();
      else pendingTool.enable();
    }
    const readable = ok && client.scopes.read;
    for (const resource of resources) {
      if (readable !== resource.enabled) {
        if (readable) resource.enable();
        else resource.disable();
      }
    }
  };
  sync();
  const stopFollowing = deps.clients.onChange((client) => {
    if (client.id === clientId) sync();
  });
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    const client = deps.clients.identify({
      name: info?.name ?? 'unknown',
      version: info?.version,
      title: info?.title,
    });
    clientId = client.id;
    deps.clients.recordCall(client.id);
    sync();
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopFollowing();
    stopListening();
    await server.close();
  };
  server.server.onclose = () => void close();
  void server.connect(transport);
  return { server, close };
}
