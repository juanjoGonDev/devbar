// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  byId,
  CONFIRM,
  NOW,
  settle,
  startLinked,
  state,
  tabButton,
  tap,
  tapId,
  text,
} from './helpers/remote-page.js';

/**
 * «Avisos»: the notices DevBar showed lately, grouped by day, with this
 * device's own read marks — and the pending confirmation, answerable inline.
 */

const DAY = 86_400_000;
const NOTICES = [
  {
    id: 3,
    ts: NOW - 60_000,
    kind: 'error',
    title: 'Docs · Astro exited 1',
    body: '',
  },
  {
    id: 2,
    ts: NOW - 2 * 60_000,
    kind: 'update',
    title: 'Actualización',
    body: 'v0.12.0 lista.',
  },
  {
    id: 1,
    ts: NOW - DAY,
    kind: 'scheduled',
    title: 'Acción programada',
    body: 'Backend · Backup: completada',
  },
];

async function withNotices(options: Parameters<typeof startLinked>[1] = {}) {
  const { loadPage, pageHarness, start, LINKED } =
    await import('./helpers/remote-page.js');
  loadPage();
  const h = pageHarness('/', options);
  h.seedKeys();
  h.answer('me', LINKED);
  h.answer('state', { status: 200, body: state() });
  h.answer('notices', { status: 200, body: { notices: NOTICES } });
  await start(h);
  h.source().emit('open');
  return h;
}

const items = () => [
  ...document.querySelectorAll<HTMLElement>('#notices .notice'),
];
const headings = () =>
  [...document.querySelectorAll('#notices .day-title')].map(
    (n) => n.textContent,
  );
const badge = () => byId('unread-badge');

describe('renderer/remote/notices-tab.ts', () => {
  it('lists the notices by day, newest first, with their kind and time', async () => {
    await withNotices();
    tap(tabButton('notices'));

    expect(headings()).toEqual(['Hoy', 'Ayer']);
    expect(
      items().map((item) => item.querySelector('.notice-title')?.textContent),
    ).toEqual(['Docs · Astro exited 1', 'Actualización', 'Acción programada']);
    expect(items()[0]?.classList.contains('is-error')).toBe(true);
    expect(items()[0]?.querySelector('.notice-time')?.textContent).toBe(
      '10:11',
    );
    expect(items()[0]?.querySelector('svg')).not.toBeNull();
    expect(items()[2]?.querySelector('.notice-body')?.textContent).toBe(
      'Backend · Backup: completada',
    );
  });

  it('counts what this device has not read yet on the tab', async () => {
    await withNotices();

    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('3');
    expect(tabButton('notices').getAttribute('aria-label')).toBe(
      'Avisos, 3 sin leer',
    );
    expect(
      items().filter((i) => i.classList.contains('is-unread')),
    ).toHaveLength(3);
  });

  it('marks everything read, and remembers it on this device', async () => {
    const storage = new Map<string, string>();
    await withNotices({ storage });

    tapId('mark-read');

    expect(badge().hidden).toBe(true);
    expect(tabButton('notices').getAttribute('aria-label')).toBe('Avisos');
    expect(
      [...storage.keys()].filter((key) => key.startsWith('devbar-remote:')),
    ).toEqual(['devbar-remote:read:d1']);

    await withNotices({ storage });
    expect(badge().hidden).toBe(true);
  });

  it('still works when the browser refuses storage', async () => {
    await withNotices({ storage: 'broken' });

    tapId('mark-read');

    expect(badge().hidden).toBe(true);
  });

  it('adds a notice the moment it arrives', async () => {
    const h = await withNotices();
    tapId('mark-read');

    h.source().emit('notice', {
      id: 4,
      ts: NOW,
      kind: 'success',
      title: 'Pre-scripts',
      body: 'Pipeline completado (2 pasos)',
    });

    expect(badge().textContent).toBe('1');
    tap(tabButton('notices'));
    expect(items()[0]?.querySelector('.notice-title')?.textContent).toBe(
      'Pre-scripts',
    );
  });

  it('says when there is nothing yet', async () => {
    await startLinked();
    tap(tabButton('notices'));

    expect(byId('notices-empty').hidden).toBe(false);
  });

  describe('the pending confirmation', () => {
    it('can be answered right here, with its countdown', async () => {
      const h = await startLinked(state({ confirms: [CONFIRM] }));
      byId<HTMLDialogElement>('confirm-dialog').close();
      h.answer('confirm', { status: 200, body: { ok: true } });
      tap(tabButton('notices'));

      expect(byId('confirm-card').hidden).toBe(false);
      expect(text('confirm-card-group')).toBe('Backend');
      expect(text('confirm-card-title')).toBe('¿Ejecutar «migrate»?');
      expect(text('confirm-card-cancel')).toBe('Cancelar (42s)');
      expect(text('confirm-card-run')).toBe('Ejecutar');
      expect(text('confirm-card-note')).toBe(
        'También aparece en Mac-de-Ana. Vale la primera respuesta.',
      );
      expect(badge().textContent).toBe('1');

      tapId('confirm-card-run');
      await settle();

      expect(h.callsTo('confirm')[0]?.body).toEqual({
        token: 't1',
        decision: 'confirm',
      });
    });

    it('goes away once it is answered anywhere', async () => {
      const h = await startLinked(state({ confirms: [CONFIRM] }));

      h.source().emit('confirm', { now: NOW, confirms: [] });

      expect(byId('confirm-card').hidden).toBe(true);
    });
  });
});
