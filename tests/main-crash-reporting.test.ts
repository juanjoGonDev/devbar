import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCrashReporting,
  startMainDiagnostics,
} from '../src/main/crash-reporting.js';

type Listener = (...args: never[]) => void;

function harness() {
  const processListeners = new Map<string, Listener[]>();
  const appListeners = new Map<string, Listener[]>();
  const logged: { level: string; text: string }[] = [];
  let flushes = 0;
  const add =
    (into: Map<string, Listener[]>) => (event: string, listener: Listener) => {
      into.set(event, [...(into.get(event) ?? []), listener]);
    };
  installCrashReporting({
    onProcess: add(processListeners),
    onApp: add(appListeners),
    log: {
      error: (...args) =>
        logged.push({ level: 'error', text: args.map(String).join(' ') }),
      info: (...args) =>
        logged.push({ level: 'info', text: args.map(String).join(' ') }),
    },
    flush: () => {
      flushes += 1;
    },
  });
  const emit =
    (from: Map<string, Listener[]>) =>
    (event: string, ...args: unknown[]) => {
      for (const l of from.get(event) ?? [])
        (l as (...a: unknown[]) => void)(...args);
    };
  return {
    processListeners,
    emitProcess: emit(processListeners),
    emitApp: emit(appListeners),
    logged,
    flushes: () => flushes,
  };
}

const webContents = (url: string) => ({ getURL: () => url });

describe('src/main/crash-reporting.ts', () => {
  it('monitors uncaught exceptions without claiming them', () => {
    const h = harness();
    // The MONITOR event: a real 'uncaughtException' listener would make
    // Electron skip its own error dialog, silently changing the crash
    // behaviour. The monitor only observes.
    expect(h.processListeners.has('uncaughtException')).toBe(false);
    h.emitProcess(
      'uncaughtExceptionMonitor',
      new Error('kaboom'),
      'uncaughtException',
    );
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]?.level).toBe('error');
    expect(h.logged[0]?.text).toContain('uncaughtException');
    expect(h.logged[0]?.text).toContain('kaboom');
    // Flushed synchronously: the process may be about to go down.
    expect(h.flushes()).toBe(1);
  });

  it('logs an unhandled rejection with its reason', () => {
    const h = harness();
    h.emitProcess('unhandledRejection', new Error('download failed'));
    expect(h.logged[0]).toMatchObject({ level: 'error' });
    expect(h.logged[0]?.text).toContain('unhandledRejection');
    expect(h.logged[0]?.text).toContain('download failed');
  });

  it('flushes pending problems when the process exits', () => {
    const h = harness();
    h.emitProcess('exit', 0);
    expect(h.flushes()).toBe(1);
  });

  it('logs a crashed renderer with its reason, exit code and window', () => {
    const h = harness();
    h.emitApp(
      'render-process-gone',
      {},
      webContents('file:///Applications/DevBar.app/renderer/config.html#about'),
      { reason: 'crashed', exitCode: 139 },
    );
    expect(h.logged[0]?.level).toBe('error');
    expect(h.logged[0]?.text).toContain('render-process-gone');
    expect(h.logged[0]?.text).toContain('window=config');
    expect(h.logged[0]?.text).toContain('reason=crashed');
    expect(h.logged[0]?.text).toContain('exitCode=139');
    expect(h.flushes()).toBe(1);
  });

  it('names an unknown window rather than failing on it', () => {
    const h = harness();
    h.emitApp('render-process-gone', {}, null, { reason: 'oom', exitCode: 1 });
    expect(h.logged[0]?.text).toContain('window=?');
  });

  it('logs a crashed child process with its type and name', () => {
    const h = harness();
    h.emitApp(
      'child-process-gone',
      {},
      {
        type: 'GPU',
        reason: 'crashed',
        exitCode: 5,
        name: 'GPU Process',
      },
    );
    expect(h.logged[0]?.level).toBe('error');
    expect(h.logged[0]?.text).toContain('child-process-gone');
    expect(h.logged[0]?.text).toContain('type=GPU');
    expect(h.logged[0]?.text).toContain('name=GPU Process');
  });

  it('keeps a clean exit out of the error list', () => {
    const h = harness();
    h.emitApp(
      'child-process-gone',
      {},
      {
        type: 'Utility',
        reason: 'clean-exit',
        exitCode: 0,
      },
    );
    h.emitApp('render-process-gone', {}, webContents('file:///x/tray.html'), {
      reason: 'clean-exit',
      exitCode: 0,
    });
    expect(h.logged.map((l) => l.level)).toEqual(['info', 'info']);
  });

  describe('startMainDiagnostics', () => {
    const LEVELS = ['log', 'info', 'warn', 'error'] as const;
    const saved = LEVELS.map(
      (level) => [level, console[level].bind(console)] as const,
    );
    let dir = '';

    afterEach(() => {
      // attachMainConsole wraps console in place; later suites need it back.
      for (const [level, original] of saved) console[level] = original;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function start(logFilePath: () => string): string[] {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-diag-'));
      for (const level of LEVELS) console[level] = () => undefined;
      const events: string[] = [];
      startMainDiagnostics({
        logFilePath,
        onProcess: (event) => events.push(`process:${event}`),
        onApp: (event) => events.push(`app:${event}`),
      });
      return events;
    }

    it('starts the file logger, then hooks every crash event', async () => {
      const events = start(() => path.join(dir, 'app.log'));
      // The stream opens asynchronously: wait for the file to appear.
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(path.join(dir, 'app.log')) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(path.join(dir, 'app.log'))).toBe(true);
      expect(events).toEqual([
        'process:uncaughtExceptionMonitor',
        'process:unhandledRejection',
        'process:exit',
        'app:render-process-gone',
        'app:child-process-gone',
      ]);
    });

    it('still hooks the crash events when the logger cannot start', () => {
      const events = start(() => {
        throw new Error('no logs dir');
      });
      expect(events).toHaveLength(5);
    });
  });
});
