import { describe, expect, it } from 'vitest';
import { remoteRuntime } from '../src/main/remote/runtime.js';
import { sendToRenderers } from '../src/main/renderer-bus.js';
import { fakeAppWiring } from './helpers/remote-wiring.js';

/**
 * The collaborators «Control remoto» gets from the app, assembled from what
 * main.ts already has. Each piece only delegates; what is checked here is
 * that it delegates to the right thing.
 */

function harness() {
  const { wiring, calls, events, registry } = fakeAppWiring();
  const logs = wiring.processManager.getLogs('any');
  return { runtime: remoteRuntime(wiring), calls, events, registry, logs };
}

describe('src/main/remote/runtime.ts', () => {
  it('reads the branch of a group through its repository path', async () => {
    const { runtime } = harness();

    await expect(runtime.currentBranch('g1')).resolves.toEqual({
      ok: true,
      branch: '/repo',
    });
  });

  it('saves settings with every side effect of the config window', () => {
    const { runtime, calls } = harness();

    const next = runtime.settings.save({ notifySuccess: false });

    expect(next.notifySuccess).toBe(false);
    expect(runtime.settings.get().notifySuccess).toBe(false);
    expect(calls).toEqual([
      'autostart:false',
      'repaint',
      'theme:auto',
      'broadcast',
    ]);
  });

  it('hears what the windows hear', () => {
    const { runtime, registry } = harness();
    const heard: unknown[] = [];
    runtime.onBus((channel, payload) => heard.push([channel, payload]));

    sendToRenderers(registry, 'groups:toast', { kind: 'ok', message: 'hi' });

    expect(heard).toEqual([['groups:toast', { kind: 'ok', message: 'hi' }]]);
  });

  it('relays the log lines and reads the buffers', () => {
    const { runtime, events, logs } = harness();
    const lines: unknown[] = [];
    runtime.onLog((payload) => lines.push(payload));

    events.emit('log', { id: 'cmd:g1:c1', entry: logs[0] });

    expect(lines).toEqual([{ id: 'cmd:g1:c1', entry: logs[0] }]);
    expect(runtime.logs('cmd:g1:c1')).toEqual(logs);
    expect(runtime.logSeq('cmd:g1:c1')).toBe(4);
  });

  it('builds the state from the snapshots', () => {
    const { runtime } = harness();

    expect(runtime.groupStates()).toEqual([]);
    expect(runtime.pipelineState().status).toBe('idle');
    expect(runtime.confirms.pending()).toEqual([]);
  });
});
