import { describe, expect, it, vi } from 'vitest';
import { registerLogsIpc, type LogsIpcDeps } from '../src/main/ipc/logs-ipc.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeSettings,
  makeState,
  recordingIpc,
} from './helpers/main-fakes.js';
import type { Group, LogEntry } from '../src/domain-types.js';
import {
  PIPELINE_LOG_GROUP_ID,
  PIPELINE_LOG_NAME,
} from '../src/pipeline-labels.js';
import type { LogListGroup, LogSource } from '../src/ipc-contract.js';

const line = (ts: number, text: string): LogEntry => ({
  ts,
  stream: 'stdout',
  level: null,
  line: text,
});

function harness(groups: Group[] = [], overrides: Partial<LogsIpcDeps> = {}) {
  const buffers = new Map<string, LogEntry[]>();
  const watched: string[] = [];
  const scopes: (string | null)[] = [];
  const ipc = recordingIpc();
  const SHARED = { shared: true };
  registerLogsIpc(ipc, {
    configStore: {
      getGroup: (id) => groups.find((g) => g.id === id) ?? null,
      listGroups: () => groups,
      getGlobalSettings: () => makeSettings({ maxLogLines: 3 }),
    },
    processManager: {
      resolveTarget: (id) =>
        id === 'pre:g1:vpn'
          ? {
              kind: 'prescript',
              group: makeGroup(),
              target: { name: 'vpn' } as never,
            }
          : id === 'cmd:g1:c1'
            ? {
                kind: 'command',
                group: makeGroup(),
                target: { name: 'web' } as never,
              }
            : null,
      getState: (id) => makeState({ id, status: 'running', warnCount: 1 }),
      getLogs: (id) => buffers.get(id) ?? [],
      getLogLimit: () => 10_000,
      getLogSeq: (id) => (buffers.get(id) ?? []).length,
      listLogBuffers: () =>
        [...buffers.entries()].map(([id, entries]) => ({
          id,
          lineCount: entries.length,
        })),
      clearLogs: (id) => buffers.delete(id),
    },
    logWindows: {
      isSharedWindowSender: (sender) => sender === SHARED,
      watchSingle: (processId) => watched.push(processId),
      watchScope: (groupId) => scopes.push(groupId),
    },
    ...overrides,
  });
  return { ipc, buffers, watched, scopes, SHARED };
}

