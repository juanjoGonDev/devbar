import { describe, expect, it } from 'vitest';

import {
  aboutVersionLine,
  lastCheckLabel,
  releaseHighlights,
} from '../renderer/config/about-pane.js';

describe('renderer/config/about-pane.ts', () => {
  describe('aboutVersionLine', () => {
    it('names the version, the OS and the architecture', () => {
      expect(aboutVersionLine('0.11.1', 'darwin', 'arm64')).toBe(
        'Versión 0.11.1 · macOS arm64',
      );
    });

    it('uses the everyday name of each desktop OS', () => {
      expect(aboutVersionLine('1.0.0', 'win32', 'x64')).toBe(
        'Versión 1.0.0 · Windows x64',
      );
      expect(aboutVersionLine('1.0.0', 'linux', 'arm64')).toBe(
        'Versión 1.0.0 · Linux arm64',
      );
    });

    it('passes an OS it does not know through unchanged', () => {
      expect(aboutVersionLine('1.0.0', 'freebsd', 'x64')).toBe(
        'Versión 1.0.0 · freebsd x64',
      );
    });

    it('leaves out an architecture it was not given', () => {
      expect(aboutVersionLine('1.0.0', 'darwin', undefined)).toBe(
        'Versión 1.0.0 · macOS',
      );
    });

    it('says nothing without a version', () => {
      expect(aboutVersionLine('', 'darwin', 'arm64')).toBe('');
    });
  });
  describe('lastCheckLabel', () => {
    const now = new Date(2026, 9, 16, 18, 0);

    it('says "hoy" for a check earlier today', () => {
      expect(lastCheckLabel(new Date(2026, 9, 16, 14, 41), now)).toBe(
        'hoy a las 14:41',
      );
    });

    it('says "ayer" for a check the day before', () => {
      expect(lastCheckLabel(new Date(2026, 9, 15, 9, 5), now)).toBe(
        'ayer a las 09:05',
      );
    });

    it('names the date for anything older', () => {
      expect(lastCheckLabel(new Date(2026, 9, 3, 23, 59), now)).toBe(
        'el 03/10/2026 a las 23:59',
      );
    });

    it('accepts the timestamp main sends', () => {
      expect(lastCheckLabel(new Date(2026, 9, 16, 8, 0).getTime(), now)).toBe(
        'hoy a las 08:00',
      );
    });

    it('is null when nothing was ever checked or the value is unreadable', () => {
      expect(lastCheckLabel(null, now)).toBeNull();
      expect(lastCheckLabel('not a date', now)).toBeNull();
    });
  });

  describe('releaseHighlights', () => {
    it('keeps the bullets of the release notes', () => {
      const body = [
        '<!-- Release notes generated using configuration -->',
        "## What's Changed",
        '### Features',
        '* feat: control DevBar from your phone by @someone in https://github.com/o/r/pull/106',
        '- fix: keep the tray header from overflowing',
        '',
        '**Full Changelog**: https://github.com/o/r/compare/v1...v2',
      ].join('\n');
      expect(releaseHighlights(body)).toEqual([
        'feat: control DevBar from your phone',
        'fix: keep the tray header from overflowing',
      ]);
    });

    it('is empty for notes without bullets', () => {
      expect(releaseHighlights('')).toEqual([]);
      expect(releaseHighlights(undefined)).toEqual([]);
      expect(releaseHighlights('Solo texto.')).toEqual([]);
    });
  });
});
