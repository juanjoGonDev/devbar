import { describe, expect, it } from 'vitest';
import {
  branchField,
  decisionField,
  idField,
  record,
  settingsPatch,
  tailParam,
} from '../src/main/remote/validate.js';

describe('src/main/remote/validate.ts', () => {
  describe('record', () => {
    it('accepts a plain object and nothing else', () => {
      expect(record({ a: 1 })).toEqual({ a: 1 });
      expect(record([])).toBeNull();
      expect(record(null)).toBeNull();
      expect(record('x')).toBeNull();
    });
  });

  describe('idField', () => {
    it('reads a short printable string', () => {
      expect(idField({ processId: 'cmd:g1:web' }, 'processId')).toBe(
        'cmd:g1:web',
      );
    });

    it.each([
      [{}],
      [{ processId: '' }],
      [{ processId: 42 }],
      [{ processId: 'a'.repeat(201) }],
      [{ processId: 'cmd:\u0000' }],
      [null],
    ])('refuses %j', (body) => {
      expect(idField(body, 'processId')).toBeNull();
    });
  });

  describe('decisionField', () => {
    it('knows the two answers of a confirmation', () => {
      expect(decisionField({ decision: 'confirm' })).toBe('confirm');
      expect(decisionField({ decision: 'cancel' })).toBe('cancel');
      expect(decisionField({ decision: 'maybe' })).toBeNull();
      expect(decisionField({})).toBeNull();
    });
  });

  describe('tailParam', () => {
    it('defaults to 300 lines and caps a request at 1000', () => {
      expect(tailParam(null)).toBe(300);
      expect(tailParam('50')).toBe(50);
      expect(tailParam('5000')).toBe(1000);
    });

    it.each(['0', '-3', '1.5', 'abc', ''])('refuses %j', (raw) => {
      expect(tailParam(raw)).toBeNull();
    });
  });

  describe('settingsPatch', () => {
    it('takes the whitelisted switches', () => {
      expect(
        settingsPatch({ notifySuccess: false, silenceErrors: true }),
      ).toEqual({ notifySuccess: false, silenceErrors: true });
      expect(settingsPatch({ autostart: true })).toEqual({ autostart: true });
    });

    it.each([
      [{}],
      [{ theme: 'dark' }],
      [{ notifySuccess: 'yes' }],
      [{ notifySuccess: true, maxLogLines: 1 }],
      [[]],
    ])('refuses %j', (body) => {
      expect(settingsPatch(body)).toBeNull();
    });
  });

  describe('branchField', () => {
    it('reads an ordinary branch name', () => {
      expect(branchField({ branch: 'feat/remote-control' })).toBe(
        'feat/remote-control',
      );
    });

    it.each(['--force', '-B', 'a b', 'a..b', 'a:b', '', 'x'.repeat(256)])(
      'refuses %j, which git could read as something else',
      (branch) => {
        expect(branchField({ branch })).toBeNull();
      },
    );
  });
});
