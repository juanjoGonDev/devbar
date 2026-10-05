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
 * The confirmation modal: whenever a script asks «¿Ejecutar …?» on the
 * computer, the phone asks too — whatever tab it is on — and the first
 * answer, from either side, is the one that counts.
 */

const dialog = () => byId<HTMLDialogElement>('confirm-dialog');

describe('renderer/remote/confirm-dialog.ts', () => {
  it('asks as the desktop modal does, from any tab', async () => {
    const h = await startLinked();
    tap(tabButton('settings'));
    h.answer('settings.get', { status: 200, body: {} });

    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });

    expect(dialog().open).toBe(true);
    expect(text('confirm-group')).toBe('Backend');
    expect(text('confirm-title')).toBe('¿Ejecutar «migrate»?');
    expect(text('confirm-command')).toBe('pnpm db:migrate');
    expect(text('confirm-footer')).toBe(
      'También en Mac-de-Ana · vale la primera respuesta',
    );
  });

  it('counts down on the button that wins at the timeout', async () => {
    const h = await startLinked();
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });

    expect(text('confirm-cancel')).toBe('Cancelar (42s)');
    expect(text('confirm-run')).toBe('Ejecutar');
    h.advance(2_000);
    h.beat();
    expect(text('confirm-cancel')).toBe('Cancelar (40s)');
  });

  it('counts from the computer clock, not the phone one', async () => {
    const h = await startLinked();

    h.source().emit('confirm', {
      now: NOW + 10_000,
      confirms: [{ ...CONFIRM, onTimeout: 'confirm' }],
    });

    expect(text('confirm-run')).toBe('Ejecutar (32s)');
    expect(text('confirm-cancel')).toBe('Cancelar');
  });

  it('shows no countdown for a confirmation that waits forever', async () => {
    const h = await startLinked();

    h.source().emit('confirm', {
      now: NOW,
      confirms: [{ ...CONFIRM, secs: null, deadline: null }],
    });

    expect(text('confirm-cancel')).toBe('Cancelar');
  });

  it('answers and closes', async () => {
    const h = await startLinked();
    h.answer('confirm', { status: 200, body: { ok: true } });
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });

    tapId('confirm-run');
    await settle();

    expect(h.callsTo('confirm')[0]?.body).toEqual({
      token: 't1',
      decision: 'confirm',
    });
    expect(dialog().open).toBe(false);
  });

  it('says so when someone else answered first', async () => {
    const h = await startLinked();
    h.answer('confirm', {
      status: 409,
      body: { error: 'already-answered' },
    });
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });

    tapId('confirm-cancel');
    await settle();

    expect(text('confirm-closed')).toBe('Ya se había respondido.');
    await h.tick();
    expect(dialog().open).toBe(false);
  });

  it('closes with a note when the computer answers first', async () => {
    const h = await startLinked();
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });

    h.source().emit('confirm', { now: NOW, confirms: [] });

    expect(text('confirm-closed')).toBe('Se respondió en Mac-de-Ana.');
    expect(byId<HTMLButtonElement>('confirm-run').disabled).toBe(true);
    await h.tick();
    expect(dialog().open).toBe(false);
  });

  it('asks about the next one queued behind, once the first is settled', async () => {
    const h = await startLinked();
    h.answer('confirm', { status: 200, body: { ok: true } });
    const second = { ...CONFIRM, token: 't2', name: 'seed' };
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM, second] });

    tapId('confirm-run');
    await settle();

    expect(dialog().open).toBe(true);
    expect(text('confirm-title')).toBe('¿Ejecutar «seed»?');
    h.source().emit('confirm', { now: NOW, confirms: [second] });
    expect(text('confirm-title')).toBe('¿Ejecutar «seed»?');
  });

  it('moves on to the next one when the computer settled the first', async () => {
    const h = await startLinked();
    const second = { ...CONFIRM, token: 't2', name: 'seed' };
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM, second] });

    h.source().emit('confirm', { now: NOW, confirms: [second] });
    await h.tick();

    expect(dialog().open).toBe(true);
    expect(text('confirm-title')).toBe('¿Ejecutar «seed»?');
  });

  it('does not ask again about one the user dismissed, but asks about the next', async () => {
    const h = await startLinked();
    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });
    dialog().close();

    h.source().emit('confirm', { now: NOW, confirms: [CONFIRM] });
    expect(dialog().open).toBe(false);

    h.source().emit('confirm', {
      now: NOW,
      confirms: [{ ...CONFIRM, token: 't2', name: 'seed' }],
    });
    expect(dialog().open).toBe(true);
    expect(text('confirm-title')).toBe('¿Ejecutar «seed»?');
  });

  it('opens from the banner of «Grupos» after a dismissal', async () => {
    const h = await startLinked();
    h.source().emit('state', state({ confirms: [CONFIRM] }));
    dialog().close();

    tapId('confirm-banner');

    expect(dialog().open).toBe(true);
  });
});
