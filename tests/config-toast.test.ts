// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createToast, errorMessage } from '../renderer/config/toast.js';

function host(): HTMLElement {
  document.body.innerHTML = '<div id="toast"></div>';
  return document.getElementById('toast') as HTMLElement;
}

describe('renderer/config/toast.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('errorMessage', () => {
    it('takes the message off an Error', () => {
      expect(errorMessage(new Error('disk full'))).toBe('disk full');
    });

    it('stringifies anything else, including what main rejects with', () => {
      expect(errorMessage('plain string')).toBe('plain string');
      expect(errorMessage({ code: 7 })).toBe('[object Object]');
      expect(errorMessage(undefined)).toBe('undefined');
    });
  });

  describe('createToast', () => {
    it('shows the message as an "ok" toast by default', () => {
      const el = host();
      createToast(el)('Guardado');
      expect(el.textContent).toBe('Guardado');
      expect(el.className).toBe('toast ok');
      expect(el.style.display).toBe('block');
    });

    it('carries the kind it is given into the class', () => {
      const el = host();
      createToast(el)('Roto', 'error');
      expect(el.className).toBe('toast error');
    });

    it('hides itself again after a few seconds', () => {
      const el = host();
      createToast(el)('Guardado');
      vi.advanceTimersByTime(4499);
      expect(el.style.display).toBe('block');
      vi.advanceTimersByTime(1);
      expect(el.style.display).toBe('none');
    });

    it('restarts the countdown for a second message', () => {
      const el = host();
      const showToast = createToast(el);
      showToast('Primero');
      vi.advanceTimersByTime(4000);
      showToast('Segundo');
      vi.advanceTimersByTime(4000);
      expect(el.textContent, 'the first timer must not hide the second').toBe(
        'Segundo',
      );
      expect(el.style.display).toBe('block');
      vi.advanceTimersByTime(500);
      expect(el.style.display).toBe('none');
    });
  });
});
