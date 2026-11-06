import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHome } from '../../app-paths.js';
import type { GlobalSettings, McpSettings } from '../../domain-types.js';
import type { McpAuditEntry } from '../../ipc-contract/mcp-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import type { IpcRegistrar } from '../ipc-validators.js';
import { sendToRenderers, settingsPushes } from '../renderer-bus.js';
import { createAuditLog, type AuditLog } from './audit-log.js';
import { createClientStore, type ClientStore } from './client-store.js';
import { createConfirmDesk, type ConfirmDesk } from './confirm-desk.js';
import { connectCommands } from './connect-command.js';
import {
  createMcpControl,
  type McpControl,
  type McpEndpoint,
} from './mcp-control.js';
import { createConfigChanges } from './config-changes.js';
import {
  createIpcTap,
  electronConfigPort,
  type ConfigPortWiring,
} from './config-port-wiring.js';
import { localEndpoint } from './local-endpoint.js';
import { mcpRuntime, type McpRuntimeWiring } from './runtime.js';
import { MCP_TOOLS } from './tools/catalog.js';

/**
 * The MCP server wired to the real collaborators: the config store, the disk,
 * the window fan-out and the config window. Everything it decides lives in
 * the modules next door; this only hands them what main.ts has.
 */

export interface McpWiring {
  /** The app's data folder; the MCP files live in its `mcp` subfolder. */
  appHome: string;
  /** Where the compiled main process lives (build/src). */
  mainDir: string;
  execPath: string;
  platform: NodeJS.Platform;
  configStore: {
    getGlobalSettings(): GlobalSettings;
    saveMcpSettings(mcp: McpSettings): GlobalSettings;
    getMcpClients(): unknown;
    saveMcpClients(value: readonly unknown[]): void;
  };
  send(channel: string, payload: unknown): void;
  sendSettings(settings: GlobalSettings): void;
  /** Brings Settings up on its MCP section, for a confirmation. */
  showConfirmations(): void;
}

/** What the server half needs on top of the control surface. */
export interface McpParts {
  control: McpControl;
  clients: ClientStore;
  audit: AuditLog;
  desk: ConfirmDesk;
  home: string;
}

const AUDIT_FILE = 'audit.jsonl';
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

const timers = {
  setTimer: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimer: (handle: unknown): void =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What a local endpoint is built from. */
export type McpCore = Omit<McpParts, 'control'>;

/** The app's MCP folder (socket, token, audit, backups). */
function mcpHome(appHomeDir: string): string {
  return path.join(appHomeDir, 'mcp');
}

function ownerOnlyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  // mkdir's mode is masked by the umask, and an existing folder keeps its own.
  if (process.platform !== 'win32') fs.chmodSync(dir, OWNER_ONLY_DIR);
}

export interface McpServerParts {
  endpointFor(core: McpCore): McpEndpoint;
  /** Undoes the change behind an audit entry. */
  restore(entry: McpAuditEntry): Promise<SimpleResult>;
}

