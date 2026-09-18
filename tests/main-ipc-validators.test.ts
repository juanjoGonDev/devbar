import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  ipcBooleanField,
  ipcConfirmDecision,
  ipcGlobalSettingsPatch,
  ipcImportPreview,
  ipcNumber,
  ipcRecord,
  ipcSilenceLevel,
  ipcString,
  ipcStringArrayField,
  ipcStringField,
} from '../src/main/ipc-validators.js';

const preview = {
  groupsCount: 1,
  commandsCount: 2,
  actionsCount: 3,
  preStepsCount: 4,
  preScriptsCount: 5,
  hasGlobalSettings: true,
};

describe('src/main/ipc-validators.ts', () => {
  describe('errorMessage', () => {
    it('unwraps an Error and stringifies anything else', () => {
      expect(errorMessage(new Error('boom'))).toBe('boom');
      expect(errorMessage('plain')).toBe('plain');
      expect(errorMessage(42)).toBe('42');
    });
  });

  describe('ipcRecord', () => {
    it('accepts a plain object', () => {
      expect(ipcRecord({ a: 1 })).toEqual({ a: 1 });
    });

    it('rejects null, arrays and primitives with the label in the message', () => {
      expect(() => ipcRecord(null)).toThrow(/Invalid IPC payload/);
      expect(() => ipcRecord([], 'preview')).toThrow(/Invalid IPC preview/);
      expect(() => ipcRecord('x')).toThrow(TypeError);
    });
  });

  describe('ipcString / ipcStringField', () => {
    it('returns the string', () => {
      expect(ipcString('a', 'groupId')).toBe('a');
      expect(ipcStringField({ groupId: 'g' }, 'groupId')).toBe('g');
    });

    it('rejects a non-string', () => {
      expect(() => ipcString(1, 'groupId')).toThrow(/expected string/);
      expect(() => ipcStringField({ groupId: 1 }, 'groupId')).toThrow(
        TypeError,
      );
    });
  });

  describe('ipcStringArrayField', () => {
    it('returns an array of strings', () => {
      expect(ipcStringArrayField({ ids: ['a', 'b'] }, 'ids')).toEqual([
        'a',
        'b',
      ]);
    });

    it('rejects a mixed array or a non-array', () => {
      expect(() => ipcStringArrayField({ ids: ['a', 1] }, 'ids')).toThrow(
        /expected string\[\]/,
      );
      expect(() => ipcStringArrayField({ ids: 'a' }, 'ids')).toThrow(TypeError);
    });
  });

  describe('ipcBooleanField', () => {
    it('returns the boolean', () => {
      expect(ipcBooleanField({ enabled: false }, 'enabled')).toBe(false);
    });

    it('rejects a non-boolean', () => {
      expect(() => ipcBooleanField({ enabled: 'yes' }, 'enabled')).toThrow(
        /expected boolean/,
      );
    });
  });

  describe('ipcNumber', () => {
    it('returns a finite number', () => {
      expect(ipcNumber(3, 'position')).toBe(3);
    });

    it('rejects NaN, Infinity and non-numbers', () => {
      expect(() => ipcNumber(Number.NaN, 'position')).toThrow(/finite number/);
      expect(() => ipcNumber(Number.POSITIVE_INFINITY, 'p')).toThrow(TypeError);
      expect(() => ipcNumber('3', 'position')).toThrow(TypeError);
    });
  });

  describe('ipcSilenceLevel', () => {
    it('accepts warn and error only', () => {
      expect(ipcSilenceLevel('warn')).toBe('warn');
      expect(ipcSilenceLevel('error')).toBe('error');
      expect(() => ipcSilenceLevel('info')).toThrow(/silence level/);
    });
  });

  describe('ipcConfirmDecision', () => {
    it('accepts confirm and cancel only', () => {
      expect(ipcConfirmDecision('confirm')).toBe('confirm');
      expect(ipcConfirmDecision('cancel')).toBe('cancel');
      expect(() => ipcConfirmDecision('maybe')).toThrow(
        /confirmation decision/,
      );
    });
  });

  describe('ipcImportPreview', () => {
    it('keeps only the declared fields', () => {
      expect(ipcImportPreview({ ...preview, extra: 'dropped' })).toEqual(
        preview,
      );
    });

    it('rejects a non-boolean hasGlobalSettings and a non-numeric count', () => {
      expect(() =>
        ipcImportPreview({ ...preview, hasGlobalSettings: 'yes' }),
      ).toThrow(/hasGlobalSettings/);
      expect(() => ipcImportPreview({ ...preview, groupsCount: null })).toThrow(
        /groupsCount/,
      );
    });
  });

  describe('ipcGlobalSettingsPatch', () => {
    it('passes through only the fields present', () => {
      expect(
        ipcGlobalSettingsPatch({ autostart: true, maxLogLines: 500 }),
      ).toEqual({ autostart: true, maxLogLines: 500 });
    });

    it('ignores absent fields entirely', () => {
      expect(ipcGlobalSettingsPatch({})).toEqual({});
    });

    it('accepts each theme value', () => {
      for (const theme of ['auto', 'light', 'dark'] as const)
        expect(ipcGlobalSettingsPatch({ theme })).toEqual({ theme });
    });

    it('rejects a non-boolean flag, a bad theme and a bad retention', () => {
      expect(() => ipcGlobalSettingsPatch({ notifySuccess: 1 })).toThrow(
        /notifySuccess/,
      );
      expect(() => ipcGlobalSettingsPatch({ theme: 'sepia' })).toThrow(/theme/);
      expect(() => ipcGlobalSettingsPatch({ maxLogLines: 'lots' })).toThrow(
        /maxLogLines/,
      );
    });
  });
});
