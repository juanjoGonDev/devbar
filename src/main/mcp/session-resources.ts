import {
  ResourceTemplate,
  type McpServer,
  type RegisteredResource,
  type RegisteredResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { makeCommandId } from '../../compound-id.js';
import type { McpClient } from '../../ipc-contract/mcp-api.js';
import { isAllowed, PERMISSION_DENIED, type Calls } from './session-calls.js';
import type { SessionDeps } from './session.js';
import { groupView } from './tools/views.js';
import { workflowAllowed, type ToolContext } from './tools/tool-kit.js';

/**
 * The read-only MCP resources of a session — `devbar://groups`,
 * `devbar://workflows` and `devbar://logs/{group}/{command}` — with
 * subscriptions: an assistant that subscribed hears `resources/updated`
 * when the state behind one changes, at most once a second per resource
 * (the state stream pulses on every warning line). Gated by the `read`
 * scope like the read tools, and audited the same way.
 */

/** Resource updates for one URI are coalesced to one per this. */
export const RESOURCE_UPDATE_MS = 1000;
const LOG_RESOURCE_LINES = 200;

export interface SessionResources {
  resources: (RegisteredResource | RegisteredResourceTemplate)[];
  /** Stops listening to the app (the session closed). */
  stop: () => void;
}

export function registerResources(
  server: McpServer,
  deps: SessionDeps,
  current: () => McpClient | null,
  contextFor: Calls['contextFor'],
): SessionResources {
  const allowed = isAllowed;
  const readResource = (
    name: string,
    uri: string,
    body: (client: McpClient, ctx: ToolContext) => string,
  ) => {
    const client = current();
    if (!allowed(client) || !client.scopes.read)
      throw new Error(PERMISSION_DENIED(name));
    deps.clients.recordCall(client.id);
    const ctx = contextFor(client, { id: null }, name);
    const contents = body(client, ctx);
    deps.audit.record({
      clientId: client.id,
      clientName: client.name,
      tool: name,
      target: uri,
      result: 'ok',
      summary: 'recurso leído',
    });
    return {
      contents: [
        {
          uri,
          mimeType: name === 'logs' ? 'text/plain' : 'application/json',
          text: contents,
        },
      ],
    };
  };

  const resources: (RegisteredResource | RegisteredResourceTemplate)[] = [
    server.registerResource(
      'groups',
      'devbar://groups',
      {
        title: 'Groups',
        description: 'Every group with its commands, actions and live status.',
        mimeType: 'application/json',
      },
      (uri) =>
        readResource('groups', uri.href, (_client, ctx) =>
          JSON.stringify(
            {
              groups: ctx.groups().map((group) => groupView(ctx, group)),
              status: deps.runtime
                .groupStates()
                .filter((state) => ctx.groupAllowed(state.groupId))
                .map((state) => ({
                  id: state.groupId,
                  commands: state.commands.map((c) => ({
                    id: c.commandId,
                    status: c.status,
                    ports: c.ports.map((p) => p.port),
                  })),
                })),
            },
            null,
            2,
          ),
        ),
    ),
    server.registerResource(
      'workflows',
      'devbar://workflows',
      {
        title: 'Workflows',
        description: 'Every workflow with its trigger, last run and live run.',
        mimeType: 'application/json',
      },
      (uri) =>
        readResource('workflows', uri.href, (_client, ctx) =>
          JSON.stringify(
            deps.runtime
              .workflowEntries()
              .filter((entry) => workflowAllowed(ctx, entry.workflow)),
            null,
            2,
          ),
        ),
    ),
    server.registerResource(
      'logs',
      new ResourceTemplate('devbar://logs/{group}/{command}', {
        list: () => {
          const client = current();
          if (!allowed(client) || !client.scopes.read) return { resources: [] };
          const ctx = contextFor(client, { id: null }, 'logs');
          return {
            resources: ctx.groups().flatMap((group) =>
              group.commands.map((command) => ({
                uri: `devbar://logs/${encodeURIComponent(group.id)}/${encodeURIComponent(command.id)}`,
                name: `${group.name} › ${command.name}`,
                mimeType: 'text/plain',
              })),
            ),
          };
        },
      }),
      {
        title: 'Command logs',
        description: `The last ${LOG_RESOURCE_LINES} lines of one command.`,
        mimeType: 'text/plain',
      },
      (uri, variables) =>
        readResource('logs', uri.href, (_client, ctx) => {
          const groupRef = decodeURIComponent(String(variables.group));
          const commandRef = decodeURIComponent(String(variables.command));
          const group = ctx.groups().find((g) => g.id === groupRef);
          const command = group?.commands.find((c) => c.id === commandRef);
          if (!group || !command)
            throw new Error(
              `No hay ningún comando «${groupRef}/${commandRef}»`,
            );
          return ctx.runtime
            .logs(makeCommandId(group.id, command.id))
            .slice(-LOG_RESOURCE_LINES)
            .map((entry) => ctx.redact.text(entry.line))
            .join('\n');
        }),
    ),
  ];

  const subscriptions = new Set<string>();
  const scheduled = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });
  const notify = (uri: string): void => {
    if (scheduled.has(uri)) return;
    scheduled.add(uri);
    deps.setTimer(() => {
      scheduled.delete(uri);
      if (subscriptions.has(uri) && server.isConnected())
        void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
    }, RESOURCE_UPDATE_MS);
  };
  const stopListening = deps.runtime.onChange((what) => {
    if (!allowed(current())) return;
    for (const uri of subscriptions) {
      if (
        what === 'workflows'
          ? uri === 'devbar://workflows'
          : uri !== 'devbar://workflows'
      )
        notify(uri);
    }
  });

  return { resources, stop: stopListening };
}
