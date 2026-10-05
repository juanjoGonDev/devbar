import { describe, expect, it } from 'vitest';
import {
  harness,
  linkPhone,
  openEvents,
  reconnect,
} from './helpers/remote-control-harness.js';

/**
 * «¿Quién se ha conectado?»: a desktop banner when a linked device connects
 * — the first time since DevBar started, or after ten minutes away — with a
 * shortcut to the device list, and the same news in «Avisos» for the other
 * phones. Reloads, tab switches and reconnects say nothing.
 */

const MINUTE = 60_000;

describe('connection notices', () => {
  it('tells the desktop who connected, from where, with a way to the device list', async () => {
    const h = harness();
    await h.remote.setEnabled(true);

    await linkPhone(h);

    expect(h.banners).toEqual([
      {
        title: 'DevBar — control remoto',
        body: '«iPhone de Ana» se ha conectado desde 192.168.1.40.',
        options: {
          cta: { label: 'Ver dispositivos', action: 'open-remote' },
          record: false,
        },
      },
    ]);
  });

  it('says nothing for a reload, a reconnect or a stream opening', async () => {
    const h = harness();
    await h.remote.setEnabled(true);
    const phone = await linkPhone(h);
    const stream = openEvents(h, phone.channel);
    h.advance(30 * MINUTE);
    stream.close();
    h.advance(MINUTE);

    const again = await reconnect(h, phone);
    openEvents(h, again.channel);

    expect(h.banners).toHaveLength(1);
  });

  it('tells again about a device back after ten minutes away', async () => {
    const h = harness();
    await h.remote.setEnabled(true);
    const phone = await linkPhone(h);
    openEvents(h, phone.channel).close();

    h.advance(10 * MINUTE);
    await reconnect(h, phone);

    expect(h.banners).toHaveLength(2);
  });

  it('logs it in «Avisos» for every phone but the one that connected', async () => {
    const h = harness();
    await h.remote.setEnabled(true);
    const first = await linkPhone(h);
    const watching = openEvents(h, first.channel);

    const second = await linkPhone(h);

    expect(watching.events().at(-1)).toMatchObject({
      type: 'notice',
      data: {
        kind: 'info',
        title: 'Control remoto',
        body: '«iPhone de Ana» se ha conectado desde 192.168.1.40.',
      },
    });
    const own = await second.channel.send('notices');
    expect(own.body).toEqual({
      notices: [
        expect.objectContaining({
          body: expect.stringContaining('«iPhone de Ana»') as unknown,
        }),
      ],
    });
    // The first phone's own arrival is hidden from it, the second's is not.
    const seen = await first.channel.send('notices');
    expect((seen.body.notices as unknown[]).length).toBe(1);
  });

  it('shows no banner while the user has the notice switched off, and still logs it', async () => {
    const h = harness();
    await h.remote.setEnabled(true);
    const status = h.remote.setNotifyConnections(false);
    expect(status.notifyConnections).toBe(false);
    expect(h.stored()?.notifyConnections).toBe(false);
    const watcher = await linkPhone(h);
    const stream = openEvents(h, watcher.channel);

    await linkPhone(h);

    expect(h.banners).toEqual([]);
    expect(stream.events().at(-1)?.type).toBe('notice');
  });
});
