import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHome } from '../../app-paths.js';
import type { GlobalSettings } from '../../domain-types.js';
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
import {
  mcpRuntime,
  type McpRuntime,
  type McpRuntimeWiring,
} from './runtime.js';
import { createSession, type Session } from './session.js';
import { createSocketEndpoint } from './socket-endpoint.js';
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
    saveGlobalSettings(patch: Partial<GlobalSettings>): GlobalSettings;
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
type McpCore = Omit<McpParts, 'control'>;

function ownerOnlyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  // mkdir's mode is masked by the umask, and an existing folder keeps its own.
  if (process.platform !== 'win32') fs.chmodSync(dir, OWNER_ONLY_DIR);
}

export function createMcp(
  wiring: McpWiring,
  endpointFor: (core: McpCore) => McpEndpoint,
): McpParts {
  const home = path.join(wiring.appHome, 'mcp');
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
    published: (entry) => wiring.send('mcp:audit', entry),
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
        wiring.sendSettings(wiring.configStore.saveGlobalSettings({ mcp })),
    },
    clients,
    audit,
    desk,
    endpoint: endpointFor({ clients, audit, desk, home }),
    connectCommand: () =>
      connectCommands({
        platform: wiring.platform,
        execPath: wiring.execPath,
        cliPath: path.join(wiring.mainDir, 'mcp', 'cli.js'),
        home,
      }),
    restore: () =>
      Promise.resolve({
        ok: false,
        error: 'Ese cambio ya no se puede deshacer',
      }),
    changed: (state) => wiring.send('mcp:update', state),
  });
  return { control, clients, audit, desk, home };
}

/** The real local endpoint: the socket (or pipe) and a session per assistant. */
export function localEndpoint(
  core: McpCore,
  runtime: McpRuntime,
  version: string,
): McpEndpoint {
  const firstApprovals = new Set<string>();
  const sessions = new Set<Session>();
  const endpoint = createSocketEndpoint({
    home: core.home,
    platform: process.platform,
    createServer: (onConnection) => net.createServer(onConnection),
    probe: (socketPath) =>
      new Promise((resolve) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      }),
    writeToken: (tokenPath, token) =>
      fs.writeFileSync(tokenPath, token, { mode: OWNER_ONLY_FILE }),
    removeSocket: (socketPath) => fs.rmSync(socketPath, { force: true }),
    restrictSocket: (socketPath) => fs.chmodSync(socketPath, OWNER_ONLY_FILE),
    newToken: () => randomBytes(32).toString('base64url'),
    ...timers,
    session: (transport) => {
      const session = createSession(transport, {
        ...core,
        runtime,
        tools: MCP_TOOLS,
        version,
        firstApprovals,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        setTimer: timers.setTimer,
      });
      sessions.add(session);
      session.server.server.onclose = () => {
        sessions.delete(session);
        void session.close();
      };
    },
  });
  return {
    ...endpoint,
    stop: async () => {
      // An open session would otherwise keep answering until it hangs up.
      await Promise.all([...sessions].map((session) => session.close()));
      sessions.clear();
      await endpoint.stop();
    },
  };
}

/** What main.ts already has at hand. */
interface McpAppWiring extends McpRuntimeWiring {
  configStore: McpWiring['configStore'] & McpRuntimeWiring['configStore'];
  host: { appVersion(): string };
  appWindows: { ensureConfigWindow(options?: { goto?: string }): void };
}

/** The MCP server over the real disk, store, windows and runtime. */
export function mcpFor(app: McpAppWiring): McpControl {
  const runtime = mcpRuntime(app);
  return createMcp(
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
        app.appWindows.ensureConfigWindow({ goto: 'mcp' }),
    },
    (core) => localEndpoint(core, runtime, app.host.appVersion()),
  ).control;
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
