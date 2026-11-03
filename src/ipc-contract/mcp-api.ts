import type { McpSettings } from '../domain-types.js';
import type { SimpleResult } from './simple-result.js';

/**
 * The MCP server of DevBar as the settings window sees it: the switch, the AI
 * assistants that asked to connect (each with its own permissions), the
 * confirmations a risky call waits on and the audit log of everything they
 * did. Every decision lives in main (src/main/mcp); the window only paints
 * these views and answers with the calls of `McpApi`.
 */

/** Which assistant a client is, guessed from its MCP `clientInfo`. */
export type McpClientKind =
  'claude-code' | 'claude-desktop' | 'cursor' | 'opencode' | 'codex' | 'other';

/**
 * `pending` until the user lets it in from Settings › MCP (it only sees a
 * tool that says so); `revoked` after «Rechazar» or «Revocar acceso», which
 * keeps it out until it is approved again.
 */
export type McpClientStatus = 'pending' | 'allowed' | 'revoked';

/** What a client may do, one switch per family of tools. */
export interface McpScopes {
  /** Status, ports, logs and log search. */
  read: boolean;
  /** Start, stop and restart commands; run actions; wait for a port. */
  control: boolean;
  /** Run and stop workflows. */
  workflows: boolean;
  /** Create, edit and delete everything; import, export and undo. */
  config: boolean;
}

/**
 * When a call waits for the user's OK in DevBar: `first` asks once per
 * client and target (per app session), `always` every time.
 */
export type McpConfirmPolicy = 'never' | 'first' | 'always';

export interface McpConfirmPolicies {
  control: McpConfirmPolicy;
  workflows: McpConfirmPolicy;
  /** Fixed: every configuration change is confirmed with its diff. */
  config: 'always';
}

export interface McpClient {
  id: string;
  /** What Settings shows («Claude Code»); the user may rename it. */
  name: string;
  kind?: McpClientKind;
  status: McpClientStatus;
  /** Epoch ms of its first connection. */
  createdAt: number;
  lastUsedAt: number | null;
  /** Tool calls since local midnight. */
  callsToday: number;
  scopes: McpScopes;
  confirm: McpConfirmPolicies;
  /** The groups it can see and touch: every one, or these ids. */
  groups: 'all' | string[];
  /** Mask env values and obvious secrets in what it reads. */
  redactSecrets: boolean;
}

/** The editable part of a client (`updateMcpClient`). */
export interface McpClientPatch {
  name?: string;
  scopes?: Partial<McpScopes>;
  confirm?: Partial<Pick<McpConfirmPolicies, 'control' | 'workflows'>>;
  groups?: 'all' | string[];
  redactSecrets?: boolean;
}

/** One line of a human diff: unchanged context, a removal or an addition. */
export interface McpDiffLine {
  kind: 'ctx' | 'del' | 'add';
  /** The field in Spanish, as Settings names it («comando», «entorno»…). */
  field: string;
  text: string;
}

export type McpAuditResult =
  'ok' | 'warning' | 'error' | 'rejected' | 'pending';

/** One tool call, kept for 30 days. Log contents are never stored. */
export interface McpAuditEntry {
  id: string;
  /** Epoch ms. */
  at: number;
  clientId: string;
  clientName: string;
  /** The MCP tool name (`update_command`, `restart`…). */
  tool: string;
  /** What it touched, in words («Back › Normal»). */
  target: string;
  result: McpAuditResult;
  /** One line about the outcome («12 líneas», «:4400, :6006»). */
  summary: string;
  /** Configuration changes: what changed (secrets masked). */
  diff?: McpDiffLine[];
  /** Present while the change can still be undone (`undoMcpChange`). */
  undoToken?: string;
}

export type McpAuditFilter = 'all' | 'changes' | 'rejected';

export interface McpAuditQuery {
  clientId?: string;
  filter?: McpAuditFilter;
  /** Newest first, at most this many (1–500). */
  limit: number;
}

