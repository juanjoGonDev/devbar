// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  byId,
  NOW,
  settle,
  startLinked,
  state,
  tabButton,
  tap,
  tapId,
  text,
  type PageHarness,
} from './helpers/remote-page.js';

/**
 * «Logs»: one process at a time, its tail first, then live lines over the
 * event stream — subscribed only while the tab is on screen.
 */

const line = (
  seq: number,
  msg: string,
  level: 'warn' | 'error' | null = null,
) => ({
  seq,
  ts: NOW + seq * 1000,
  level,
  line: msg,
});

const TAIL = {
  id: 'cmd:g1:api',
  seq: 3,
  lines: [
    line(1, 'ready'),
    line(2, 'careful', 'warn'),
    line(3, 'boom', 'error'),
  ],
};

async function openLogs(h: PageHarness, tail: unknown = TAIL): Promise<void> {
  h.answer('GET /api/logs', { status: 200, body: tail });
  tap(tabButton('logs'));
  await settle();
}

const shown = (): string[] =>
  [...document.querySelectorAll('#log-panel .log-line .msg')].map(
    (node) => node.textContent ?? '',
  );
const select = () => byId<HTMLSelectElement>('log-process');

describe('renderer/remote/logs-tab.ts', () => {
  it('offers every command and action, grouped, and starts on a running one', async () => {
    const h = await startLinked();
    await openLogs(h);

    const groups = [...select().querySelectorAll('optgroup')];
    expect(groups.map((g) => g.label)).toEqual(['Backend', 'Docs']);
    expect([...select().options].map((o) => o.textContent)).toEqual([
      'API',
      'Cola de jobs',
      'Seed de datos',
      'Astro dev',
    ]);
    expect(select().value).toBe('cmd:g1:api');
  });

  it('shows the tail with its times and levels', async () => {
    const h = await startLinked();
    await openLogs(h);

    expect(h.callsTo('/api/logs?id=cmd%3Ag1%3Aapi&tail=300')).toHaveLength(1);
    expect(shown()).toEqual(['ready', 'careful', 'boom']);
    const rows = document.querySelectorAll('#log-panel .log-line');
    expect(rows[0]?.querySelector('.ts')?.textContent).toBe('10:12:41');
    expect(rows[1]?.classList.contains('is-warn')).toBe(true);
    expect(rows[2]?.classList.contains('is-error')).toBe(true);
  });

  it('subscribes to the live lines only while the tab is open', async () => {
    const h = await startLinked();
    await openLogs(h);
    expect(h.source().url).toBe('/api/events?logs=cmd%3Ag1%3Aapi');

    tap(tabButton('groups'));

    expect(h.source().url).toBe('/api/events');
  });

  it('appends live lines once, after the tail it already has', async () => {
    const h = await startLinked();
    await openLogs(h);

    h.source().emit('log', {
      id: 'cmd:g1:api',
      lines: [line(3, 'boom', 'error'), line(4, 'again')],
    });
    h.source().emit('log', { id: 'cmd:g1:other', lines: [line(9, 'no')] });

    expect(shown()).toEqual(['ready', 'careful', 'boom', 'again']);
  });

  it('filters by level, with the counts of each', async () => {
    const h = await startLinked();
    await openLogs(h);

    expect(text('count-all')).toBe('3');
    expect(text('count-warn')).toBe('1');
    expect(text('count-error')).toBe('1');
    tap(document.querySelector('[data-filter="warn"]'));

    expect(shown()).toEqual(['careful']);
    expect(
      document
        .querySelector('[data-filter="warn"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('says when a filter leaves nothing', async () => {
    const h = await startLinked();
    await openLogs(h, { id: 'cmd:g1:api', seq: 1, lines: [line(1, 'ready')] });

    tap(document.querySelector('[data-filter="error"]'));

    expect(byId('log-empty').hidden).toBe(false);
    expect(text('log-empty')).toBe('Sin errores en este proceso.');
    tap(document.querySelector('[data-filter="warn"]'));
    expect(text('log-empty')).toBe('Sin warnings en este proceso.');
  });

  it('says a stopped process with no lines has to be started', async () => {
    const h = await startLinked();
    await openLogs(h, { id: 'cmd:g1:api', seq: 0, lines: [] });
    h.answer('GET /api/logs', {
      status: 200,
      body: { id: 'cmd:g1:jobs', seq: 0, lines: [] },
    });

    select().value = 'cmd:g1:jobs';
    select().dispatchEvent(new Event('change'));
    await settle();

    expect(text('log-empty')).toBe(
      'Proceso detenido. Inícialo para ver sus logs.',
    );
    expect(h.source().url).toBe('/api/events?logs=cmd%3Ag1%3Ajobs');
  });

  it('stops following the tail while the user reads further up', async () => {
    const h = await startLinked();
    await openLogs(h);
    const panel = byId('log-panel');
    Object.defineProperty(panel, 'scrollHeight', {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(panel, 'clientHeight', {
      value: 400,
      configurable: true,
    });
    // jsdom has no layout: give the panel a scroll position it keeps.
    Object.defineProperty(panel, 'scrollTop', {
      value: 100,
      writable: true,
      configurable: true,
    });
    panel.dispatchEvent(new Event('scroll'));

    h.source().emit('log', { id: 'cmd:g1:api', lines: [line(4, 'more')] });

    expect(panel.scrollTop).toBe(100);
    expect(byId('log-follow').hidden).toBe(false);
    tapId('log-follow');
    expect(panel.scrollTop).toBe(2000);
    expect(byId('log-follow').hidden).toBe(true);
  });

  it('restarts a command: stop, then start', async () => {
    const h = await startLinked();
    await openLogs(h);
    h.answer('POST /api/process/stop', { status: 200, body: { ok: true } });
    h.answer('POST /api/process/start', { status: 200, body: { ok: true } });

    tapId('log-restart');
    await settle();

    expect(
      h.calls.filter((c) => c.method === 'POST').map((c) => c.url),
    ).toEqual(['/api/process/stop', '/api/process/start']);
  });

  it('offers to stop a running process and to start a stopped one', async () => {
    const h = await startLinked();
    await openLogs(h);
    h.answer('POST /api/process/stop', { status: 200, body: { ok: true } });

    expect(text('log-toggle')).toBe('Detener');
    tapId('log-toggle');
    await settle();
    const next = state();
    const api = next.groups[0]?.commands[0];
    if (api) Object.assign(api, { status: 'stopped', color: 'stopped' });
    h.source().emit('state', next);

    expect(h.callsTo('/api/process/stop')).toHaveLength(1);
    expect(text('log-toggle')).toBe('Iniciar');
  });

  it('runs an action again from «Reiniciar»', async () => {
    const h = await startLinked();
    await openLogs(h);
    h.answer('GET /api/logs', {
      status: 200,
      body: { id: 'act:g1:seed', seq: 0, lines: [] },
    });
    h.answer('POST /api/actions/run', { status: 200, body: { ok: true } });
    select().value = 'act:g1:seed';
    select().dispatchEvent(new Event('change'));
    await settle();

    tapId('log-restart');
    await settle();

    expect(h.callsTo('/api/actions/run')[0]?.body).toEqual({
      groupId: 'g1',
      actionId: 'seed',
    });
    expect(text('log-toggle')).toBe('Iniciar');
  });

  it('says so when the tail cannot be read', async () => {
    const h = await startLinked();
    h.answer('GET /api/logs', new Error('offline'));

    tap(tabButton('logs'));
    await settle();

    expect(text('log-empty')).toBe('No se pudieron leer los logs.');
  });
});
