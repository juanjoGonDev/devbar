import { describe, it, expect } from 'vitest';
import {
  canRun,
  dotClass,
  groupDotClass,
  isRunning,
  runtimeOf,
} from '../renderer/log-status.js';
import type { LogListItem } from '../src/ipc-contract.js';

function item(patch: Partial<LogListItem> = {}): LogListItem {
  return {
    id: 'cmd:g1:c1',
    type: 'command',
    name: 'dev',
    icon: null,
    lineCount: 0,
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    startedAt: null,
    lastFinishedAt: null,
    logLimit: 10_000,
    ...patch,
  };
}

describe('isRunning / canRun', () => {
  it('treats running and starting as running', () => {
    expect(isRunning(item({ status: 'running' }))).toBe(true);
    expect(isRunning(item({ status: 'starting' }))).toBe(true);
    expect(isRunning(item({ status: 'stopping' }))).toBe(false);
    expect(isRunning(item({ status: 'stopped' }))).toBe(false);
    expect(isRunning(null)).toBe(false);
  });

  it('only lets commands and actions be launched', () => {
    expect(canRun(item({ type: 'command' }))).toBe(true);
    expect(canRun(item({ type: 'action' }))).toBe(true);
    expect(canRun(item({ type: 'prescript' }))).toBe(false);
    expect(canRun(item({ type: 'pipeline' }))).toBe(false);
    expect(canRun(null)).toBe(false);
  });
});

describe('dotClass', () => {
  it('is empty while stopped, whatever the counters say', () => {
    expect(dotClass(item({ status: 'stopped', errorCount: 3 }))).toBe('');
  });

  it('shows transitions in their own colour', () => {
    expect(dotClass(item({ status: 'starting' }))).toBe('starting');
    expect(dotClass(item({ status: 'stopping' }))).toBe('stopping');
  });

  it('ranks errors over warnings over plain running', () => {
    expect(dotClass(item({ status: 'running' }))).toBe('running');
    expect(dotClass(item({ status: 'running', warnCount: 2 }))).toBe('warn');
    expect(
      dotClass(item({ status: 'running', warnCount: 2, errorCount: 1 })),
    ).toBe('error');
  });
});

describe('runtimeOf', () => {
  it('ticks while running', () => {
    const r = runtimeOf(item({ status: 'running', startedAt: 1000 }), 91_000);
    expect(r).toEqual({ text: '1m 30s', live: true });
  });

  it('freezes the last run once stopped', () => {
    const r = runtimeOf(
      item({ status: 'stopped', startedAt: 1000, lastFinishedAt: 31_000 }),
      999_999,
    );
    expect(r).toEqual({ text: '30s', live: false });
  });

  it('has nothing to show for something that never ran', () => {
    expect(runtimeOf(item(), 1000)).toBeNull();
    expect(runtimeOf(null, 1000)).toBeNull();
  });

  it('ignores a finish timestamp left over from an earlier run', () => {
    expect(
      runtimeOf(
        item({ status: 'stopped', startedAt: 50_000, lastFinishedAt: 10_000 }),
        99_000,
      ),
    ).toBeNull();
  });
});

describe('groupDotClass', () => {
  it('is empty when nothing in the group is running', () => {
    expect(groupDotClass([item(), item({ status: 'stopped' })])).toBe('');
  });

  it('reports running when a member is up and clean', () => {
    expect(groupDotClass([item(), item({ status: 'running' })])).toBe(
      'running',
    );
  });

  it('lets an error outrank warnings and healthy members', () => {
    expect(
      groupDotClass([
        item({ status: 'running' }),
        item({ status: 'running', warnCount: 3 }),
        item({ status: 'running', errorCount: 1 }),
      ]),
    ).toBe('error');
  });

  it('lets a warning outrank a healthy member regardless of order', () => {
    expect(
      groupDotClass([
        item({ status: 'running', warnCount: 2 }),
        item({ status: 'running' }),
      ]),
    ).toBe('warn');
  });

  it('falls back to a transitional state when nothing louder is present', () => {
    expect(groupDotClass([item(), item({ status: 'starting' })])).toBe(
      'starting',
    );
  });

  it('handles an empty group', () => {
    expect(groupDotClass([])).toBe('');
  });
});
