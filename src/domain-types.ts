export interface EnvEntry {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ScheduleRule {
  time: string;
  days: number[];
}

export interface Schedule {
  enabled: boolean;
  rules: ScheduleRule[];
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

export interface Command extends ConfirmConfig {
  id: string;
  name: string;
  icon: string | null;
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
}

export interface Action extends ConfirmConfig {
  id: string;
  name: string;
  icon: string | null;
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

export interface PreStep {
  id: string;
  mode: 'parallel' | 'serial';
  scripts: PreScript[];
}

export interface Group {
  id: string;
  name: string;
  icon: string;
  path: string;
  mode: 'single' | 'multi';
  order: number;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  env: EnvEntry[];
  commands: Command[];
  actions: Action[];
  preSteps: PreStep[];
  preScriptsAutoRun: boolean;
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

export interface GlobalSettings {
  autostart: boolean;
  silenceWarnings: boolean;
  silenceErrors: boolean;
  maxLogLines: number;
  notifySuccess: boolean;
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
  dmgUrl: string | null;
  zipUrl: string | null;
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
