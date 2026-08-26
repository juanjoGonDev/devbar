import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { normalizeGroup } from '../src/groups-model.js';
import { makeCommandId } from '../src/compound-id.js';
import type { GlobalSettings, Group } from '../src/domain-types.js';

/**
 * Retention is frozen when a process starts, so config edited afterwards does
 * not apply to it. Anything mirroring the buffer — the log viewer holds its own
 * copy — has to ask ProcessManager rather than recompute from settings, or it
 * keeps offering lines the buffer has already dropped.
 */

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => true;
    return child;
  },
}));

const { ProcessManager } = await import('../src/process-manager.js');

const CMD_ID = makeCommandId('g1', 'c1');

function group(maxLogLines?: number): Group {
  return normalizeGroup({
    id: 'g1',
    name: 'G',
    path: '/tmp',
    env: [],
    commands: [
      { id: 'c1', name: 'Dev', command: 'true', env: [], maxLogLines },
    ],
    actions: [],
    preSteps: [],
  });
}

let current: Group;
let settings: GlobalSettings;

function manager(): InstanceType<typeof ProcessManager> {
  return new ProcessManager({
    getGroup: (id: string) => (id === 'g1' ? current : null),
    listGroups: () => [current],
    getGlobalSettings: () => settings,
  });
}

function push(pm: InstanceType<typeof ProcessManager>, count: number): void {
  for (let i = 0; i < count; i += 1)
    pm.pushLog(CMD_ID, { ts: i, stream: 'stdout', level: null, line: `l${i}` });
}

beforeEach(() => {
  current = group(100);
  settings = { maxLogLines: 10_000 } as GlobalSettings;
});

describe('getLogLimit', () => {
  it('prefers a command override over the global setting', () => {
    expect(manager().getLogLimit(CMD_ID)).toBe(100);
  });

  it('falls back to the global setting without an override', () => {
    current = group();
    expect(manager().getLogLimit(CMD_ID)).toBe(10_000);
  });

  it('reports the global default for an id that resolves to nothing', () => {
    expect(manager().getLogLimit('cmd:nope:nope')).toBe(2000);
  });

  it('keeps the limit a running process started with when config changes', () => {
    const pm = manager();
    pm.start(CMD_ID);
    expect(pm.getLogLimit(CMD_ID)).toBe(100);

    current = group(10_000); // raised while it runs, without a restart
    expect(pm.getLogLimit(CMD_ID)).toBe(100);
  });
});

describe('a new run starts from an empty buffer', () => {
  it("drops the previous run's lines, so a viewer holding them is stale", () => {
    const pm = manager();
    push(pm, 20);
    expect(pm.getLogs(CMD_ID)).toHaveLength(20);

    pm.start(CMD_ID);

    // Only the '▶ start' line start() writes itself. Anything the log viewer
    // still holds from before this belongs to a run that no longer exists,
    // which is why it reloads on a startedAt change.
    expect(pm.getLogs(CMD_ID)).toHaveLength(1);
    expect(pm.getLogs(CMD_ID)[0]?.line).toContain('start:');
    expect(pm.getState(CMD_ID).startedAt).not.toBeNull();
  });
});

describe('the buffer honours the same number', () => {
  it('trims a running process to its frozen limit, not the new config', () => {
    const pm = manager();
    pm.start(CMD_ID);
    current = group(10_000);
    push(pm, 500);
    // 100 is what the viewer is told; anything more would be lines it could
    // show and copy while the buffer behind them is already gone.
    expect(pm.getLogs(CMD_ID)).toHaveLength(pm.getLogLimit(CMD_ID));
  });
});
