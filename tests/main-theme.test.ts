import { describe, expect, it } from 'vitest';
import {
  resolvedThemeIsDark,
  themeWindowBackground,
} from '../src/main/theme.js';

describe('src/main/theme.ts', () => {
  describe('resolvedThemeIsDark', () => {
    it('lets an explicit preference win over the OS', () => {
      expect(resolvedThemeIsDark('light', true)).toBe(false);
      expect(resolvedThemeIsDark('dark', false)).toBe(true);
    });

    it('follows the OS in auto mode', () => {
      expect(resolvedThemeIsDark('auto', true)).toBe(true);
      expect(resolvedThemeIsDark('auto', false)).toBe(false);
    });
  });

  describe('themeWindowBackground', () => {
    it('gives each theme an opaque colour', () => {
      expect(themeWindowBackground(true)).toBe('#1e1e1e');
      expect(themeWindowBackground(false)).toBe('#f5f5f7');
    });
  });
});
