import { describe, expect, it, vi } from 'vitest';
import { createStartup, type StartupDeps } from '../src/main/startup.js';
import { makeCommand, makeGroup, makeSettings } from './helpers/main-fakes.js';
import type { Group, LogEntry, PreStep } from '../src/domain-types.js';
import type { RunResult } from '../src/pre-script-runner.js';

function step(id: string, groupId: string, scriptId: string): PreStep {
  return { id, mode: 'serial', scripts: [{ groupId, scriptId }] };
}

function harness(overrides: Partial<StartupDeps> = {}) {
  const started: string[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const notices: string[] = [];
  const logs: { id: string; entry: LogEntry }[] = [];
  let groups: Group[] = [];
  let preSteps: PreStep[] = [];
  let runResult: RunResult = { ok: true, runId: 1 };
  const resolvable: { resolve: (result: RunResult) => void }[] = [];
  const deps: StartupDeps = {
    processManager: {
      resolveTarget: (id) =>
        id === 'cmd:g1:web'
          ? { kind: 'command', target: { command: 'pnpm dev', confirm: false } }
          : null,
      start: (id) => {
        started.push(id);
        return { ok: true };
      },
      pushLog: (id, entry) => logs.push({ id, entry }),
    },
    configStore: {
      listGroups: () => groups,
      getPreSteps: () => preSteps,
      getGlobalSettings: () => makeSettings({ preScriptsAutoRun: true }),
    },
    preScriptRunner: {
      run: () => Promise.resolve(runResult),
      current: () => null,
    },
    consumeSnapshot: () => ({ resume: [], reason: 'kill' }),
    broadcastToast: (kind, message) => toasts.push({ kind, message }),
    showCompletionNotification: (_title, body) => notices.push(body),
    wasOpenedAtLogin: () => true,
    forceLogin: false,
    ...overrides,
  };
  return {
    startup: createStartup(deps),
    started,
    toasts,
    notices,
    logs,
    resolvable,
    setGroups: (next: Group[]) => {
      groups = next;
    },
    setSteps: (next: PreStep[]) => {
      preSteps = next;
    },
    setRunResult: (next: RunResult) => {
      runResult = next;
    },
  };
}

const autoGroup = (id: string, overrides: Partial<Group> = {}): Group =>
  makeGroup({
    id,
    commands: [makeCommand({ id: 'web', autoStart: true })],
    ...overrides,
  });

describe('src/main/startup.ts', () => {
  describe('resumeSavedServices', () => {
    it('does nothing when the snapshot is empty', () => {
      const h = harness();
      h.startup.resumeSavedServices();
      expect(h.started).toEqual([]);
      expect(h.toasts).toEqual([]);
    });

    it('restarts what the snapshot says was running', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness({
        consumeSnapshot: () => ({ resume: ['cmd:g1:web'], reason: 'update' }),
      });
      h.startup.resumeSavedServices();
      expect(h.started).toEqual(['cmd:g1:web']);
      expect(h.toasts).toEqual([
        { kind: 'ok', message: 'Servicios restaurados: 1' },
      ]);
      log.mockRestore();
    });

    it('reports a partial restore when a start fails', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness({
        consumeSnapshot: () => ({ resume: ['a', 'b'], reason: 'kill' }),
        processManager: {
          resolveTarget: () => null,
          start: (id) => (id === 'a' ? { ok: true } : { ok: false }),
          pushLog: () => undefined,
        },
      });
      h.startup.resumeSavedServices();
      expect(h.toasts[0]?.message).toBe('Servicios restaurados: 1 de 2');
      expect(warn).toHaveBeenCalled();
      log.mockRestore();
      warn.mockRestore();
    });

    it('never resumes an action, a blank command or a confirm-gated one', () => {
      const seen: string[] = [];
      const h = harness({
        consumeSnapshot: (canResume) => {
          for (const id of [
            'act:g1:a',
            'cmd:g1:blank',
            'cmd:g1:gated',
            'cmd:g1:web',
          ])
            if (canResume(id)) seen.push(id);
          return { resume: [], reason: 'kill' };
        },
        processManager: {
          resolveTarget: (id) =>
            id === 'act:g1:a'
              ? { kind: 'action', target: { command: 'x' } }
              : id === 'cmd:g1:blank'
                ? { kind: 'command', target: { command: '  ' } }
                : id === 'cmd:g1:gated'
                  ? { kind: 'command', target: { command: 'x', confirm: true } }
                  : { kind: 'command', target: { command: 'pnpm dev' } },
          start: () => ({ ok: true }),
          pushLog: () => undefined,
        },
      });
      h.startup.resumeSavedServices();
      expect(seen).toEqual(['cmd:g1:web']);
    });
  });

  describe('startGroupAutoStartCommands', () => {
    it('starts every flagged command of a multi-mode group', () => {
      const h = harness();
      h.startup.startGroupAutoStartCommands(
        makeGroup({
          commands: [
            makeCommand({ id: 'a', autoStart: true }),
            makeCommand({ id: 'b', autoStart: true }),
            makeCommand({ id: 'c' }),
          ],
        }),
      );
      expect(h.started).toEqual(['cmd:g1:a', 'cmd:g1:b']);
    });

    it('starts only the first in a single-mode group', () => {
      const h = harness();
      h.startup.startGroupAutoStartCommands(
        makeGroup({
          mode: 'single',
          commands: [
            makeCommand({ id: 'a', autoStart: true }),
            makeCommand({ id: 'b', autoStart: true }),
          ],
        }),
      );
      expect(h.started).toEqual(['cmd:g1:a']);
    });

    it('swallows a failed start so the rest still come up', () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const h = harness({
        processManager: {
          resolveTarget: () => null,
          start: (id) => {
            if (id === 'cmd:g1:a') throw new Error('spawn failed');
            return { ok: true };
          },
          pushLog: () => undefined,
        },
      });
      h.startup.startGroupAutoStartCommands(
        makeGroup({
          commands: [
            makeCommand({ id: 'a', autoStart: true }),
            makeCommand({ id: 'b', autoStart: true }),
          ],
        }),
      );
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });

  describe('autoStartAllMarkedCommands', () => {
    it('starts every eligible group at once when the pipeline must not run', async () => {
      const h = harness({ wasOpenedAtLogin: () => false });
      h.setGroups([autoGroup('g1'), autoGroup('g2')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      await h.startup.autoStartAllMarkedCommands();
      expect(h.started).toEqual(['cmd:g1:web', 'cmd:g2:web']);
    });

    it('honours DEVBAR_FORCE_LOGIN even when the OS says otherwise', async () => {
      const h = harness({ wasOpenedAtLogin: () => false, forceLogin: true });
      h.setGroups([autoGroup('g1')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      await h.startup.autoStartAllMarkedCommands();
      // The group waits for the pipeline, so nothing starts up front.
      expect(h.started).toEqual([]);
    });

    it('releases a group with no scripts immediately', async () => {
      const h = harness();
      h.setGroups([autoGroup('g1'), autoGroup('g2')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      await h.startup.autoStartAllMarkedCommands();
      expect(h.started).toContain('cmd:g2:web');
    });

    it('releases a non-waiting group as its own last step clears', async () => {
      const h = harness();
      h.setGroups([autoGroup('g1', { waitForPipeline: false })]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      const run = h.startup.autoStartAllMarkedCommands();
      h.startup.onPipelineStepComplete(0);
      await run;
      expect(h.started).toEqual(['cmd:g1:web']);
    });

    it('ignores step completions outside a boot run', () => {
      const h = harness();
      h.startup.onPipelineStepComplete(0);
      expect(h.started).toEqual([]);
    });

    it('names the groups withheld by a pipeline failure', async () => {
      const h = harness();
      h.setGroups([autoGroup('g1')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      h.setRunResult({
        ok: false,
        error: 'vpn failed',
        aggregatorId: 'pre-pipeline:1',
      });
      await h.startup.autoStartAllMarkedCommands();
      expect(h.logs[0]?.id).toBe('pre-pipeline:1');
      expect(h.toasts[0]?.kind).toBe('error');
      expect(h.notices).toHaveLength(1);
    });

    it('reports a cancellation without an aggregator log when there is none', async () => {
      const h = harness();
      h.setGroups([autoGroup('g1')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      h.setRunResult({ ok: false, error: 'cancelled', cancelled: true });
      await h.startup.autoStartAllMarkedCommands();
      expect(h.logs).toEqual([]);
      expect(h.toasts).toHaveLength(1);
    });

    it('adopts the result of a manual run that was already in flight', async () => {
      const h = harness({
        preScriptRunner: {
          run: () => Promise.resolve({ ok: false, error: 'already_running' }),
          current: () =>
            Promise.resolve({
              ok: false,
              error: 'boom',
              aggregatorId: 'pre-pipeline:9',
            }),
        },
      });
      h.setGroups([autoGroup('g1')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      await h.startup.autoStartAllMarkedCommands();
      expect(h.logs[0]?.id).toBe('pre-pipeline:9');
    });
  });

  describe('shouldShowGenericFailureToast', () => {
    it('shows the generic toast outside a boot run', () => {
      const h = harness();
      expect(h.startup.shouldShowGenericFailureToast()).toBe(true);
    });

    it('stays quiet during a boot run that withholds groups', async () => {
      const h = harness();
      h.setGroups([autoGroup('g1')]);
      h.setSteps([step('s1', 'g1', 'vpn')]);
      let seen: boolean | null = null;
      const run = h.startup.autoStartAllMarkedCommands();
      seen = h.startup.shouldShowGenericFailureToast();
      await run;
      expect(seen).toBe(false);
    });
  });
});