/**
 * What a confirmation is about: `executes` changes what runs on this computer
 * (a command line, env, folder, an import, a start), `destructive` deletes,
 * `cosmetic` only touches names, icons or colours.
 */
export type McpRisk = 'executes' | 'cosmetic' | 'destructive';

/** A call waiting for the user: shown by the confirmation dialog. */
export interface McpConfirmRequest {
  id: string;
  clientName: string;
  /** «Claude Code quiere cambiar un comando». */
  title: string;
  /** «Grupo Back · comando Normal». */
  subtitle: string;
  risk: McpRisk;
  diff: McpDiffLine[];
  /** Why, in the assistant's own words, when it said. */
  reason?: string;
  /** Epoch ms: unanswered by then, it is rejected. */
  expiresAt: number;
}

export type McpConfirmAnswer = 'apply' | 'reject';

/** How a confirmation ended, pushed so the dialog can close. */
export interface McpConfirmClosed {
  id: string;
  outcome: 'applied' | 'rejected' | 'expired' | 'cancelled';
}

/** The ready-to-paste ways of connecting an assistant to this install. */
export interface McpConnectCommands {
  /** `claude mcp add …`, for a terminal. */
  claudeCode: string;
  /** The `mcpServers` block for claude_desktop_config.json. */
  claudeDesktopJson: string;
  /** The `mcpServers` block for ~/.cursor/mcp.json. */
  cursorJson: string;
  /** The `mcp` block for opencode.json. */
  opencodeJson: string;
  /** The `[mcp_servers.devbar]` table for ~/.codex/config.toml. */
  codexToml: string;
  /** The bare command line, for any other stdio client. */
  generic: string;
}

/** Everything Settings › MCP paints. */
export interface McpState {
  settings: McpSettings;
  clients: McpClient[];
  connectCommand: McpConnectCommands;
  /** The local endpoint is up and accepting assistants. */
  listening: boolean;
  /** Why it could not start, in Spanish; null when fine. */
  error: string | null;
}

export type McpMutationResult =
  { ok: true; state: McpState } | { ok: false; error: string };

/** The MCP calls of the window API (part of `DevBarApi`). */
export interface McpApi {
  getMcpState(): Promise<McpState>;
  /** Persists the switch and starts/stops the local endpoint. */
  setMcpEnabled(enabled: boolean): Promise<McpState>;
  /** Lets a pending (or revoked) client in, with these scopes on the defaults. */
  approveMcpClient(
    id: string,
    scopes?: Partial<McpScopes>,
  ): Promise<McpMutationResult>;
  /** Turns a pending client away: it stays revoked until approved. */
  rejectMcpClient(id: string): Promise<McpMutationResult>;
  updateMcpClient(
    id: string,
    patch: McpClientPatch,
  ): Promise<McpMutationResult>;
  /** Cuts an allowed client off; its open sessions lose every tool. */
  revokeMcpClient(id: string): Promise<McpMutationResult>;
  listMcpAudit(query: McpAuditQuery): Promise<McpAuditEntry[]>;
  /** Restores what a configuration change replaced. */
  undoMcpChange(undoToken: string): Promise<SimpleResult>;
  answerMcpConfirm(id: string, answer: McpConfirmAnswer): Promise<SimpleResult>;
  /** The confirmations still waiting — for a window that opens late. */
  listMcpConfirms(): Promise<McpConfirmRequest[]>;
  onMcpUpdate(callback: (state: McpState) => void): () => void;
  onMcpConfirmRequest(
    callback: (request: McpConfirmRequest) => void,
  ): () => void;
  onMcpConfirmClosed(callback: (closed: McpConfirmClosed) => void): () => void;
  /** Every new audit entry, as it is recorded. */
  onMcpAudit(callback: (entry: McpAuditEntry) => void): () => void;
}
