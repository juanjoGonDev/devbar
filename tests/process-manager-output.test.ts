import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { normalizeGroup } from '../src/groups-model.js';
import { makeActionId, makeCommandId } from '../src/compound-id.js';
import type { GlobalSettings, Group, LogEntry } from '../src/domain-types.js';

/**
 * What a running service's OUTPUT does to its state: which lines are kept,
 * which are classified as a warning or an error, which are silenced, and how
 * an exit or a spawn failure settles the entry.
 *
 * The child is faked (`node:child_process` is mocked): nothing here spawns a
 * real process, so the line-by-line behaviour can be driven deterministically
 * instead of depending on what the contributor's shell prints.
 */
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  kill: () => boolean;
}

const mocks = vi.hoisted(() => ({
  children: [] as unknown[],
  /** When set, `spawn` throws it instead of producing a child. */
  spawnError: null as Error | null,
}));

vi.mock('node:child_process', () => ({
  execFileSync: () => '/devbar-test/shell-bin',
  execFile: () => new EventEmitter(),
  spawn: () => {
    if (mocks.spawnError) throw mocks.spawnError;
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => true;
    mocks.children.push(child);
    return child;
  },
}));

const { ProcessManager } = await import('../src/process-manager.js');

const CMD_ID = makeCommandId('g1', 'c1');
const ACTION_ID = makeActionId('g1', 'a1');

interface GroupShape {
  command?: string;
  silencedWarn?: string[];
  silencedError?: string[];
}

function group({
  command = 'pnpm dev',
  silencedWarn = [],
  silencedError = [],
}: GroupShape = {}): Group {
  return normalizeGroup({
    id: 'g1',
    name: 'G',
    path: '/tmp',
    env: [],
    commands: [
      {
        id: 'c1',
        name: 'Dev',
        command,
        env: [],
        silencedPatterns: { warn: silencedWarn, error: silencedError },
      },
    ],
    actions: [{ id: 'a1', name: 'Install', command: 'pnpm i', env: [] }],
    preScripts: [],
  });
}

let current: Group;

function manager(): InstanceType<typeof ProcessManager> {
  return new ProcessManager({
    getGroup: (id: string) => (id === 'g1' ? current : null),
    listGroups: () => [current],
    getGlobalSettings: () => ({}) as GlobalSettings,
  });
}

function lastChild(): FakeChild {
  const child = mocks.children.at(-1);
  if (!child) throw new Error('nothing was spawned');
  return child as FakeChild;
}

