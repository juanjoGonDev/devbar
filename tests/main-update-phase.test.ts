import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPhaseStore,
  isBusyPhase,
  phaseVersion,
} from '../src/main/update-phase.js';
import type { UpdatePhase } from '../src/ipc-contract.js';

describe('src/main/update-phase.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createPhaseStore', () => {
    it('starts idle and pushes every change', () => {
      const pushed: UpdatePhase[] = [];
      const store = createPhaseStore((phase) => pushed.push(phase));
      expect(store.get()).toEqual({ state: 'idle' });
      store.set({ state: 'checking' });
      expect(store.get()).toEqual({ state: 'checking' });
      expect(pushed).toEqual([{ state: 'checking' }]);
    });

    it.each<UpdatePhase>([
      { state: 'check-failed', reason: 'HTTP 403' },
      { state: 'download-failed', version: '1.3.0', reason: 'ECONNRESET' },
      { state: 'verify-failed', version: '1.3.0', reason: 'hash' },
      {
        state: 'install-failed',
        version: '1.3.0',
        reason: 'autenticación cancelada',
        path: '/tmp/a.deb',
        command: null,
      },
    ])('logs a $state with its reason under [updates]', (phase) => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      createPhaseStore(() => undefined).set(phase);
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0]);
      expect(line.startsWith('[updates]')).toBe(true);
      expect(line).toContain(phase.state);
      expect(line).toContain('reason' in phase ? phase.reason : '');
    });

    it('does not log progress or success', () => {
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const store = createPhaseStore(() => undefined);
      store.set({
        state: 'downloading',
        version: '1.3.0',
        received: 1,
        total: 2,
      });
      store.set({ state: 'available', version: '1.3.0' });
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('isBusyPhase', () => {
    it('is true only while something is running', () => {
      expect(
        isBusyPhase({
          state: 'downloading',
          version: '1',
          received: 0,
          total: null,
        }),
      ).toBe(true);
      expect(isBusyPhase({ state: 'verifying', version: '1' })).toBe(true);
      expect(isBusyPhase({ state: 'installing', version: '1' })).toBe(true);
      expect(isBusyPhase({ state: 'restarting', version: '1' })).toBe(true);
      expect(isBusyPhase({ state: 'idle' })).toBe(false);
      expect(isBusyPhase({ state: 'checking' })).toBe(false);
      expect(
        isBusyPhase({ state: 'download-failed', version: '1', reason: 'x' }),
      ).toBe(false);
    });
  });

  describe('phaseVersion', () => {
    it('reads the version a phase is about, or null', () => {
      expect(phaseVersion({ state: 'available', version: '1.3.0' })).toBe(
        '1.3.0',
      );
      expect(phaseVersion({ state: 'idle' })).toBeNull();
      expect(phaseVersion({ state: 'check-failed', reason: 'x' })).toBeNull();
    });
  });
});