export function createMcp(wiring: McpWiring, server: McpServerParts): McpParts {
  const home = mcpHome(wiring.appHome);
  ownerOnlyDir(home);
  const auditPath = path.join(home, AUDIT_FILE);

  const clients = createClientStore({
    read: () => wiring.configStore.getMcpClients(),
    write: (records) => wiring.configStore.saveMcpClients(records),
    now: () => Date.now(),
    newId: () => randomUUID(),
    ...timers,
  });
  const audit = createAuditLog({
    load: () => {
      try {
        return fs.readFileSync(auditPath, 'utf8');
      } catch {
        return null;
      }
    },
    append: (line) =>
      fs.appendFileSync(auditPath, line, { mode: OWNER_ONLY_FILE }),
    rewrite: (content) =>
      fs.writeFileSync(auditPath, content, { mode: OWNER_ONLY_FILE }),
    now: () => Date.now(),
    newId: () => randomUUID(),
    retentionDays: () =>
      wiring.configStore.getGlobalSettings().mcp.auditRetentionDays,
    published: (entry) => wiring.send('mcp:audit', entry),
    refreshed: () => wiring.send('mcp:auditRefresh', null),
  });
  const desk = createConfirmDesk({
    now: () => Date.now(),
    newId: () => randomUUID(),
    ...timers,
    requested: (request) => {
      wiring.send('mcp:confirmRequest', request);
      wiring.showConfirmations();
    },
    closed: (closed) => wiring.send('mcp:confirmClosed', closed),
  });
  const control = createMcpControl({
    settings: {
      get: () => wiring.configStore.getGlobalSettings().mcp,
      save: (mcp) =>
        wiring.sendSettings(wiring.configStore.saveMcpSettings(mcp)),
    },
    clients,
    audit,
    tools: MCP_TOOLS,
    desk,
    endpoint: server.endpointFor({ clients, audit, desk, home }),
    connectCommand: () =>
      connectCommands({
        platform: wiring.platform,
        execPath: wiring.execPath,
        cliPath: path.join(wiring.mainDir, 'mcp', 'cli.js'),
        home,
      }),
    restore: (entry) => server.restore(entry),
    changed: (state) => wiring.send('mcp:update', state),
  });
  return { control, clients, audit, desk, home };
}

/** What main.ts already has at hand. */
interface McpAppWiring extends McpRuntimeWiring {
  configStore: McpWiring['configStore'] &
    McpRuntimeWiring['configStore'] &
    ConfigPortWiring['configStore'];
  host: { appVersion(): string; applyAutostart(enabled: boolean): void };
  processManager: McpRuntimeWiring['processManager'] &
    ConfigPortWiring['processManager'];
  workflowRunner: McpRuntimeWiring['workflowRunner'] &
    ConfigPortWiring['workflowRunner'];
  syncRepoWatchers(): void;
  appWindows: {
    ensureConfigWindow(options?: { goto?: string; urgent?: boolean }): void;
  };
}

/** The MCP control surface, plus the tap its config tools write through. */
export type McpApp = McpControl & {
  /** Wraps `ipcMain` so the MCP tools can call the same handlers. */
  tapIpc(ipc: IpcRegistrar): IpcRegistrar;
};

/** The MCP server over the real disk, store, windows and runtime. */
export function mcpFor(app: McpAppWiring): McpApp {
  const home = mcpHome(appHome());
  const tap = createIpcTap();
  const runtime = mcpRuntime(app);
  const changes = createConfigChanges(
    electronConfigPort({
      ...app,
      home,
      invoke: tap.invoke,
      applyAutostart: (enabled) => app.host.applyAutostart(enabled),
    }),
  );
  const parts = createMcp(
    {
      appHome: appHome(),
      // This file is build/src/main/mcp/mcp-wiring.js; the main dir is build/src.
      mainDir: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
      ),
      execPath: process.execPath,
      platform: process.platform,
      configStore: app.configStore,
      send: (channel, payload) =>
        sendToRenderers(app.registry, channel, payload),
      sendSettings: settingsPushes(app.registry).sendSettings,
      showConfirmations: () =>
        app.appWindows.ensureConfigWindow({ goto: 'mcp', urgent: true }),
    },
    {
      endpointFor: (core) =>
        localEndpoint({ ...core, changes }, runtime, app.host.appVersion()),
      restore: (entry) =>
        entry.undoToken
          ? changes.restore(entry.undoToken)
          : Promise.resolve({
              ok: false,
              error: 'Ese cambio no se puede deshacer',
            }),
    },
  );
  return Object.assign(parts.control, { tapIpc: tap.tap });
}

/** «Control remoto»'s close, with the MCP endpoint closing alongside. */
export function withMcpShutdown(
  remote: { close(): void },
  control: Pick<McpControl, 'shutdown'>,
): { close(): void } {
  return {
    close: () => {
      remote.close();
      void control.shutdown();
    },
  };
}