/** Writes lines into a stream and lets readline turn them into events. */
async function say(
  child: FakeChild,
  stream: 'stdout' | 'stderr',
  ...lines: string[]
): Promise<void> {
  for (const line of lines) child[stream].write(`${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Everything after the `▶ start:` line start() writes itself. */
function output(
  pm: InstanceType<typeof ProcessManager>,
  id: string,
): LogEntry[] {
  return pm.getLogs(id).slice(1);
}

describe('src/process-manager.ts — service output and exit', () => {
  beforeEach(() => {
    current = group();
    mocks.children.length = 0;
    mocks.spawnError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('classifying a command line', () => {
    it('counts a line the error regex matches', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', 'ERROR: connection refused');
      const [entry] = output(pm, CMD_ID);
      expect(entry?.level).toBe('error');
      expect(entry?.originalLevel).toBe('error');
      expect(pm.getState(CMD_ID).errorCount).toBe(1);
    });

    it('counts a line the warning regex matches', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', 'warning: deprecated flag');
      expect(output(pm, CMD_ID)[0]?.level).toBe('warn');
      expect(pm.getState(CMD_ID).warnCount).toBe(1);
    });

    it('lets an error outrank a warning on the same line', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', 'warning AND error on one line');
      expect(output(pm, CMD_ID)[0]?.level).toBe('error');
      expect(pm.getState(CMD_ID).warnCount).toBe(0);
    });

    it('leaves an ordinary line unclassified', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', 'Server listening on :3000');
      expect(output(pm, CMD_ID)[0]?.level).toBeNull();
      expect(pm.getState(CMD_ID).errorCount).toBe(0);
      expect(pm.getState(CMD_ID).warnCount).toBe(0);
    });

    it('tags which stream a line came from', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      const child = lastChild();
      await say(child, 'stdout', 'from out');
      await say(child, 'stderr', 'from err');
      expect(output(pm, CMD_ID).map((entry) => entry.stream)).toEqual([
        'stdout',
        'stderr',
      ]);
    });

    it('never classifies an action’s output — regexes are a command concept', async () => {
      // An action has no warnRegex/errorRegex at all; reading the command's
      // would make `pnpm install`'s ordinary "0 errors" line turn the tray red.
      const pm = manager();
      pm.start(ACTION_ID);
      await say(lastChild(), 'stdout', 'ERROR: connection refused');
      expect(output(pm, ACTION_ID)[0]?.level).toBeNull();
      expect(pm.getState(ACTION_ID).errorCount).toBe(0);
    });
  });

  describe('lines that never reach the buffer', () => {
    it('drops the interactive login shell’s own chatter', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(
        lastChild(),
        'stderr',
        'zsh: no job control in this shell',
        'real output',
      );
      expect(output(pm, CMD_ID).map((entry) => entry.line)).toEqual([
        'real output',
      ]);
    });

    it('drops the blank lines an rc file prints while starting up', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', '', '   ', 'real output');
      expect(output(pm, CMD_ID).map((entry) => entry.line)).toEqual([
        'real output',
      ]);
    });
  });

  describe('silenced patterns', () => {
    it('keeps a silenced error line but stops it counting', async () => {
      current = group({ silencedError: ['connection refused'] });
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', 'ERROR: connection refused');
      const [entry] = output(pm, CMD_ID);
      expect(entry?.silenced).toBe(true);
      expect(entry?.level).toBeNull();
      // The ORIGINAL level survives, which is what lets `recount` re-decide
      // once the user removes the pattern.
      expect(entry?.originalLevel).toBe('error');
      expect(pm.getState(CMD_ID).errorCount).toBe(0);
    });

    it('re-reads the patterns per line, so a pattern added mid-run applies', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      const child = lastChild();
      await say(child, 'stdout', 'ERROR: connection refused');
      expect(pm.getState(CMD_ID).errorCount).toBe(1);

      current = group({ silencedError: ['connection refused'] });
      await say(child, 'stdout', 'ERROR: connection refused');
      // Only the first one counted: the second line saw the new pattern.
      expect(pm.getState(CMD_ID).errorCount).toBe(1);
      expect(output(pm, CMD_ID)[1]?.silenced).toBe(true);
    });
  });

  describe('recount', () => {
    it('re-labels the whole buffer after the silenced patterns change', async () => {
      const pm = manager();
      pm.start(CMD_ID);
      await say(
        lastChild(),
        'stdout',
        'ERROR: connection refused',
        'warning: slow',
      );
      expect(pm.getState(CMD_ID).errorCount).toBe(1);
      expect(pm.getState(CMD_ID).warnCount).toBe(1);

      current = group({ silencedError: ['connection refused'] });
      pm.recount(CMD_ID);

      expect(pm.getState(CMD_ID).errorCount).toBe(0);
      expect(pm.getState(CMD_ID).warnCount).toBe(1);
      expect(output(pm, CMD_ID)[0]?.level).toBeNull();
      expect(output(pm, CMD_ID)[0]?.silenced).toBe(true);
    });

    it('un-silences a line again when the pattern is removed', async () => {
      current = group({ silencedError: ['connection refused'] });
      const pm = manager();
      pm.start(CMD_ID);
      await say(lastChild(), 'stdout', 'ERROR: connection refused');
      expect(pm.getState(CMD_ID).errorCount).toBe(0);

      current = group();
      pm.recount(CMD_ID);
      expect(pm.getState(CMD_ID).errorCount).toBe(1);
      expect(output(pm, CMD_ID)[0]?.level).toBe('error');
    });

    it('does nothing for an id with no state', () => {
      const pm = manager();
      pm.pushLog(CMD_ID, {
        ts: 1,
        stream: 'stdout',
        level: 'error',
        line: 'boom',
      });
      pm.recount(CMD_ID);
      // No state means nothing to recount onto — the defaults stay put.
      expect(pm.getState(CMD_ID).errorCount).toBe(0);
    });
  });

  describe('when the child exits', () => {
    it('settles a clean exit as stopped with no error', () => {
      const pm = manager();
      pm.start(CMD_ID);
      lastChild().emit('exit', 0, null);
      expect(pm.getState(CMD_ID).status).toBe('stopped');
      expect(pm.getState(CMD_ID).lastError).toBeNull();
      expect(pm.getState(CMD_ID).child).toBeNull();
      expect(output(pm, CMD_ID).at(-1)?.line).toBe('■ exited with code 0');
      expect(output(pm, CMD_ID).at(-1)?.level).toBeNull();
    });

    it('records a non-zero exit as an error the tray can still see', () => {
      const pm = manager();
      pm.start(CMD_ID);
      lastChild().emit('exit', 1, null);
      expect(pm.getState(CMD_ID).lastError).toBe('exited with code 1');
      expect(output(pm, CMD_ID).at(-1)?.level).toBe('error');
    });

    it('reads a signal exit as OUR stop, not as a crash', () => {
      const pm = manager();
      pm.start(CMD_ID);
      lastChild().emit('exit', null, 'SIGTERM');
      expect(output(pm, CMD_ID).at(-1)?.line).toBe('■ stopped (SIGTERM)');
      expect(output(pm, CMD_ID).at(-1)?.level).toBeNull();
      expect(pm.getState(CMD_ID).lastError).toBeNull();
    });

    it('announces an action’s exit so the pipeline runner can advance', () => {
      const pm = manager();
      const seen: Array<{ processId: string; code: number | null }> = [];
      pm.on('action:done', (payload) => {
        seen.push({ processId: payload.processId, code: payload.code });
        expect(payload.group.id).toBe('g1');
        expect(payload.target.id).toBe('a1');
      });
      pm.start(ACTION_ID);
      lastChild().emit('exit', 0, null);
      expect(seen).toEqual([{ processId: ACTION_ID, code: 0 }]);
      expect(pm.getState(ACTION_ID).status).toBe('done');
      expect(pm.getState(ACTION_ID).lastExitCode).toBe(0);
    });

    it('never announces a COMMAND exit as an action', () => {
      const pm = manager();
      const seen: string[] = [];
      pm.on('action:done', (payload) => seen.push(payload.processId));
      pm.start(CMD_ID);
      lastChild().emit('exit', 0, null);
      expect(seen).toEqual([]);
    });

    it('ignores an exit from a child the entry no longer tracks', () => {
      // The 6.5 s give-up can leave an old child alive while its entry has
      // been replaced; its late exit must not overwrite the newer state.
      const pm = manager();
      pm.start(CMD_ID);
      const child = lastChild();
      const before = pm.getLogs(CMD_ID).length;
      pm.removeState(CMD_ID);
      child.emit('exit', 1, null);
      expect(pm.getLogs(CMD_ID)).toHaveLength(before);
    });
  });

  describe('when the child cannot run', () => {
    it('records a spawn error reported on the child', () => {
      const pm = manager();
      pm.start(CMD_ID);
      lastChild().emit('error', new Error('ENOENT'));
      expect(pm.getState(CMD_ID).status).toBe('stopped');
      expect(pm.getState(CMD_ID).lastError).toBe('spawn error: ENOENT');
      expect(pm.getState(CMD_ID).child).toBeNull();
      expect(output(pm, CMD_ID).at(-1)?.line).toBe('✕ spawn error: ENOENT');
      expect(output(pm, CMD_ID).at(-1)?.level).toBe('error');
    });

    it('reports a spawn that throws outright', () => {
      mocks.spawnError = new Error('EACCES');
      const pm = manager();
      expect(pm.start(CMD_ID)).toEqual({ ok: false, error: 'EACCES' });
      expect(pm.getState(CMD_ID).status).toBe('stopped');
      expect(pm.getState(CMD_ID).lastError).toBe('EACCES');
    });
  });

  describe('start guards', () => {
    it('refuses a pid that resolves to nothing', () => {
      const pm = manager();
      expect(pm.start('cmd:nope:nope')).toEqual({
        ok: false,
        error: 'Process not found',
      });
      expect(mocks.children).toHaveLength(0);
    });

    it('refuses a target with no command configured', () => {
      current = group({ command: '   ' });
      const pm = manager();
      expect(pm.start(CMD_ID)).toEqual({
        ok: false,
        error: 'No command configured',
      });
      expect(pm.getState(CMD_ID).lastError).toBe('No command configured');
      expect(mocks.children).toHaveLength(0);
    });

    it('does not launch a second child for an already-running entry', () => {
      const pm = manager();
      pm.start(CMD_ID);
      expect(pm.start(CMD_ID)).toEqual({ ok: true });
      expect(mocks.children).toHaveLength(1);
    });
  });

  describe('stopping', () => {
    it('is a no-op for an entry that is not running', async () => {
      const pm = manager();
      await expect(pm.stop(CMD_ID)).resolves.toEqual({ ok: true });
      expect(pm.getState(CMD_ID).status).toBe('stopped');
    });

    it('releases the state and buffer of everything it confirmed stopped', async () => {
      vi.spyOn(process, 'kill').mockReturnValue(true);
      const pm = manager();
      pm.start(CMD_ID);
      const child = lastChild();
      const stopping = pm.stopAll();
      child.emit('exit', null, 'SIGTERM');
      await expect(stopping).resolves.toEqual({ ok: true, failed: [] });
      expect(pm.getLogs(CMD_ID)).toEqual([]);
      expect(pm.listLogBuffers()).toEqual([]);
    });

    it('keeps a service whose stop FAILED tracked as running', async () => {
      // A failed stop may have left the child alive and holding its port; a
      // later start() must not be able to launch a duplicate next to it.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('EPERM on the group');
      });
      const pm = manager();
      pm.start(CMD_ID);
      lastChild().kill = () => {
        throw new Error('EPERM on the child');
      };
      await expect(pm.stopAll()).resolves.toEqual({
        ok: false,
        failed: [CMD_ID],
      });
      expect(pm.getState(CMD_ID).status).toBe('running');
      expect(pm.getState(CMD_ID).child).not.toBeNull();
      expect(pm.getState(CMD_ID).lastError).toBe('EPERM on the child');
    });

    it('reports success for a fleet with nothing running', async () => {
      const pm = manager();
      await expect(pm.stopAll()).resolves.toEqual({ ok: true, failed: [] });
    });
  });

  describe('allStates', () => {
    it('exposes only the public fields, even while the process runs', () => {
      // This array is serialized over IPC to the renderer. `child` is a live
      // ChildProcess handle, which cannot be structured-cloned — leaking it
      // here throws at the boundary, not in this class.
      const pm = manager();
      pm.start(CMD_ID);
      const entry = pm.allStates().find((candidate) => candidate.id === CMD_ID);
      expect(
        entry,
        'the started command must appear in allStates',
      ).toBeDefined();
      expect(Object.keys(entry ?? {}).sort()).toEqual([
        'errorCount',
        'group',
        'id',
        'kind',
        'lastError',
        'lastExitCode',
        'lastFinishedAt',
        'startedAt',
        'status',
        'target',
        'warnCount',
      ]);
      expect(entry?.status).toBe('running');
    });
  });

  describe('removeState', () => {
    it('forgets the entry, so the next read starts from the defaults', () => {
      const pm = manager();
      pm.start(CMD_ID);
      expect(pm.getState(CMD_ID).status).toBe('running');
      pm.removeState(CMD_ID);
      expect(pm.getState(CMD_ID).status).toBe('stopped');
      expect(pm.getState(CMD_ID).startedAt).toBeNull();
    });
  });
});
