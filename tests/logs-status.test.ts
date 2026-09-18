// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { entry, mountLogsDom } from './helpers/logs-dom.js';

/**
 * `renderer/logs/status.ts` is one strip of text answering three different
 * questions — how many lines are selected, how many arrived while paused,
 * whether a copy just succeeded — plus the queue that feeds the middle one.
 * They only behave correctly because they agree on who wrote last, so they are
 * driven together here, against the real footer markup.
 */
type StatusModule = typeof import('../renderer/logs/status.js');
type BufferModule = typeof import('../renderer/logs/buffer.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');

describe('renderer/logs/status.ts', () => {
  let status: StatusModule;
  let buffer: BufferModule;
  let elements: ElementsModule;

  beforeEach(async () => {
    mountLogsDom();
    status = await import('../renderer/logs/status.js');
    buffer = await import('../renderer/logs/buffer.js');
    elements = await import('../renderer/logs/elements.js');
  });

  function statusText(): string {
    return elements.statusEl.textContent ?? '';
  }

  describe('the paused queue', () => {
    it('holds an arriving line and says how many are waiting', () => {
      status.queueWhilePaused(entry('una'));
      status.queueWhilePaused(entry('otra'));
      expect(status.pendingQueue).toHaveLength(2);
      expect(statusText()).toBe('Pausado (+2)');
    });

    it('forgetting the queue while still paused falls back to the plain badge', () => {
      elements.pausedEl.checked = true;
      status.queueWhilePaused(entry('una'));
      status.dropPendingQueue();
      expect(status.pendingQueue).toHaveLength(0);
      expect(statusText()).toBe('Pausado');
    });

    it('forgetting the queue while live leaves the strip empty', () => {
      status.queueWhilePaused(entry('una'));
      status.dropPendingQueue();
      expect(statusText()).toBe('');
    });

    it('keeps only what the adopted snapshot does not already carry', () => {
      elements.pausedEl.checked = true;
      status.queueWhilePaused(entry('vieja', { seq: 4 }));
      status.queueWhilePaused(entry('justa', { seq: 5 }));
      status.queueWhilePaused(entry('nueva', { seq: 6 }));
      // The snapshot reached seq 5: everything at or below it is in there.
      status.keepQueuedAfter(() => 5);
      expect(status.pendingQueue.map((held) => held.line)).toEqual(['nueva']);
      expect(statusText()).toBe('Pausado (+1)');
    });

    it('drops a line with no sequence at all rather than showing it twice', () => {
      // `seq` is stamped by the buffer; a line without one cannot be proven
      // newer than the snapshot, and the snapshot is the one that is complete.
      status.queueWhilePaused(entry('sin seq'));
      status.keepQueuedAfter(() => 0);
      expect(status.pendingQueue).toHaveLength(0);
    });
  });

  describe('reportSelection', () => {
    it('counts the selection and offers to copy exactly that', () => {
      buffer.buffer.selected.add(1);
      buffer.buffer.selected.add(4);
      status.reportSelection();
      expect(statusText()).toBe('2 seleccionada(s)');
      expect(elements.copyBtn.title).toBe('Copiar 2 línea(s) seleccionada(s)');
    });

    it('clearing the selection falls back to the paused badge, not to nothing', () => {
      elements.pausedEl.checked = true;
      buffer.buffer.selected.add(1);
      status.reportSelection();
      buffer.buffer.selected.clear();
      status.reportSelection();
      expect(statusText()).toBe('Pausado');
      expect(elements.copyBtn.title).toBe('Copiar');
    });

    it('clearing the selection while live leaves the strip empty', () => {
      buffer.buffer.selected.add(1);
      status.reportSelection();
      buffer.buffer.selected.clear();
      status.reportSelection();
      expect(statusText()).toBe('');
    });
  });

  describe('repaintSelection', () => {
    function drawRows(indices: readonly number[]): HTMLElement[] {
      return indices.map((index) => {
        const row = document.createElement('div');
        row.className = 'line';
        row.dataset.eidx = String(index);
        elements.linesEl.appendChild(row);
        return row;
      });
    }

    it('marks the drawn rows the selection points at, and only those', () => {
      const [first, second, third] = drawRows([10, 11, 12]);
      buffer.buffer.selected.add(11);
      status.repaintSelection();
      expect(first?.classList.contains('selected')).toBe(false);
      expect(second?.classList.contains('selected')).toBe(true);
      expect(third?.classList.contains('selected')).toBe(false);
    });

    it('unmarks a row the selection no longer holds', () => {
      const [only] = drawRows([10]);
      buffer.buffer.selected.add(10);
      status.repaintSelection();
      buffer.buffer.selected.delete(10);
      status.repaintSelection();
      expect(only?.classList.contains('selected')).toBe(false);
    });

    it('reports the new count as it repaints', () => {
      drawRows([10, 11]);
      buffer.buffer.selected.add(10);
      buffer.buffer.selected.add(11);
      status.repaintSelection();
      expect(statusText()).toBe('2 seleccionada(s)');
    });

    it('survives a stray non-element node among the rows', () => {
      drawRows([10]);
      elements.linesEl.appendChild(document.createComment('nada'));
      buffer.buffer.selected.add(10);
      expect(() => status.repaintSelection()).not.toThrow();
      expect(statusText()).toBe('1 seleccionada(s)');
    });
  });
});
