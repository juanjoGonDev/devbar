// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installUncaughtReporting,
  resetUncaughtReportingForTests,
} from '../renderer/report-uncaught.js';

/**
 * The module installs itself on import for its side effect, so each test
 * resets the guard and installs onto a fake window it can fire events at.
 * That keeps the real `window` out of it and makes the handlers callable
 * directly, which is the only way to assert what reaches the console.
 */

type Handler = (event: Event) => void;

function fakeWindow(): {
  target: Pick<Window, 'addEventListener'>;
  fire(type: string, event: unknown): void;
} {
  const handlers = new Map<string, Handler>();
  return {
    target: {
      addEventListener: ((type: string, handler: Handler) => {
        handlers.set(type, handler);
      }) as Pick<Window, 'addEventListener'>['addEventListener'],
    },
    fire(type, event) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`no handler for ${type}`);
      handler(event as Event);
    },
  };
}

let errors: string[];

describe('renderer/report-uncaught.ts', () => {
  beforeEach(() => {
    resetUncaughtReportingForTests();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUncaughtReportingForTests();
  });

  describe('uncaught errors', () => {
    it('reports the error with its name, message and position', () => {
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('error', {
        error: new TypeError('cannot read x'),
        filename: 'tray.js',
        lineno: 12,
        colno: 3,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('TypeError: cannot read x');
      expect(errors[0]).toContain('(tray.js:12:3)');
    });

    it('falls back to the message when no Error object came with the event', () => {
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('error', { error: null, message: 'Script error.' });
      expect(errors[0]).toContain('Script error.');
    });

    it('names the resource when a load failure carries neither', () => {
      // A missing stylesheet or script fires `error` with an empty message
      // and no Error — without the target's src the line would say nothing.
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('error', {
        error: null,
        message: '',
        target: { src: 'missing.js' },
      });
      expect(errors[0]).toContain('failed to load missing.js');
    });

    it('omits the position when the event carries no filename', () => {
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('error', { error: new Error('boom'), filename: '' });
      expect(errors[0]).toContain('Error: boom');
      expect(errors[0]).not.toContain('(:');
    });
  });

  describe('unhandled rejections', () => {
    it('reports a rejection that carries an Error', () => {
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('unhandledrejection', { reason: new Error('no network') });
      expect(errors[0]).toContain('Unhandled rejection: Error: no network');
    });

    it('reports a rejection that carries a plain string', () => {
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('unhandledrejection', { reason: 'nope' });
      expect(errors[0]).toBe('Unhandled rejection: nope');
    });

    it('serialises a rejection that carries an object', () => {
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('unhandledrejection', { reason: { ok: false, code: 7 } });
      expect(errors[0]).toContain('"code":7');
    });

    it('survives a reason that cannot be serialised', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const win = fakeWindow();
      installUncaughtReporting(win.target);
      win.fire('unhandledrejection', { reason: circular });
      expect(errors).toHaveLength(1);
    });
  });

  describe('installation', () => {
    it('ignores a second install so nothing is reported twice', () => {
      const first = fakeWindow();
      installUncaughtReporting(first.target);
      const second = fakeWindow();
      installUncaughtReporting(second.target);
      expect(() => second.fire('error', { error: new Error('x') })).toThrow(
        'no handler for error',
      );
      first.fire('error', { error: new Error('x') });
      expect(errors).toHaveLength(1);
    });
  });
});
