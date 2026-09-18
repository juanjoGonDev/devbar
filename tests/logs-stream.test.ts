// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  drain,
  entry,
  mountLogsDom,
  type LogsDom,
} from './helpers/logs-dom.js';
import type { LogSource } from '../src/ipc-contract.js';

/**
 * `renderer/logs/stream.ts` is where the live feed races the snapshots that
 * replace it. Two things arrive from main at once — a snapshot the window
 * asked for, and the lines that keep coming while it is in flight — so every
 * load takes a ticket and the lines that arrive meanwhile are reconciled
 * against how far the snapshot actually got.
 *
 * These tests drive the interleavings directly: a snapshot resolved after a
 * newer one, a request that fails with lines held for it, a service that
 * starts talking after the merged view opened.
 */
type StreamModule = typeof import('../renderer/logs/stream.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');
type StatusModule = typeof import('../renderer/logs/status.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function source(id: string, name = id): LogSource {
  return { id, name, groupId: 'g1', groupName: 'Back' };
}

describe('renderer/logs/stream.ts', () => {
  let stream: StreamModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let status: StatusModule;
  let dom: LogsDom;
  let sourceReads: Deferred<LogSource[]>[];

  beforeEach(async () => {
    sourceReads = [];
    dom = mountLogsDom({
      api: {
        getMergedSources: () => {
          const next = deferred<LogSource[]>();
          sourceReads.push(next);
          return next.promise;
        },
      },
    });
    stream = await import('../renderer/logs/stream.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
    status = await import('../renderer/logs/status.js');
  });

  function drawn(): string[] {
    return Array.from(
      elements.linesEl.children,
      (row) => (row as HTMLElement).dataset.line ?? '',
    );
  }

  describe('a single service on screen', () => {
    beforeEach(() => {
      view.view.processId = 'api';
    });

    it('draws a line that belongs to it', () => {
      stream.receivePush({ id: 'api', entry: entry('hola') });
      expect(drawn()).toEqual(['hola']);
    });

    it('drops a line from a service the window is not showing', () => {
      stream.receivePush({ id: 'web', entry: entry('ajena') });
      expect(drawn()).toEqual([]);
    });

    it('holds it back instead while the viewer is paused', () => {
      elements.pausedEl.checked = true;
      stream.receivePush({ id: 'api', entry: entry('mientras') });
      expect(drawn()).toEqual([]);
      expect(status.pendingQueue.map((held) => held.line)).toEqual([
        'mientras',
      ]);
    });
  });

  describe('a snapshot in flight', () => {
    beforeEach(() => {
      view.view.processId = 'api';
    });

    it('holds arriving lines rather than letting the snapshot erase them', () => {
      stream.beginLoad();
      stream.receivePush({ id: 'api', entry: entry('mientras', { seq: 9 }) });
      expect(drawn()).toEqual([]);
    });

    it('delivers only what the snapshot did not already carry', () => {
      stream.beginLoad();
      stream.receivePush({ id: 'api', entry: entry('vieja', { seq: 4 }) });
      stream.receivePush({ id: 'api', entry: entry('justa', { seq: 5 }) });
      stream.receivePush({ id: 'api', entry: entry('nueva', { seq: 6 }) });
      stream.endLoad(() => 5);
      expect(drawn()).toEqual(['nueva']);
    });

    it('answers the watermark per source, not once for the whole batch', () => {
      view.view.processId = null;
      view.view.groupSources = new Map([
        ['api', source('api')],
        ['web', source('web')],
      ]);
      stream.beginLoad();
      stream.receivePush({ id: 'api', entry: entry('api vieja', { seq: 1 }) });
      stream.receivePush({ id: 'web', entry: entry('web nueva', { seq: 1 }) });
      stream.endLoad((id) => (id === 'api' ? 5 : 0));
      expect(drawn()).toEqual(['web nueva']);
    });

    it('retires the ticket of a load a newer one superseded', () => {
      const first = stream.beginLoad();
      const second = stream.beginLoad();
      expect(first()).toBe(false);
      expect(second()).toBe(true);
    });

    it('throws away the orphan queue of the load it supersedes', () => {
      // The snapshot about to be adopted covers everything the old queue held.
      stream.beginLoad();
      stream.receivePush({ id: 'api', entry: entry('huérfana', { seq: 9 }) });
      stream.beginLoad();
      stream.endLoad(() => 0);
      expect(drawn()).toEqual([]);
    });
  });

  describe('awaitSnapshot', () => {
    beforeEach(() => {
      view.view.processId = 'api';
    });

    it('hands the snapshot through untouched when the request succeeds', async () => {
      const token = stream.beginLoad();
      await expect(
        stream.awaitSnapshot(Promise.resolve('instantánea'), token),
      ).resolves.toBe('instantánea');
    });

    it('re-releases the held lines when the request fails', async () => {
      // Otherwise they sit in a queue nothing will ever drain — a silent mute.
      const token = stream.beginLoad();
      stream.receivePush({ id: 'api', entry: entry('mientras', { seq: 9 }) });
      const failing = stream.awaitSnapshot(
        Promise.reject(new Error('sin respuesta')),
        token,
      );
      await expect(failing).rejects.toThrow('sin respuesta');
      expect(drawn()).toEqual(['mientras']);
    });

    it('leaves the queue to its owner when a newer load already took over', async () => {
      const token = stream.beginLoad();
      stream.receivePush({ id: 'api', entry: entry('mientras', { seq: 9 }) });
      const failing = stream.awaitSnapshot(
        Promise.reject(new Error('sin respuesta')),
        token,
      );
      stream.beginLoad(); // a newer load owns the queue now
      await expect(failing).rejects.toThrow('sin respuesta');
      expect(drawn()).toEqual([]);
    });
  });

  describe('a merged view', () => {
    beforeEach(() => {
      view.view.processId = null;
      view.view.mergedGroupId = null;
      view.view.groupSources = new Map([['api', source('api', 'Api')]]);
    });

    it('tags a line with the service it came from', () => {
      stream.receivePush({ id: 'api', entry: entry('hola') });
      const row = elements.linesEl.firstElementChild as HTMLElement;
      expect(row.dataset.src).toBe('Api');
    });

    it('holds a merged line back while the viewer is paused', () => {
      elements.pausedEl.checked = true;
      stream.receivePush({ id: 'api', entry: entry('mientras') });
      expect(drawn()).toEqual([]);
      expect(status.pendingQueue).toHaveLength(1);
    });

    it('learns a service that only started talking after the view opened', async () => {
      // Main forwards it because the scope matches, so an unknown id means our
      // source list is stale — not that the line is foreign.
      stream.receivePush({ id: 'nuevo', entry: entry('primera') });
      expect(drawn()).toEqual([]);
      expect(sourceReads).toHaveLength(1);
      sourceReads[0]?.resolve([source('nuevo', 'Nuevo')]);
      await drain();
      expect(drawn()).toEqual(['primera']);
      expect(
        (elements.linesEl.firstElementChild as HTMLElement).dataset.src,
      ).toBe('Nuevo');
    });

    it('fires ONE lookup for a burst from the same new service', async () => {
      stream.receivePush({ id: 'nuevo', entry: entry('una') });
      stream.receivePush({ id: 'nuevo', entry: entry('otra') });
      stream.receivePush({ id: 'nuevo', entry: entry('tercera') });
      expect(sourceReads).toHaveLength(1);
      sourceReads[0]?.resolve([source('nuevo', 'Nuevo')]);
      await drain();
      expect(drawn()).toEqual(['una', 'otra', 'tercera']);
    });

    it('drops a line whose service is still unknown after the lookup', () => {
      stream.receivePush({ id: 'fantasma', entry: entry('sola') });
      sourceReads[0]?.resolve([]);
      return drain().then(() => {
        expect(drawn()).toEqual([]);
      });
    });

    it('asks main for the sources of the scope actually on screen', () => {
      view.view.mergedGroupId = 'g1';
      stream.receivePush({ id: 'nuevo', entry: entry('una') });
      expect(dom.argsFor('getMergedSources')).toEqual([['g1']]);
    });

    it('drops what it was holding when the view moved on mid-lookup', async () => {
      stream.receivePush({ id: 'nuevo', entry: entry('de la vista vieja') });
      stream.beginLoad(); // a scope switch: the old scope's lines are not ours
      sourceReads[0]?.resolve([source('nuevo', 'Nuevo')]);
      await drain();
      expect(drawn()).toEqual([]);
      // and the names of the old scope never reached the current map
      expect(view.view.groupSources?.has('nuevo')).toBe(false);
    });

    it('looks again for the lines that arrived AFTER that switch', async () => {
      stream.receivePush({ id: 'nuevo', entry: entry('de la vista vieja') });
      stream.beginLoad();
      stream.receivePush({
        id: 'nuevo',
        entry: entry('de la nueva', { seq: 5 }),
      });
      stream.endLoad(() => 0);
      expect(sourceReads).toHaveLength(1);
      sourceReads[0]?.resolve([source('nuevo', 'Nuevo')]);
      await drain();
      expect(sourceReads).toHaveLength(2);
      sourceReads[1]?.resolve([source('nuevo', 'Nuevo')]);
      await drain();
      expect(drawn()).toEqual(['de la nueva']);
    });

    it('a scope switch throws away the lines waiting on a name', async () => {
      stream.receivePush({ id: 'nuevo', entry: entry('vieja') });
      stream.dropUnknownSources();
      sourceReads[0]?.resolve([source('nuevo', 'Nuevo')]);
      await drain();
      expect(drawn()).toEqual([]);
    });
  });
});
