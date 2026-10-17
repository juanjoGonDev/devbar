import type { ProcessStatus, WorkflowRunResult } from '../domain-types.js';

/**
 * What the «Control remoto» server sends a linked phone, over /api/* and the
 * /api/events stream. Types only: src/main/remote builds these from the live
 * state, renderer/remote narrows every answer back into them.
 *
 * Each view is built field by field from a whitelist, never by spreading a
 * config object, so nothing the phone has no use for — env entries above all,
 * but also paths and regexes — can ride along by accident.
 */

/** The four colours of a status dot, as the tray paints them. */
export type RemoteDot = 'stopped' | 'running' | 'warn' | 'error';

/** A pending «¿Ejecutar …?» confirmation, answerable from any surface. */
export interface RemoteConfirmView {
  token: string;
  name: string;
  /** The command line the confirmation is about. */
  command: string;
  groupName: string | null;
  secs: number | null;
  /** What main does by itself when the countdown runs out. */
  onTimeout: 'confirm' | 'cancel';
  /** Epoch ms when main answers `onTimeout` itself; null waits forever. */
  deadline: number | null;
}

export interface RemoteCommandView {
  id: string;
  processId: string;
  name: string;
  status: ProcessStatus;
  color: RemoteDot;
  warnCount: number;
  errorCount: number;
  lastError: string | null;
  startedAt: number | null;
}

export interface RemoteActionView {
  id: string;
  processId: string;
  name: string;
  status: ProcessStatus | 'idle';
  lastExitCode: number | null;
  startedAt: number | null;
}

export interface RemoteGroupView {
  id: string;
  name: string;
  color: RemoteDot;
  /** The checked-out branch, or null when the group is not a git repo. */
  branch: string | null;
  lastError: string | null;
  commands: RemoteCommandView[];
  actions: RemoteActionView[];
}

/**
 * A workflow the phone may run and stop: the startup one, and every enabled
 * manual one with «Mostrar en el móvil». Never its graph or its scripts.
 */
export interface RemoteWorkflowView {
  id: string;
  name: string;
  startup: boolean;
  running: boolean;
  /** Settled scripts of the run in flight; null when it is not running. */
  doneScripts: number | null;
  /** The run's scripts, or the workflow's runnable ones when idle. */
  totalScripts: number;
  lastResult: WorkflowRunResult | null;
  lastFinishedAt: number | null;
}

/**
 * Where the update stands, from the phone's point of view: `ready` is the
 * only state it may act on (a staged update installs with a restart and no
 * dialog); `manual` exists but has to be installed from the computer.
 */
export interface RemoteUpdateView {
  currentVersion: string;
  state: 'current' | 'ready' | 'manual' | 'busy' | 'restarting';
  version: string | null;
}

export interface RemoteStateView {
  /** Main's clock when this was taken: countdowns and uptimes start here. */
  now: number;
  host: { name: string; version: string };
  groups: RemoteGroupView[];
  workflows: RemoteWorkflowView[];
  update: RemoteUpdateView;
  confirms: RemoteConfirmView[];
}

export type RemoteNoticeKind =
  'error' | 'success' | 'scheduled' | 'update' | 'info';

/** One entry of the in-memory notice log (the last 50). */
export interface RemoteNotice {
  id: number;
  ts: number;
  kind: RemoteNoticeKind;
  title: string;
  body: string;
}

/** A log line with its ANSI escapes already stripped. */
export interface RemoteLogLine {
  seq: number;
  ts: number;
  level: 'warn' | 'error' | null;
  line: string;
}

/** The only global settings a phone may read and change. */
export interface RemoteSettingsView {
  autostart: boolean;
  notifySuccess: boolean;
  silenceWarnings: boolean;
  silenceErrors: boolean;
}
