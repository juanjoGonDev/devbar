// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { startLinked, state, tap } from './helpers/remote-page.js';
import type {
  RemotePortView,
  RemoteStateView,
} from '../src/ipc-contract/remote-wire.js';

/**
 * The port pill on a «Grupos» service row: what the phone can open on the
 * computer it reached (`http://<that host>:<port>/`), and why it cannot when
 * the server only listens on the computer itself.
 */

/** The fixture with the running «API» service listening on `ports`. */
function withPorts(ports: RemotePortView[]): RemoteStateView {
  const initial = state();
  const api = initial.groups[0]?.commands[0];
  if (!api) throw new Error('fixture lost its API service');
  api.ports = ports;
  return initial;
}

const apiRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#groups .command-row');
const pillOf = (row: HTMLElement | null) =>
  row?.querySelector<HTMLElement>('.port-pill') ?? null;

describe('renderer/remote/groups-tab.ts ports', () => {
  it('links a reachable web port to the host the phone reached', async () => {
    await startLinked(
      withPorts([{ port: 3000, kind: 'web', lanReachable: true }]),
    );

    const pill = pillOf(apiRow());
    expect(pill?.tagName).toBe('A');
    expect(pill?.getAttribute('href')).toBe('http://192.168.1.20:3000/');
    expect(pill?.getAttribute('target')).toBe('_blank');
    expect(pill?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(pill?.textContent).toBe(':3000');
    expect(pill?.querySelector('svg')).not.toBeNull();
  });

  it('links an HTTP API the same way', async () => {
    await startLinked(
      withPorts([{ port: 8080, kind: 'http', lanReachable: true }]),
    );

    expect(pillOf(apiRow())?.getAttribute('href')).toBe(
      'http://192.168.1.20:8080/',
    );
  });

  it('mutes a port only the computer can reach, and says why on tap', async () => {
    await startLinked(
      withPorts([{ port: 3000, kind: 'web', lanReachable: false }]),
    );

    const pill = pillOf(apiRow());
    expect(pill?.tagName).toBe('BUTTON');
    expect(pill?.classList.contains('is-muted')).toBe(true);
    expect(pill?.getAttribute('href')).toBeNull();
    expect(apiRow()?.querySelector('.port-note')).toBeNull();

    tap(pill);

    expect(apiRow()?.querySelector('.port-note')?.textContent).toBe(
      'Solo accesible desde el equipo',
    );
    expect(pillOf(apiRow())?.getAttribute('aria-expanded')).toBe('true');
    tap(pillOf(apiRow()));
    expect(apiRow()?.querySelector('.port-note')).toBeNull();
  });

  it('shows a port that is not web as plain muted text', async () => {
    await startLinked(
      withPorts([{ port: 5432, kind: 'other', lanReachable: true }]),
    );

    const pill = pillOf(apiRow());
    expect(pill?.tagName).toBe('SPAN');
    expect(pill?.textContent).toBe(':5432');
    expect(pill?.classList.contains('is-muted')).toBe(true);
  });

  it('prefers the first web port over a database before it', async () => {
    await startLinked(
      withPorts([
        { port: 5432, kind: 'other', lanReachable: true },
        { port: 5173, kind: 'web', lanReachable: true },
      ]),
    );

    expect(pillOf(apiRow())?.textContent).toBe(':5173');
  });

  it('shows nothing for a service without ports', async () => {
    await startLinked();

    expect(pillOf(apiRow())).toBeNull();
  });
});
