import { describe, expect, it, vi } from 'vitest';
import type { CommandLink, DetectedPort } from '../src/domain-types.js';
import { normalizeCommand } from '../src/groups/normalize.js';
import {
  isLocalHttpUrl,
  normalizeCommandLink,
  resolveOpenUrl,
  sortPorts,
} from '../src/ports/port-links.js';
import { createPortRegistry } from '../src/ports/port-registry.js';
import { createStateSnapshots } from '../src/main/state-snapshot.js';
import { groupViews } from '../src/main/remote/views.js';
import {
  openCommandPort,
  registerPortsIpc,
} from '../src/main/ipc/ports-ipc.js';
import { stateView } from '../renderer/remote/wire.js';
import {
  makeCommand,
  makeGroup,
  makeSettings,
  makeState,
  recordingIpc,
} from './helpers/main-fakes.js';

function port(overrides: Partial<DetectedPort> = {}): DetectedPort {
  return {
    port: 3000,
    url: 'http://localhost:3000/',
    kind: 'web',
    source: 'socket',
    lanReachable: false,
    ...overrides,
  };
}

describe('src/ports/port-links.ts + port-registry + ports-ipc', () => {
  describe('normalizeCommandLink', () => {
    it.each([
      [undefined, { mode: 'auto' }],
      ['auto', { mode: 'auto' }],
      [{ mode: 'weird' }, { mode: 'auto' }],
      [
        { mode: 'auto', path: ' /admin ' },
        { mode: 'auto', path: '/admin' },
      ],
      [{ mode: 'none', path: '/x' }, { mode: 'none' }],
      [
        { mode: 'custom', url: 'http://app.localhost:3000' },
        { mode: 'custom', url: 'http://app.localhost:3000' },
      ],
      [{ mode: 'custom', url: 'javascript:alert(1)' }, { mode: 'auto' }],
      [{ mode: 'custom' }, { mode: 'auto' }],
    ])('%j → %j', (raw, expected) => {
      expect(normalizeCommandLink(raw)).toEqual(expected);
    });

    it('is applied by the command normaliser, so old stores and backups default to auto', () => {
      expect(
        normalizeCommand({ name: 'api', command: 'pnpm dev' }).link,
      ).toEqual({ mode: 'auto' });
    });
  });

  describe('isLocalHttpUrl', () => {
    it.each([
      ['http://localhost:3000/', true],
      ['https://127.0.0.1:8443', true],
      ['http://[::1]:5173', true],
      ['http://app.localhost', true],
      ['http://192.168.1.20:8080', true],
      ['http://mbp.local:4000', true],
      ['https://example.com', false],
      ['http://8.8.8.8', false],
      ['file:///etc/passwd', false],
      ['javascript:alert(1)', false],
    ])('%s → %s', (url, local) => {
      expect(isLocalHttpUrl(url, 'mbp')).toBe(local);
    });
  });

  describe('sortPorts', () => {
    it('puts the log-announced web port first, then the lowest web port, then the rest', () => {
      const sorted = sortPorts([
        port({ port: 5432, kind: 'other' }),
        port({ port: 9000, kind: 'http' }),
        port({ port: 4000 }),
        port({ port: 6006, source: 'log' }),
      ]);
      expect(sorted.map((p) => p.port)).toEqual([6006, 4000, 9000, 5432]);
    });
  });

  describe('resolveOpenUrl', () => {
    const ports = [
      port({ port: 5432, kind: 'other', url: 'http://localhost:5432/' }),
      port({ port: 5173, url: 'http://localhost:5173/' }),
    ];

    it('auto opens the primary web port', () => {
      expect(resolveOpenUrl({ mode: 'auto' }, ports)).toEqual({
        ok: true,
        url: 'http://localhost:5173/',
      });
    });

    it('auto appends the configured path', () => {
      expect(resolveOpenUrl({ mode: 'auto', path: 'admin' }, ports)).toEqual({
        ok: true,
        url: 'http://localhost:5173/admin',
      });
    });

    it('auto opens an HTTP API, with its path, when there is no web page', () => {
      const api = [
        port({ port: 3000, kind: 'http', url: 'http://localhost:3000' }),
      ];
      expect(resolveOpenUrl({ mode: 'auto', path: '/docs' }, api)).toEqual({
        ok: true,
        url: 'http://localhost:3000/docs',
      });
    });

    it('custom opens its own URL whatever was detected', () => {
      expect(
        resolveOpenUrl({ mode: 'custom', url: 'http://app.localhost' }, []),
      ).toEqual({ ok: true, url: 'http://app.localhost' });
    });

    it('the primary port, opened by itself, still gets the auto path', () => {
      expect(
        resolveOpenUrl({ mode: 'auto', path: '/admin' }, ports, 5173),
      ).toEqual({
        ok: true,
        url: 'http://localhost:5173/admin',
      });
    });

    it('any other port opens bare, even with an auto path', () => {
      expect(
        resolveOpenUrl({ mode: 'auto', path: '/admin' }, ports, 5432),
      ).toEqual({
        ok: true,
        url: 'http://localhost:5432/',
      });
    });

    it('a specific port opens that port', () => {
      expect(resolveOpenUrl(undefined, ports, 5432)).toEqual({
        ok: true,
        url: 'http://localhost:5432/',
      });
    });

    it('fails for none, for no web port and for an unknown port', () => {
      expect(resolveOpenUrl({ mode: 'none' }, ports).ok).toBe(false);
      expect(resolveOpenUrl({ mode: 'auto' }, ports.slice(0, 1)).ok).toBe(
        false,
      );
      expect(resolveOpenUrl(undefined, ports, 1).ok).toBe(false);
    });
  });

  describe('createPortRegistry', () => {
    it('stores ports primary first and notifies only on a real change', () => {
      const onChange = vi.fn();
      const registry = createPortRegistry(onChange);
      registry.setPorts('g', 'c', [port({ port: 9000, kind: 'http' }), port()]);
      registry.setPorts('g', 'c', [port(), port({ port: 9000, kind: 'http' })]);
      expect(registry.portsOf('cmd:g:c').map((p) => p.port)).toEqual([
        3000, 9000,
      ]);
      expect(onChange).toHaveBeenCalledOnce();
      registry.clear('cmd:g:c');
      expect(registry.portsOf('cmd:g:c')).toEqual([]);
      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });

  describe('runtime state and the phone', () => {
    const group = makeGroup({
      id: 'g',
      commands: [makeCommand({ id: 'c', name: 'Front' })],
    });

    function snapshot(status: 'running' | 'stopped') {
      return createStateSnapshots({
        configStore: {
          listGroups: () => [group],
          getGlobalSettings: () => makeSettings(),
          listWorkflows: () => [],
          getWorkflowRuns: () => ({}),
          getScheduleLastRun: () => null,
        },
        processManager: { getState: (id) => makeState({ id, status }) },
        workflowRunner: { runState: () => null, isRunning: () => false },
        groupErrors: new Map(),
        portsOf: () => [port({ lanReachable: true, label: 'Vite' })],
      }).snapshotGroupStates();
    }

    it('pushes the ports of a running command in its runtime state', () => {
      expect(snapshot('running')[0]?.commands[0]?.ports).toEqual([
        port({ lanReachable: true, label: 'Vite' }),
      ]);
    });

    it('reports no ports for a command that is not running', () => {
      expect(snapshot('stopped')[0]?.commands[0]?.ports).toEqual([]);
    });

    it('sends the phone only port, kind and lanReachable — never the URL', () => {
      const [view] = groupViews(snapshot('running'), new Map(), true);
      expect(view?.commands[0]?.ports).toEqual([
        { port: 3000, kind: 'web', lanReachable: true },
      ]);
    });

    it('narrows the ports a phone receives, dropping malformed entries', () => {
      const state = stateView({
        groups: [
          {
            id: 'g',
            commands: [
              {
                id: 'c',
                ports: [
                  { port: 3000, kind: 'web', lanReachable: true, url: 'x' },
                  { port: 70000, kind: 'web' },
                  { port: 5432, kind: 'weird' },
                ],
              },
            ],
          },
        ],
      });
      expect(state.groups[0]?.commands[0]?.ports).toEqual([
        { port: 3000, kind: 'web', lanReachable: true },
        { port: 5432, kind: 'other', lanReachable: false },
      ]);
    });
  });

  describe('openPort', () => {
    function deps(
      link: DetectedPort[] = [port()],
      linkConfig: CommandLink = { mode: 'auto' },
    ) {
      const openExternal = vi.fn();
      return {
        openExternal,
        deps: {
          configStore: {
            getGroup: (id: string) =>
              id === 'g'
                ? makeGroup({
                    id: 'g',
                    commands: [makeCommand({ id: 'c', link: linkConfig })],
                  })
                : null,
          },
          portsOf: (processId: string) => (processId === 'cmd:g:c' ? link : []),
          openExternal,
          machineHostname: () => 'mbp',
        },
      };
    }

    it('opens the resolved URL over the ports:open channel', async () => {
      const { deps: d, openExternal } = deps();
      const ipc = recordingIpc();
      registerPortsIpc(ipc, d);
      expect(
        await ipc.invoke('ports:open', { groupId: 'g', commandId: 'c' }),
      ).toEqual({ ok: true });
      expect(openExternal).toHaveBeenCalledWith('http://localhost:3000/');
    });

    it('refuses a custom link that points off this machine', () => {
      const { deps: d, openExternal } = deps([], {
        mode: 'custom',
        url: 'https://example.com',
      });
      expect(openCommandPort(d, 'g', 'c')).toEqual({
        ok: false,
        error: 'Solo se abren direcciones locales o de la red',
      });
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('reports an unknown command', () => {
      const { deps: d } = deps();
      expect(openCommandPort(d, 'nope', 'c').ok).toBe(false);
    });
  });
});