describe('src/main/ipc/logs-ipc.ts', () => {
  describe('registration', () => {
    it('claims every log channel', () => {
      expect(harness().ipc.channels()).toEqual([
        'logs:get',
        'logs:getMergedSources',
        'logs:getMerged',
        'logs:clear',
        'logs:list',
      ]);
    });
  });

  describe('logs:get', () => {
    it('returns the buffer with the seq that bounds the live stream', () => {
      const h = harness();
      h.buffers.set('cmd:g1:c1', [line(1, 'a'), line(2, 'b')]);
      expect(h.ipc.invoke('logs:get', 'cmd:g1:c1')).toMatchObject({
        lines: [line(1, 'a'), line(2, 'b')],
        seq: 2,
        logLimit: 10_000,
        commandState: { status: 'running' },
      });
    });

    it('describes an unknown target rather than failing', () => {
      const h = harness();
      expect(h.ipc.invoke('logs:get', 'cmd:g9:gone')).toMatchObject({
        target: { kind: 'unknown', group: null, target: { name: '?' } },
      });
    });

    it('subscribes the shared window in the same tick it snapshots', () => {
      const h = harness();
      h.ipc.invokeFrom(h.SHARED, 'logs:get', 'cmd:g1:c1');
      expect(h.watched).toEqual(['cmd:g1:c1']);
    });

    it('leaves the subscription of a detached window alone', () => {
      const h = harness();
      h.ipc.invokeFrom({}, 'logs:get', 'cmd:g1:c1');
      expect(h.watched).toEqual([]);
    });
  });

  describe('logs:getMergedSources', () => {
    it('lists every configured command and action of one group', () => {
      const h = harness([
        makeGroup({
          commands: [makeCommand({ id: 'c1', name: 'web' })],
          actions: [makeAction({ id: 'a1', name: 'seed' })],
        }),
      ]);
      expect(h.ipc.invoke('logs:getMergedSources', 'g1')).toEqual([
        { id: 'cmd:g1:c1', name: 'web', groupId: 'g1', groupName: 'API' },
        { id: 'act:g1:a1', name: 'seed', groupId: 'g1', groupName: 'API' },
      ]);
    });

    it('spans every group when no scope is given', () => {
      const h = harness([
        makeGroup({ commands: [makeCommand({ id: 'c1' })] }),
        makeGroup({ id: 'g2', commands: [makeCommand({ id: 'c2' })] }),
      ]);
      expect(h.ipc.invoke('logs:getMergedSources', null)).toHaveLength(2);
      expect(h.ipc.invoke('logs:getMergedSources', undefined)).toHaveLength(2);
    });

    it('adds a pre-script buffer under its own real group', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre:g1:vpn', [line(1, 'a')]);
      expect(h.ipc.invoke('logs:getMergedSources', 'g1')).toEqual([
        { id: 'pre:g1:vpn', name: 'vpn', groupId: 'g1', groupName: 'API' },
      ]);
    });

    it('keeps a deleted script reachable under its raw id inside its group', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre:g1:gone', [line(1, 'a')]);
      expect(h.ipc.invoke('logs:getMergedSources', 'g1')).toEqual([
        {
          id: 'pre:g1:gone',
          name: 'pre:g1:gone',
          groupId: 'g1',
          groupName: 'API',
        },
      ]);
    });

    it('drops a nameless script from the pipeline cross-group view', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre:g9:gone', [line(1, 'a')]);
      expect(
        h.ipc.invoke('logs:getMergedSources', PIPELINE_LOG_GROUP_ID),
      ).toEqual([]);
    });

    it('lists the aggregator in the pipeline scope, not inside a group', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre-pipeline:7', [line(1, 'a')]);
      const pipeline = h.ipc.invoke(
        'logs:getMergedSources',
        PIPELINE_LOG_GROUP_ID,
      ) as LogSource[];
      expect(pipeline[0]).toMatchObject({
        id: 'pre-pipeline:7',
        groupId: PIPELINE_LOG_GROUP_ID,
      });
      expect(h.ipc.invoke('logs:getMergedSources', 'g1')).toEqual([]);
    });
  });

  describe('logs:getMerged', () => {
    it('merges the newest lines across sources, capped by the retention setting', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness([
        makeGroup({
          commands: [makeCommand({ id: 'c1' }), makeCommand({ id: 'c2' })],
        }),
      ]);
      h.buffers.set('cmd:g1:c1', [line(1, 'a'), line(3, 'c')]);
      h.buffers.set('cmd:g1:c2', [line(2, 'b'), line(4, 'd')]);
      const merged = h.ipc.invoke('logs:getMerged', 'g1') as {
        groupName: string;
        lines: { line: string }[];
        seqs: Record<string, number>;
      };
      expect(merged.groupName).toBe('API');
      expect(merged.lines.map((entry) => entry.line)).toEqual(['b', 'c', 'd']);
      expect(merged.seqs).toEqual({ 'cmd:g1:c1': 2, 'cmd:g1:c2': 2 });
      log.mockRestore();
    });

    it('names the cross-group view and the pipeline one', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness([makeGroup()]);
      expect(h.ipc.invoke('logs:getMerged', null)).toMatchObject({
        groupName: 'Telemetría',
      });
      expect(
        h.ipc.invoke('logs:getMerged', PIPELINE_LOG_GROUP_ID),
      ).toMatchObject({
        groupName: PIPELINE_LOG_NAME,
      });
      log.mockRestore();
    });

    it('falls back for a scope whose group was deleted', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness();
      expect(h.ipc.invoke('logs:getMerged', 'ghost')).toMatchObject({
        groupName: '?',
      });
      log.mockRestore();
    });

    it('switches the shared window to the merged scope in the same tick', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness([makeGroup()]);
      h.ipc.invokeFrom(h.SHARED, 'logs:getMerged', 'g1');
      h.ipc.invokeFrom({}, 'logs:getMerged', 'g1');
      expect(h.scopes).toEqual(['g1']);
      log.mockRestore();
    });
  });

  describe('logs:clear', () => {
    it('really wipes the retained buffer', () => {
      const h = harness();
      h.buffers.set('cmd:g1:c1', [line(1, 'a')]);
      expect(h.ipc.invoke('logs:clear', 'cmd:g1:c1')).toEqual({ ok: true });
      expect(h.buffers.has('cmd:g1:c1')).toBe(false);
    });
  });

  describe('logs:list', () => {
    it('lists everything configured, even with no buffer yet', () => {
      const h = harness([
        makeGroup({
          commands: [makeCommand({ id: 'c1', name: 'web', icon: '🌐' })],
          actions: [makeAction({ id: 'a1', name: 'seed' })],
        }),
      ]);
      const [group] = h.ipc.invoke('logs:list') as LogListGroup[];
      expect(group?.groupName).toBe('API');
      expect(group?.items.map((item) => item.type)).toEqual([
        'command',
        'action',
      ]);
      expect(group?.items[0]).toMatchObject({ lineCount: 0, icon: '🌐' });
    });

    it('adds pre-script buffers under their group', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre:g1:vpn', [line(1, 'a')]);
      const [group] = h.ipc.invoke('logs:list') as LogListGroup[];
      expect(group?.items[0]).toMatchObject({
        type: 'prescript',
        name: 'vpn',
        lineCount: 1,
      });
    });

    it('falls back to the raw id for a script that is gone', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre:g1:gone', [line(1, 'a')]);
      const [group] = h.ipc.invoke('logs:list') as LogListGroup[];
      expect(group?.items[0]?.name).toBe('pre:g1:gone');
    });

    it('opens a bucket for a group that was deleted', () => {
      const h = harness();
      h.buffers.set('pre:gone:vpn', [line(1, 'a')]);
      const [group] = h.ipc.invoke('logs:list') as LogListGroup[];
      expect(group).toMatchObject({
        groupName: '(grupo eliminado)',
        groupIcon: '📁',
      });
    });

    it('gives the pipeline its own top-level bucket, never nested', () => {
      const h = harness([makeGroup()]);
      h.buffers.set('pre-pipeline:7', [line(1, 'a')]);
      const groups = h.ipc.invoke('logs:list') as LogListGroup[];
      const pipeline = groups.find(
        (entry) => entry.groupId === PIPELINE_LOG_GROUP_ID,
      );
      expect(pipeline?.items[0]).toMatchObject({ type: 'pipeline' });
      expect(pipeline?.groupIcon).toBe('🧬');
    });
  });
});
