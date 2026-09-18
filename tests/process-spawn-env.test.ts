import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { normalizeGroup } from '../src/groups-model.js';
import { makeActionId, makeCommandId } from '../src/compound-id.js';
import type { EnvEntry, GlobalSettings, Group } from '../src/domain-types.js';

/**
 * The spawn environment a service actually receives.
 *
 * The regression guarded here: `enhancedEnv` spreads `process.env` itself and
 * THEN replaces PATH with the login shell's one, so the call sites passing
 * `{ ...process.env, ... }` as the override bag put the inherited PATH back on
 * top and the shell PATH never reached a single child. Invisible under
 * `pnpm start` from a terminal (both PATHs are the login shell's there) and
 * broken in exactly the case path-helper exists for: a GUI launch (Finder,
 * login item, autostart), whose PATH has none of the user's own directories.
 */
const mocks = vi.hoisted(() => ({
  /** What the user's LOGIN SHELL reports — what path-helper goes and asks for. */
  shellPath: '/devbar-test/shell-bin',
  /** Every env handed to spawn, in call order. */
  spawnEnvs: [] as (NodeJS.ProcessEnv | undefined)[],
}));

/** The reduced PATH a GUI launch leaves in `process.env`. */
const GUI_PATH = '/devbar-test/gui-inherited';

vi.mock('node:child_process', () => ({
  // path-helper asks the login shell for its PATH through execFileSync.
  execFileSync: () => mocks.shellPath,
  execFile: () => new EventEmitter(),
  spawn: (
    _file: string,
    _args: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    mocks.spawnEnvs.push(options.env);
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

const entry = (key: string, value: string): EnvEntry => ({
  key,
  value,
  enabled: true,
});

function makeGroup({
  groupEnv = [],
  commandEnv = [],
  actionEnv = [],
  inheritGroupEnv = false,
}: {
  groupEnv?: EnvEntry[];
  commandEnv?: EnvEntry[];
  actionEnv?: EnvEntry[];
  inheritGroupEnv?: boolean;
}): Group {
  return normalizeGroup({
    id: 'g1',
    name: 'G',
    path: '/tmp',
    env: groupEnv,
    commands: [{ id: 'c1', name: 'Dev', command: 'true', env: commandEnv }],
    actions: [
      {
        id: 'a1',
        name: 'Act',
        command: 'true',
        env: actionEnv,
        inheritGroupEnv,
      },
    ],
    preScripts: [],
  });
}

/** Start `processId` in a fresh manager and return the env spawn received. */
function spawnEnvFor(group: Group, processId: string): NodeJS.ProcessEnv {
  const pm = new ProcessManager({
    getGroup: (id: string) => (id === 'g1' ? group : null),
    listGroups: () => [group],
    getGlobalSettings: () => ({}) as GlobalSettings,
  });
  const result = pm.start(processId);
  expect(result.ok).toBe(true);
  const env = mocks.spawnEnvs.at(-1);
  expect(env).toBeDefined();
  return env as NodeJS.ProcessEnv;
}

const COMMAND_ID = makeCommandId('g1', 'c1');
const ACTION_ID = makeActionId('g1', 'a1');

// POSIX only: on Windows `loadShellPath` never queries a shell (the GUI
// environment already carries the user's PATH), so there is no shell-vs-
// inherited distinction to assert. The Windows merge is pinned by the
// `enhancedEnv on Windows` suite in tests/path-helper.test.ts.
describe.skipIf(process.platform === 'win32')(
  'service spawn env (POSIX)',
  () => {
    beforeEach(() => {
      mocks.spawnEnvs.length = 0;
      vi.stubEnv('PATH', GUI_PATH);
      vi.stubEnv('DEVBAR_TEST_INHERITED', 'from-process-env');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('hands a command the login-shell PATH, not the inherited one', () => {
      const env = spawnEnvFor(makeGroup({}), COMMAND_ID);
      expect(env.PATH?.split(':')[0]).toBe(mocks.shellPath);
      expect(env.PATH?.split(':')).not.toContain(GUI_PATH);
    });

    it('hands an action the login-shell PATH, not the inherited one', () => {
      const env = spawnEnvFor(makeGroup({}), ACTION_ID);
      expect(env.PATH?.split(':')[0]).toBe(mocks.shellPath);
      expect(env.PATH?.split(':')).not.toContain(GUI_PATH);
    });

    it('still forwards every other inherited variable to the child', () => {
      const env = spawnEnvFor(makeGroup({}), COMMAND_ID);
      expect(env.DEVBAR_TEST_INHERITED).toBe('from-process-env');
    });

    it('lets a group PATH override beat the login-shell PATH', () => {
      const group = makeGroup({ groupEnv: [entry('PATH', '/group/bin')] });
      expect(spawnEnvFor(group, COMMAND_ID).PATH).toBe('/group/bin');
    });

    it('lets a target PATH override beat both the group and the shell', () => {
      const group = makeGroup({
        groupEnv: [entry('PATH', '/group/bin')],
        commandEnv: [entry('PATH', '/target/bin')],
      });
      expect(spawnEnvFor(group, COMMAND_ID).PATH).toBe('/target/bin');
    });

    it('lets an action PATH override beat the login-shell PATH', () => {
      const group = makeGroup({ actionEnv: [entry('PATH', '/action/bin')] });
      expect(spawnEnvFor(group, ACTION_ID).PATH).toBe('/action/bin');
    });

    it('merges the group env into an action that inherits it', () => {
      const group = makeGroup({
        groupEnv: [entry('FROM_GROUP', 'yes')],
        inheritGroupEnv: true,
      });
      const env = spawnEnvFor(group, ACTION_ID);
      expect(env.FROM_GROUP).toBe('yes');
      expect(env.PATH?.split(':')[0]).toBe(mocks.shellPath);
    });

    it('keeps the group env out of an action that does not inherit it', () => {
      const group = makeGroup({
        groupEnv: [entry('FROM_GROUP', 'yes')],
        inheritGroupEnv: false,
      });
      const env = spawnEnvFor(group, ACTION_ID);
      expect(env.FROM_GROUP).toBeUndefined();
      expect(env.PATH?.split(':')[0]).toBe(mocks.shellPath);
    });

    it('keeps a group PATH out of an action that does not inherit it', () => {
      const group = makeGroup({
        groupEnv: [entry('PATH', '/group/bin')],
        inheritGroupEnv: false,
      });
      expect(spawnEnvFor(group, ACTION_ID).PATH?.split(':')[0]).toBe(
        mocks.shellPath,
      );
    });
  },
);
