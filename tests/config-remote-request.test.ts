// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  RemotePairRequest,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * «¿Vincular este dispositivo?» (renderer/config/remote-request-dialog.ts):
 * the desktop half of pairing. The six digits are shown on the phone only;
 * the user types them here, main compares them, and «Vincular» stays off
 * until they match. Three wrong codes reject the request.
 */

const QR = {
  size: 3,
  modules: [true, false, true, false, true, false, true, false, true],
};
const ON = { enabled: true, listening: true };

function status(extra: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: false,
    autoUnlink: true,
    notifyConnections: true,
    port: 47821,
    listening: false,
    error: null,
    keyError: null,
    addresses: ['192.168.1.20'],
    devices: [],
    ...extra,
  };
}

const REQUEST: RemotePairRequest = {
  requestId: 'r1',
  name: 'iPhone de Ana',
  client: 'Safari · iOS',
  ip: '192.168.1.40',
  expiresAt: 0,
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}
const text = (id: string): string => el(id).textContent?.trim() ?? '';
const dialogOpen = (id: string): boolean => el<HTMLDialogElement>(id).open;
const click = (target: Element | null): void => {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const codeInput = (): HTMLInputElement =>
  el<HTMLInputElement>('remote-request-code');
const accept = (): HTMLButtonElement =>
  el<HTMLButtonElement>('remote-request-accept');
const type = (value: string): void => {
  codeInput().value = value;
  codeInput().dispatchEvent(new Event('input', { bubbles: true }));
};

async function withRequest(): Promise<RendererWindow> {
  const win = await openConfigWindow();
  await win.settle('getRemoteStatus', status(ON));
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  click(el('remote-add-device'));
  await win.settle('startRemotePairing', {
    ok: true,
    url: 'u',
    expiresAt: Date.now() + 5 * 60_000,
    qr: QR,
  });
  await win.push('onRemotePairRequest', {
    ...REQUEST,
    expiresAt: Date.now() + 60_000,
  });
  return win;
}

/** Types the six digits and lets main say they match. */
async function matched(win: RendererWindow): Promise<void> {
  type('482 913');
  await win.settle('checkRemotePairCode', {
    ok: true,
    match: true,
    attemptsLeft: 3,
  });
}

describe('renderer/config/remote-request-dialog.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  it('asks for the code the phone shows, and «Vincular» starts off', async () => {
    win = await withRequest();

    expect(dialogOpen('remote-request-dialog')).toBe(true);
    expect(text('remote-request-name')).toBe('iPhone de Ana');
    expect(text('remote-request-meta')).toBe('Safari · iOS · 192.168.1.40');
    expect(
      document.querySelector('label[for="remote-request-code"]')?.textContent,
    ).toContain('Escribe el código que muestra el móvil');
    expect(codeInput().value).toBe('');
    expect(accept().disabled).toBe(true);
    expect(text('remote-request-countdown')).toBe(
      'Se rechazará automáticamente en 1:00',
    );
    expect(el('remote-qr').classList.contains('is-used')).toBe(true);
  });

  it('asks main only once six digits are typed, and enables «Vincular» on a match', async () => {
    win = await withRequest();

    type('482 91');
    expect(win.callCount('checkRemotePairCode')).toBe(0);
    await matched(win);

    expect(win.argsFor('checkRemotePairCode')).toEqual([['r1', '482913']]);
    expect(accept().disabled).toBe(false);
    expect(el('remote-request-code-error').hidden).toBe(true);
  });

  it('links with the digits that matched, and closes both dialogs once main confirms', async () => {
    win = await withRequest();
    await matched(win);

    click(accept());
    await win.settle('respondRemotePairing', { ok: true });
    await win.push('onRemotePairRequestClosed', {
      requestId: 'r1',
      outcome: 'accepted',
    });

    expect(win.argsFor('respondRemotePairing')).toEqual([
      ['r1', true, '482913'],
    ]);
    expect(dialogOpen('remote-request-dialog')).toBe(false);
    expect(dialogOpen('remote-pair-dialog')).toBe(false);
  });

  it('links with Enter once the digits matched, not before', async () => {
    win = await withRequest();
    const enter = () =>
      codeInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );

    type('48');
    enter();
    expect(win.callCount('respondRemotePairing')).toBe(0);
    await matched(win);
    enter();

    expect(win.argsFor('respondRemotePairing')).toEqual([
      ['r1', true, '482913'],
    ]);
  });

  it('says how many tries are left after a wrong code, and clears it', async () => {
    win = await withRequest();

    type('000000');
    await win.settle('checkRemotePairCode', {
      ok: true,
      match: false,
      attemptsLeft: 2,
    });

    expect(text('remote-request-code-error')).toBe(
      'El código no coincide. Te quedan 2 intentos.',
    );
    expect(codeInput().value).toBe('');
    expect(accept().disabled).toBe(true);

    type('111111');
    await win.settle('checkRemotePairCode', {
      ok: true,
      match: false,
      attemptsLeft: 1,
    });
    expect(text('remote-request-code-error')).toBe(
      'El código no coincide. Te queda 1 intento.',
    );
  });

  it('turns «Vincular» off again when the digits change after a match', async () => {
    win = await withRequest();
    await matched(win);

    type('48291');

    expect(accept().disabled).toBe(true);
  });

  it('closes when the third wrong code rejects the request, with a fresh QR', async () => {
    win = await withRequest();

    type('000000');
    await win.settle('checkRemotePairCode', {
      ok: true,
      match: false,
      attemptsLeft: 0,
    });
    await win.push('onRemotePairRequestClosed', {
      requestId: 'r1',
      outcome: 'rejected',
    });

    expect(dialogOpen('remote-request-dialog')).toBe(false);
    expect(win.callCount('respondRemotePairing')).toBe(0);
    expect(dialogOpen('remote-pair-dialog')).toBe(true);
    expect(win.callCount('startRemotePairing')).toBe(2);
  });

  it('rejects on «Rechazar», no digits needed', async () => {
    win = await withRequest();

    click(el('remote-request-reject'));
    await win.settle('respondRemotePairing', { ok: true });

    expect(win.argsFor('respondRemotePairing')).toEqual([['r1', false, '']]);
    expect(dialogOpen('remote-request-dialog')).toBe(false);
  });

  it('treats Escape as a rejection', async () => {
    win = await withRequest();

    el('remote-request-dialog').dispatchEvent(
      new Event('cancel', { cancelable: true }),
    );
    await win.settle('respondRemotePairing', { ok: true });

    expect(win.argsFor('respondRemotePairing')).toEqual([['r1', false, '']]);
    expect(dialogOpen('remote-request-dialog')).toBe(false);
  });

  it('closes by itself when the request expires, without answering', async () => {
    win = await withRequest();

    vi.advanceTimersByTime(30_000);
    expect(text('remote-request-countdown')).toBe(
      'Se rechazará automáticamente en 0:30',
    );
    await win.push('onRemotePairRequestClosed', {
      requestId: 'r1',
      outcome: 'expired',
    });

    expect(dialogOpen('remote-request-dialog')).toBe(false);
    expect(win.callCount('respondRemotePairing')).toBe(0);
  });

  it('reports an answer main could not deliver', async () => {
    win = await withRequest();
    await matched(win);

    click(accept());
    await win.settle('respondRemotePairing', {
      ok: false,
      error: 'La solicitud ya no está pendiente.',
    });

    expect(text('toast')).toBe('La solicitud ya no está pendiente.');
    expect(dialogOpen('remote-request-dialog')).toBe(false);
  });

  it('starts clean for the next request', async () => {
    win = await withRequest();
    await matched(win);
    await win.push('onRemotePairRequestClosed', {
      requestId: 'r1',
      outcome: 'cancelled',
    });

    await win.push('onRemotePairRequest', {
      ...REQUEST,
      requestId: 'r2',
      expiresAt: Date.now() + 60_000,
    });

    expect(codeInput().value).toBe('');
    expect(accept().disabled).toBe(true);
  });
});
