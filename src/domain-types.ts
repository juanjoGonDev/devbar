export interface EnvEntry {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ScheduleRule {
  time: string;
  days: number[];
}

/**
 * When a command or action runs on its own. `interval !== null` means the
 * «Cada…» mode (the rules are kept, but ignored, so switching back restores
 * them); otherwise the weekday + time rules decide.
 */
export interface Schedule {
  enabled: boolean;
  rules: ScheduleRule[];
  interval: ScheduleInterval | null;
}

type ConfirmOnTimeout = 'confirm' | 'cancel';

export interface ConfirmConfig {
  confirm: boolean;
  confirmSecs: number | null;
  confirmOnTimeout: ConfirmOnTimeout;
}

export interface SilencedPatterns {
  warn: string[];
  error: string[];
}

export type DetectedPortKind = 'web' | 'http' | 'other';

/**
 * A TCP port a running command listens on, as main detected it (from its log
 * or from the OS socket table) and classified it with an HTTP probe.
 */
export interface DetectedPort {
  port: number;
  /** Where to open it, e.g. `http://localhost:5173/`. */
  url: string;
  kind: DetectedPortKind;
  source: 'log' | 'socket';
  /** The dev tool that announced it («Vite», «Storybook»), when known. */
  label?: string;
  /** Bound beyond loopback (`*`, `0.0.0.0`, the LAN address): a phone can reach it. */
  lanReachable: boolean;
}

/**
 * What «abrir» does for a command: `auto` opens its primary detected web port
 * (plus `path`), `custom` opens `url`, `none` shows no link at all.
 */
export interface CommandLink {
  mode: 'auto' | 'custom' | 'none';
  path?: string;
  url?: string;
}

export interface Command extends ConfirmConfig {
  id: string;
  name: string;
  icon: string | null;
  /** `#rrggbb`, or null to inherit the text colour (see icon-color.ts). */
  iconColor: string | null;
  command: string;
  args: string[];
  env: EnvEntry[];
  cwd: string | null;
  warnRegex: string;
  errorRegex: string;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  silencedPatterns: SilencedPatterns;
  autoStart: boolean;
  schedule: Schedule;
  maxLogLines: number | null;
  /** Absent in old stores and backups; the normaliser fills `{ mode: 'auto' }`. */
  link?: CommandLink;
}

export interface Action extends ConfirmConfig {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
  command: string;
  args: string[];
  env: EnvEntry[];
  inheritGroupEnv: boolean;
  schedule: Schedule;
}

export interface PreScript extends ConfirmConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: EnvEntry[];
  inheritGroupEnv: boolean;
  timeoutMs: number | null;
}

/** A pipeline's reference to a script defined in its OWN group's `preScripts`. */
export interface PreStepScriptRef {
  groupId: string;
  scriptId: string;
}

/**
 * LEGACY: the pipeline before it became a graph — an ordered list of steps.
 * Only read to migrate old stores and old backup files into a `Pipeline`
 * (see `fromLegacySteps` in src/pipeline-graph.ts); never written any more.
 */
export interface PreStep {
  id: string;
  mode: 'parallel' | 'serial';
  scripts: PreStepScriptRef[];
}

/**
 * A unit on the pipeline canvas: one script is a single node, two or more a
 * parallel frame. Its scripts all start together and the block finishes when
 * every one of them has. `x`/`y` are canvas coordinates (see `PIPELINE_GRID`).
 */
export interface PipelineBlock {
  id: string;
  scripts: PreStepScriptRef[];
  x: number;
  y: number;
  /**
   * «Todos OK» (default true): one failing script cancels its still-running
   * siblings and fails the block, so its descendants are skipped. When false
   * the siblings keep running and the block counts as finished for what
   * comes after it, even if some failed — the run then ends «con avisos».
   * Irrelevant for a single-script block.
   */
  requireAll: boolean;
}

/**
 * `to` waits for `from`. `from` is a block id or the literal `'trigger'`
 * (`PIPELINE_TRIGGER`), which completes the instant the pipeline starts.
 */
export interface PipelineEdge {
  from: string;
  to: string;
}

/**
 * One workflow's pre-script graph as a DAG (n8n style). A block starts once EVERY
 * source of its incoming edges finished successfully; a block with no
 * incoming edge is disconnected and never runs. Each script appears in at most
 * one block, and the edges never form a cycle. src/pipeline-graph.ts holds
 * every rule; this is only the shape.
 */
export interface Pipeline {
  blocks: PipelineBlock[];
  edges: PipelineEdge[];
}

/** A daily time window, `'HH:MM'` local; `to <= from` crosses midnight. */
export interface ScheduleWindow {
  from: string;
  to: string;
}

/**
 * «Cada N minutos/horas/días». Runs are anchored to the start of `window`
 * (or to midnight) and step `every` units from there; src/schedule-plan.ts
 * holds every rule.
 */
export interface ScheduleInterval {
  /** >= 1. */
  every: number;
  unit: 'minutes' | 'hours' | 'days';
  /** Only fire inside it; null = all day. */
  window: ScheduleWindow | null;
  /** 0=Sun..6=Sat; [] = every day. */
  days: number[];
}

/**
 * When a scheduled workflow runs: the same weekday + time rules commands and
 * actions use (`ScheduleRule`), or a fixed interval (`interval !== null`
 * means the «Cada…» mode, exactly as in `Schedule`). Whether it is
 * armed at all is the workflow's own `enabled`, so there is no flag here.
 */
export interface WorkflowSchedule {
  rules: ScheduleRule[];
  interval: ScheduleInterval | null;
}

