import { describe, expect, it } from 'vitest';
import {
  bannerNotice,
  createNoticeLog,
  toastNotice,
} from '../src/main/remote/notices.js';

describe('src/main/remote/notices.ts', () => {
  describe('toastNotice', () => {
    it.each([
      ['ok', 'success'],
      ['error', 'error'],
      ['warn', 'info'],
      ['info', 'info'],
    ])('reads a %s toast as a %s notice', (kind, expected) => {
      expect(toastNotice(kind, 'Backend · API exited 1')).toEqual({
        kind: expected,
        title: 'Backend · API exited 1',
        body: '',
      });
    });
  });

  describe('bannerNotice', () => {
    it('reads a banner that offers to update as an update notice', () => {
      expect(
        bannerNotice({
          title: 'DevBar — actualización',
          body: 'v0.12.0 lista. Reinicia para instalarla.',
          action: 'install-update',
        }),
      ).toEqual({
        kind: 'update',
        title: 'Actualización',
        body: 'v0.12.0 lista. Reinicia para instalarla.',
      });
    });

    it('tells a scheduled action that failed from one that finished', () => {
      const failed = bannerNotice({
        title: 'DevBar — acción programada',
        body: 'Backend · Backup: falló (código 2)',
        action: null,
      });
      const done = bannerNotice({
        title: 'DevBar — acción programada',
        body: 'Backend · Backup: completada',
        action: null,
      });

      expect(failed.kind).toBe('error');
      expect(done).toEqual({
        kind: 'scheduled',
        title: 'Acción programada',
        body: 'Backend · Backup: completada',
      });
    });

    it('reads the pipeline completion as a success', () => {
      expect(
        bannerNotice({
          title: 'DevBar — pre-scripts',
          body: 'Pipeline completado (3 pasos)',
          action: null,
        }).kind,
      ).toBe('success');
    });

    it('keeps any other banner as information, title and all', () => {
      expect(
        bannerNotice({ title: 'Hola', body: 'mundo', action: null }),
      ).toEqual({ kind: 'info', title: 'Hola', body: 'mundo' });
    });
  });

  describe('createNoticeLog', () => {
    it('stamps each notice and lists the newest first', () => {
      let clock = 100;
      const log = createNoticeLog({ now: () => clock });

      log.add({ kind: 'info', title: 'a', body: '' });
      clock = 200;
      const second = log.add({ kind: 'error', title: 'b', body: '' });

      expect(second).toEqual({
        id: 2,
        ts: 200,
        kind: 'error',
        title: 'b',
        body: '',
      });
      expect(log.list().map((notice) => notice.title)).toEqual(['b', 'a']);
    });

    it('keeps a notice out of the list of the one device it is hidden from', () => {
      const log = createNoticeLog({ now: () => 1 });

      log.add({ kind: 'info', title: 'for all', body: '' });
      const hidden = log.add({ kind: 'info', title: 'not d1', body: '' }, 'd1');

      expect(hidden).toEqual({
        id: 2,
        ts: 1,
        kind: 'info',
        title: 'not d1',
        body: '',
      });
      expect(log.list('d1').map((n) => n.title)).toEqual(['for all']);
      expect(log.list('d2').map((n) => n.title)).toEqual(['not d1', 'for all']);
      expect(log.list()).toHaveLength(2);
    });

    it('keeps only the most recent fifty', () => {
      const log = createNoticeLog({ now: () => 1 });

      for (let i = 1; i <= 55; i++)
        log.add({ kind: 'info', title: `n${i}`, body: '' });

      expect(log.list()).toHaveLength(50);
      expect(log.list().at(-1)?.title).toBe('n6');
      expect(log.list()[0]?.id).toBe(55);
    });
  });
});
