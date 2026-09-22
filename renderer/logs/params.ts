/**
 * What the window was opened FOR, read out of its own query string.
 *
 * Main encodes the entry point in the URL — a detached window, a pre-filled
 * search, a merged scope, a level pin — and the bootstrap has to act on it
 * before anything is drawn. Parsing it here keeps that decision testable
 * without a window: hand it a query string, get back the intent.
 */
import type { SilenceLevel } from '../../src/ipc-contract.js';
import type { Scope } from './view.js';

export interface LogsParams {
  /** A detached window shows a single log and hides the sidebar. */
  isDetached: boolean;
  /** Pre-set filter (e.g. from a counter-button click); '' when absent. */
  filter: string;
  /** Opened straight onto a merged scope; null for the plain single view. */
  scope: Scope | null;
  /** The level chip to pin, for severity entry points. */
  level: SilenceLevel | null;
  /** The single service to show, when the window was opened on one. */
  processId: string | null;
}

/**
 * This window's own query string, parsed once at load. Read it from here
 * rather than re-parsing `location`: every pane then agrees on what the
 * window was opened for, and the parsing itself stays a pure function a test
 * can call with a string.
 */
export const logsParams: LogsParams = readLogsParams(location.search);

export function readLogsParams(search: string): LogsParams {
  const params = new URLSearchParams(search);
  const rawScope = params.get('scope');
  const rawGroupId = params.get('groupId');
  const rawLevel = params.get('level');
  return {
    isDetached: params.get('detached') === '1',
    filter: params.get('filter') || '',
    scope:
      rawScope === 'group' && rawGroupId
        ? { kind: 'group', groupId: rawGroupId }
        : rawScope === 'all'
          ? { kind: 'all' }
          : null,
    level: rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : null,
    processId: params.get('id'),
  };
}
