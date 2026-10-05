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
 *
 * A sign-in from an IP the device has not used is another matter: a stolen
 * device key would show up exactly like that, so it is always said, loudly.
 */

const MINUTE = 60_000;
const NEW_IP_ALERT =
  '«iPhone de Ana» se ha conectado desde una IP nueva (192.168.1.57). Si no has sido tú, desvincúlalo.';

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

  describe('a sign-in from a new IP', () => {
    it('always warns the desktop: whatever the switch, however recent', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      h.remote.setNotifyConnections(false);
      const phone = await linkPhone(h);

      await reconnect(h, phone, h.netFrom('192.168.1.57'));

      expect(h.banners).toEqual([
        {
          title: 'DevBar — control remoto',
          body: NEW_IP_ALERT,
          options: {
            cta: { label: 'Ver dispositivos', action: 'open-remote' },
            record: false,
          },
        },
      ]);
    });

    it('keeps the new IP as the one the device last used', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const phone = await linkPhone(h);
      expect(h.remote.status().devices[0]?.lastIp).toBe('192.168.1.40');

      await reconnect(h, phone, h.netFrom('192.168.1.57'));

      expect(h.remote.status().devices[0]?.lastIp).toBe('192.168.1.57');
      expect(h.stored()?.devices[0]?.lastIp).toBe('192.168.1.57');
    });

    it('says nothing for the IP it paired from, nor twice for the same new one', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const phone = await linkPhone(h);
      const there = h.netFrom('192.168.1.57');

      await reconnect(h, phone, there);
      await reconnect(h, phone, there);

      expect(h.banners.map((banner) => banner.body)).toEqual([
        '«iPhone de Ana» se ha conectado desde 192.168.1.40.',
        NEW_IP_ALERT,
      ]);
    });

    it('logs it in «Avisos» for the other phones', async () => {
      const h = harness();
      await h.remote.setEnabled(true);
      const watcher = await linkPhone(h);
      const stream = openEvents(h, watcher.channel);
      const phone = await linkPhone(h);

      await reconnect(h, phone, h.netFrom('192.168.1.57'));

      expect(stream.events().at(-1)).toMatchObject({
        type: 'notice',
        data: { kind: 'error', title: 'Control remoto', body: NEW_IP_ALERT },
      });
    });
  });
});
