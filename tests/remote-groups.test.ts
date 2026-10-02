// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buttonNamed,
  byId,
  CONFIRM,
  settle,
  startLinked,
  state,
  tap,
  tapId,
  text,
  visibleTab,
  visibleView,
} from './helpers/remote-page.js';

/**
 * «Grupos», the panel a linked phone lands on: the computer, its groups and
 * services, and every way to start or stop them.
 */

const cards = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('#groups > .group-card'),
];
const headOf = (card: HTMLElement | undefined) =>
  card?.querySelector<HTMLButtonElement>('.group-head');
const rowsOf = (card: HTMLElement | undefined) => [
  ...(card?.querySelectorAll<HTMLElement>('.command-row') ?? []),
];
const rowText = (row: HTMLElement | undefined, selector: string) =>
  row?.querySelector(selector)?.textContent?.trim() ?? '';

describe('renderer/remote/groups-tab.ts', () => {
  describe('the header', () => {
    it('names the computer and the DevBar it runs', async () => {
      await startLinked();

      expect(visibleView()).toBe('linked');
      expect(visibleTab()).toBe('groups');
      expect(text('host-name')).toBe('Mac-de-Ana');
      expect(text('host-status')).toBe('Conectado · DevBar 0.11.0');
      expect(byId('stop-all').querySelector('svg')).not.toBeNull();
    });

    it('totals the errors and warnings of every service', async () => {
      await startLinked();

      expect(text('error-chip')).toBe('1 error');
      expect(text('warn-chip')).toBe('2 warnings');
    });

    it('hides the totals when everything is clean', async () => {
      await startLinked(state({ groups: [] }));

      expect(byId('error-chip').hidden).toBe(true);
      expect(byId('warn-chip').hidden).toBe(true);
      expect(byId('groups-empty').hidden).toBe(false);
    });
  });

  describe('group cards', () => {
    it('summarises each group and opens only the first one', async () => {
      await startLinked();

      const [backend, docs] = cards();
      expect(rowText(backend, '.group-name')).toBe('Backend');
      expect(rowText(backend, '.group-sub')).toBe('1/2 en marcha · main');
      expect(rowText(docs, '.group-sub')).toBe('0/1 en marcha');
      expect(headOf(backend)?.getAttribute('aria-expanded')).toBe('true');
      expect(headOf(docs)?.getAttribute('aria-expanded')).toBe('false');
      expect(docs?.querySelector('.group-body')).toBeNull();
    });

    it('opens one group at a time', async () => {
      await startLinked();

      tap(headOf(cards()[1]));

      expect(headOf(cards()[0])?.getAttribute('aria-expanded')).toBe('false');
      expect(headOf(cards()[1])?.getAttribute('aria-expanded')).toBe('true');
      tap(headOf(cards()[1]));
      expect(headOf(cards()[1])?.getAttribute('aria-expanded')).toBe('false');
    });

    it('describes each service, its counts and how long it has been up', async () => {
      await startLinked();

      const [api, jobs] = rowsOf(cards()[0]);
      expect(rowText(api, '.command-name')).toBe('API');
      expect(rowText(api, '.badge')).toBe('2 warnings');
      expect(rowText(api, '.command-sub')).toBe('En marcha · 1h 12m');
      expect(rowText(jobs, '.command-sub')).toBe('Detenido');
      tap(headOf(cards()[1]));
      const [astro] = rowsOf(cards()[1]);
      expect(rowText(astro, '.badge')).toBe('1 error');
      expect(rowText(astro, '.command-sub')).toBe('Error · mira los logs');
    });

    it('keeps the uptime ticking between state pushes', async () => {
      const h = await startLinked();

      h.advance(60 * 60_000);
      h.beat();

      expect(rowText(rowsOf(cards()[0])[0], '.command-sub')).toBe(
        'En marcha · 2h 12m',
      );
    });

    it('repaints when the computer pushes a new state', async () => {
      const h = await startLinked();
      const next = state();
      const api = next.groups[0]?.commands[0];
      if (api) Object.assign(api, { status: 'stopped', color: 'stopped' });

      h.source().emit('state', next);

      expect(rowText(rowsOf(cards()[0])[0], '.command-sub')).toBe('Detenido');
      expect(headOf(cards()[0])?.getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('starting and stopping', () => {
    it('stops a running service and starts a stopped one', async () => {
      const h = await startLinked();
      h.answer('POST /api/process/stop', { status: 200, body: { ok: true } });
      h.answer('POST /api/process/start', { status: 200, body: { ok: true } });

      tap(buttonNamed('Detener API'));
      await settle();
      tap(buttonNamed('Iniciar Cola de jobs'));
      await settle();

      expect(h.callsTo('/api/process/stop')[0]).toMatchObject({
        method: 'POST',
        headers: { 'X-DevBar-Request': '1' },
        body: { processId: 'cmd:g1:api' },
      });
      expect(h.callsTo('/api/process/start')[0]?.body).toEqual({
        processId: 'cmd:g1:jobs',
      });
    });

    it('says why a start failed', async () => {
      const h = await startLinked();
      h.answer('POST /api/process/start', {
        status: 200,
        body: { ok: false, error: 'Port 3000 in use' },
      });

      tap(buttonNamed('Iniciar Cola de jobs'));
      await settle();

      expect(text('toast')).toBe('Port 3000 in use');
    });

    it('waits for the confirmation of a start that asks first', async () => {
      const h = await startLinked();
      h.answer('POST /api/process/start', {
        status: 202,
        body: { pending: true },
      });

      tap(buttonNamed('Iniciar Cola de jobs'));
      await settle();

      expect(text('toast')).toBe('Pendiente de confirmación');
    });

    it('says so when DevBar cannot be reached', async () => {
      const h = await startLinked();
      h.answer('POST /api/process/start', new Error('offline'));

      tap(buttonNamed('Iniciar Cola de jobs'));
      await settle();

      expect(text('toast')).toBe('No se pudo conectar con DevBar.');
    });

    it('runs an action from its chip', async () => {
      const h = await startLinked();
      h.answer('POST /api/actions/run', { status: 200, body: { ok: true } });

      tap(buttonNamed('Ejecutar Seed de datos'));
      await settle();

      expect(h.callsTo('/api/actions/run')[0]?.body).toEqual({
        groupId: 'g1',
        actionId: 'seed',
      });
    });

    it('runs the pipeline and shows it running', async () => {
      const h = await startLinked();
      h.answer('POST /api/pipeline/run', {
        status: 202,
        body: { pending: true },
      });

      tapId('run-pipeline');
      await settle();
      h.source().emit(
        'state',
        state({
          pipeline: {
            status: 'running',
            currentStep: 1,
            totalSteps: 2,
            lastError: null,
          },
        }),
      );

      expect(h.callsTo('/api/pipeline/run')).toHaveLength(1);
      expect(text('pipeline-label')).toBe('Pipeline en curso · paso 1 de 2');
      expect(byId<HTMLButtonElement>('run-pipeline').disabled).toBe(true);
    });

    it('hides the pipeline button when there is no pipeline', async () => {
      await startLinked(
        state({
          pipeline: {
            status: 'idle',
            currentStep: null,
            totalSteps: 0,
            lastError: null,
          },
        }),
      );

      expect(byId('run-pipeline').hidden).toBe(true);
    });

    it('asks before stopping everything', async () => {
      const h = await startLinked();
      h.refuseConfirm();

      tapId('stop-all');
      await settle();

      expect(h.confirms).toHaveLength(1);
      expect(h.callsTo('/api/stop-all')).toEqual([]);
    });

    it('stops everything once confirmed', async () => {
      const h = await startLinked();
      h.answer('POST /api/stop-all', {
        status: 200,
        body: { ok: true, stopped: 2 },
      });

      tapId('stop-all');
      await settle();

      expect(h.callsTo('/api/stop-all')).toHaveLength(1);
      expect(text('toast')).toBe('2 servicios detenidos');
    });

    it('opens the logs of a service', async () => {
      const h = await startLinked();
      h.answer('GET /api/logs', {
        status: 200,
        body: { id: 'cmd:g1:api', seq: 0, lines: [] },
      });

      tap(buttonNamed('Ver logs de API'));
      await settle();

      expect(visibleTab()).toBe('logs');
      expect(byId<HTMLSelectElement>('log-process').value).toBe('cmd:g1:api');
    });
  });

  describe('banners', () => {
    it('points at a pending confirmation', async () => {
      const h = await startLinked();

      h.source().emit('state', state({ confirms: [CONFIRM] }));

      expect(byId('confirm-banner').hidden).toBe(false);
      expect(text('confirm-banner-title')).toBe('¿Ejecutar «migrate»?');
      expect(text('confirm-banner-sub')).toBe(
        'Backend · esperando respuesta · 0:42',
      );
    });

    it('offers a staged update, which is installed from «Ajustes»', async () => {
      await startLinked(
        state({
          update: {
            currentVersion: '0.11.0',
            state: 'ready',
            version: '0.12.0',
          },
        }),
      );

      expect(text('update-banner-title')).toBe('DevBar 0.12.0 disponible');
      tapId('update-banner');
      expect(visibleTab()).toBe('settings');
    });
  });

  describe('branches', () => {
    it('lists the branches and switches to the one picked', async () => {
      const h = await startLinked();
      h.answer('GET /api/branches', {
        status: 200,
        body: { ok: true, branches: ['main', 'feat/x'] },
      });
      h.answer('POST /api/branch', { status: 200, body: { ok: true } });

      tap(buttonNamed('Cambiar de rama, actual main'));
      await settle();
      expect(byId<HTMLDialogElement>('branch-sheet').open).toBe(true);
      const picks = [
        ...document.querySelectorAll<HTMLButtonElement>('#branch-list button'),
      ];
      expect(picks.map((b) => b.textContent?.trim())).toEqual([
        'main',
        'feat/x',
      ]);
      expect(picks[0]?.getAttribute('aria-current')).toBe('true');

      tap(picks[1]);
      await settle();

      expect(h.callsTo('/api/branch')[0]?.body).toEqual({
        groupId: 'g1',
        branch: 'feat/x',
      });
      expect(byId<HTMLDialogElement>('branch-sheet').open).toBe(false);
    });

    it('keeps the sheet open with the reason a switch failed', async () => {
      const h = await startLinked();
      h.answer('GET /api/branches', {
        status: 200,
        body: { ok: true, branches: ['main', 'feat/x'] },
      });
      h.answer('POST /api/branch', {
        status: 200,
        body: { ok: false, error: 'Working tree has uncommitted changes' },
      });

      tap(buttonNamed('Cambiar de rama, actual main'));
      await settle();
      tap(document.querySelectorAll('#branch-list button')[1]);
      await settle();

      expect(byId<HTMLDialogElement>('branch-sheet').open).toBe(true);
      expect(text('branch-status')).toBe(
        'Working tree has uncommitted changes',
      );
    });

    it('explains a branch list that could not be read', async () => {
      const h = await startLinked();
      h.answer('GET /api/branches', {
        status: 200,
        body: { ok: false, branches: [], error: 'not a git repository' },
      });

      tap(buttonNamed('Cambiar de rama, actual main'));
      await settle();

      expect(text('branch-status')).toBe('not a git repository');
      tapId('branch-close');
      expect(byId<HTMLDialogElement>('branch-sheet').open).toBe(false);
    });
  });

  describe('the connection', () => {
    it('says it is reconnecting while the stream is down', async () => {
      const h = await startLinked();

      h.source().emit('error');

      expect(byId('reconnecting').hidden).toBe(false);
      expect(text('host-status')).toBe('Reconectando…');
    });

    it('reconnects and repaints once DevBar is back', async () => {
      const h = await startLinked();
      h.source().emit('error');

      await h.tick();
      h.source().emit('open');

      expect(h.sources).toHaveLength(2);
      expect(byId('reconnecting').hidden).toBe(true);
      expect(text('host-status')).toBe('Conectado · DevBar 0.11.0');
    });

    it('reloads the page when DevBar came back updated', async () => {
      const h = await startLinked();
      h.answer('GET /api/me', {
        status: 200,
        body: {
          linked: true,
          device: { id: 'd1', name: 'iPhone de Ana', createdAt: 1 },
          host: { name: 'Mac-de-Ana', version: '0.12.0' },
        },
      });
      h.source().emit('error');

      await h.tick();

      expect(h.reloads()).toBe(1);
    });

    it('lands on the unlinked view when the computer unlinks it', async () => {
      const h = await startLinked();

      h.source().emit('unlinked', {});

      expect(visibleView()).toBe('unlinked');
    });

    it('shows the reconnecting state when the first read fails', async () => {
      const { loadPage, pageHarness, start, LINKED } =
        await import('./helpers/remote-page.js');
      loadPage();
      const h = pageHarness();
      h.answer('GET /api/me', LINKED);
      h.answer('GET /api/state', new Error('offline'));
      h.answer('GET /api/notices', new Error('offline'));

      await start(h);

      expect(visibleView()).toBe('linked');
      expect(byId('reconnecting').hidden).toBe(false);
    });
  });
});
