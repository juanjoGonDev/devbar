import { describe, expect, it } from 'vitest';
import {
  registerRemoteIpc,
  type RemoteIpcDeps,
} from '../src/main/ipc/remote-ipc.js';
import type { RemoteStatus } from '../src/ipc-contract/remote-api.js';
import { recordingIpc } from './helpers/main-fakes.js';

const STATUS: RemoteStatus = {
  enabled: true,
  autoUnlink: true,
  port: 47821,
  listening: true,
  error: null,
  addresses: ['192.168.1.20'],
  devices: [],
};

function harness() {
  const calls: unknown[][] = [];
  const record =
    <T>(name: string, answer: T) =>
    (...args: unknown[]): T => {
      calls.push([name, ...args]);
      return answer;
    };
  const remote: RemoteIpcDeps['remote'] = {
    status: record('status', STATUS),
    setEnabled: record('setEnabled', Promise.resolve(STATUS)),
    setAutoUnlink: record('setAutoUnlink', STATUS),
    setPort: record(
      'setPort',
      Promise.resolve({ ok: true as const, status: STATUS }),
    ),
    renameDevice: record('renameDevice', { ok: true as const }),
    unlinkDevice: record('unlinkDevice', { ok: true as const }),
    startPairing: record('startPairing', {
      ok: false as const,
      error: 'off',
    }),
    cancelPairing: record('cancelPairing', undefined),
    respondPairing: record('respondPairing', { ok: true as const }),
  };
  const ipc = recordingIpc();
  registerRemoteIpc(ipc, { remote });
  return { ipc, calls };
}

describe('src/main/ipc/remote-ipc.ts', () => {
  it('answers the status', () => {
    const h = harness();

    expect(h.ipc.invoke('remote:getStatus')).toEqual(STATUS);
  });

  it.each([
    ['remote:setEnabled', { enabled: true }, ['setEnabled', true]],
    ['remote:setAutoUnlink', { enabled: false }, ['setAutoUnlink', false]],
    ['remote:setPort', { port: 50123 }, ['setPort', 50123]],
    [
      'remote:renameDevice',
      { id: 'd1', name: 'Tablet' },
      ['renameDevice', 'd1', 'Tablet'],
    ],
    ['remote:unlinkDevice', { id: 'd1' }, ['unlinkDevice', 'd1']],
    [
      'remote:respondPairing',
      { requestId: 'r1', accept: true },
      ['respondPairing', 'r1', true],
    ],
  ])('%s hands the validated payload over', (channel, payload, call) => {
    const h = harness();

    h.ipc.invoke(channel, payload);

    expect(h.calls).toEqual([call]);
  });

  it('starts and cancels pairing', () => {
    const h = harness();

    expect(h.ipc.invoke('remote:startPairing')).toEqual({
      ok: false,
      error: 'off',
    });
    expect(h.ipc.invoke('remote:cancelPairing')).toEqual({ ok: true });
    expect(h.calls).toEqual([['startPairing'], ['cancelPairing']]);
  });

  it.each([
    ['remote:setEnabled', { enabled: 'yes' }],
    ['remote:setAutoUnlink', null],
    ['remote:setPort', { port: '50123' }],
    ['remote:setPort', { port: Number.NaN }],
    ['remote:renameDevice', { id: 'd1', name: 7 }],
    ['remote:unlinkDevice', { id: ['d1'] }],
    ['remote:respondPairing', { requestId: 'r1', accept: 'true' }],
  ])(
    '%s refuses a malformed payload before touching anything',
    (channel, payload) => {
      const h = harness();

      expect(() => h.ipc.invoke(channel, payload)).toThrow(TypeError);
      expect(h.calls).toEqual([]);
    },
  );
});