export type WorkflowTrigger =
  | { kind: 'startup' }
  | { kind: 'schedule'; schedule: WorkflowSchedule }
  | {
      kind: 'manual';
      /** Ask before running (the same confirmation dialog scripts use). */
      confirm: boolean;
    };

/**
 * A named pre-script graph with its own trigger. At most one workflow has the
 * `startup` trigger (it is what DevBar runs at login, and what
 * `Group.waitForPipeline` groups wait for). A script appears at most once in
 * a workflow, but may appear in several. src/workflows.ts holds every rule.
 */
export interface Workflow {
  id: string;
  name: string;
  /** Arms the automatic triggers (startup, schedule) and the tray entry. */
  enabled: boolean;
  /**
   * Hidden from the tray and a linked phone, like `Group.hiddenInTray`: listed
   * only behind their «N oculto(s)» fold (`showHiddenWorkflowsFold`), or not
   * at all. A running workflow is listed whatever this says.
   */
  hidden: boolean;
  trigger: WorkflowTrigger;
  graph: Pipeline;
}

export type WorkflowRunResult = 'success' | 'warning' | 'error' | 'cancelled';

/** The last finished run of one workflow, persisted (`workflowRuns`). */
export interface WorkflowRunRecord {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  result: WorkflowRunResult;
}

export interface Group {
  id: string;
  name: string;
  /** A Lucide icon name, or `img:<id>` for an uploaded image (CustomIcon). */
  icon: string;
  iconColor: string | null;
  path: string;
  mode: 'single' | 'multi';
  order: number;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  env: EnvEntry[];
  commands: Command[];
  actions: Action[];
  preScripts: PreScript[];
  /**
   * Whether this group's `autoStart` commands must wait for the ENTIRE
   * startup workflow («workflow de arranque») to finish successfully before releasing, instead of releasing
   * as soon as every block holding one of its scripts completes. Defaults
   * to `true` (wait): releasing early fails silently — the group looks
   * started but another, unrelated block (e.g. a different group's `make
   * setup` restarting Docker) can still break it — while waiting only fails
   * by making boot slower, which is visible and self-explanatory.
   */
  waitForPipeline: boolean;
  /**
   * Folded into the tray's «N oculto(s)» disclosure instead of listed. Only
   * presentation: the group's processes keep running as usual.
   */
  hiddenInTray: boolean;
}

/**
 * An image the user uploaded as an icon: a PNG, at most 64 px on its longest
 * side, stored inline as a data URL. Referenced from an icon field as
 * `img:<id>`; the id is a hash of the uploaded file, so uploading the same
 * file twice yields one icon.
 */
export interface CustomIcon {
  id: string;
  name: string;
  dataUrl: string;
}

export interface LegacyService {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  gitRepo: string;
  warnRegex: string;
  errorRegex: string;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  silencedPatterns: SilencedPatterns;
}

/**
 * Default log retention, shared by the store and the settings UI. Lives here
 * because this module has no imports: the renderer can read it without pulling
 * electron-store in through config-store.
 */
export const DEFAULT_MAX_LOG_LINES = 10_000;

export type ThemePreference = 'auto' | 'light' | 'dark';

/** How AI assistants reach the MCP server: only local stdio for now. */
export type McpTransport = 'stdio';

/** The MCP server switch (see src/main/mcp). Off until the user turns it on. */
export interface McpSettings {
  enabled: boolean;
  transport: McpTransport;
  /** How many days «Actividad» keeps an entry (1–365). */
  auditRetentionDays: number;
}

export interface GlobalSettings {
  autostart: boolean;
  /** UI theme: follow the OS (auto) or force light/dark. */
  theme: ThemePreference;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  maxLogLines: number;
  notifySuccess: boolean;
  /**
   * Whether the tray (and a linked phone) lists the groups hidden from it
   * behind the «N oculto(s)» fold; off, they are not listed anywhere there.
   */
  showHiddenGroupsFold: boolean;
  /** The same fold for the workflows hidden from the tray and the phone. */
  showHiddenWorkflowsFold: boolean;
  /** The MCP server for AI assistants; changed only by `setMcpEnabled`. */
  mcp: McpSettings;
}

export type ProcessStatus =
  'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'done';

export type LogLevel = 'warn' | 'error';
export interface LogEntry {
  ts: number;
  /**
   * Position in its buffer's own monotonic count, stamped by `pushLog`. The
   * only thing that can tell a snapshot and the live stream apart: timestamps
   * cannot, because a burst shares a millisecond.
   */
  seq?: number;
  stream: 'stdout' | 'stderr' | 'sys';
  level: LogLevel | null;
  originalLevel?: LogLevel | null;
  silenced?: boolean;
  line: string;
}

export interface ProcessState {
  id: string;
  status: ProcessStatus;
  warnCount: number;
  errorCount: number;
  lastError: string | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastFinishedAt: number | null;
}

export interface AvailableUpdate {
  version: string;
  url: string;
  /** macOS drag-install image. */
  dmgUrl: string | null;
  /** macOS portable zip, or the Windows portable self-extracting exe. */
  zipUrl: string | null;
  /** Windows NSIS installer. */
  setupUrl: string | null;
  /** Linux AppImage. */
  appImageUrl: string | null;
  /** Linux .deb package. */
  debUrl: string | null;
}

/** A release already downloaded and unpacked, waiting for a restart. */
export interface StagedUpdate {
  version: string;
  /** Extracted `DevBar.app` that will replace the installed bundle. */
  appPath: string;
}

export interface ReleaseSummary {
  version: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
}
