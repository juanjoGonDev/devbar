// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { markMatches, unmarkMatches } from '../renderer/logs/silence-marks.js';
import { compilePattern } from '../renderer/logs/silence-preview.js';

/**
 * `renderer/logs/silence-marks.ts` paints, inside a drawn log line, where a
 * previewed silence rule bites — and takes the paint off again without
 * leaving a trace in the line's text.
 */
function body(html: string): HTMLElement {
  const span = document.createElement('span');
  span.innerHTML = html;
  return span;
}

function marked(node: HTMLElement): string[] {
  return Array.from(node.querySelectorAll('mark'), (m) => m.textContent ?? '');
}

describe('renderer/logs/silence-marks.ts', () => {
  describe('markMatches', () => {
    it('wraps every match in a mark', () => {
      const node = body('Successfully compiled a, Successfully compiled b');
      markMatches(node, compilePattern('compiled'));
      expect(marked(node)).toEqual(['compiled', 'compiled']);
      expect(node.textContent).toBe(
        'Successfully compiled a, Successfully compiled b',
      );
    });

    it('follows a match across the colour spans of a line', () => {
      const node = body('<span style="color:red">Successfully</span> compiled');
      markMatches(node, compilePattern('fully comp'));
      expect(marked(node)).toEqual(['fully', ' comp']);
      expect(node.textContent).toBe('Successfully compiled');
    });

    it('leaves a line it does not match untouched', () => {
      const node = body('<b>otra</b> cosa');
      markMatches(node, compilePattern('nada'));
      expect(node.innerHTML).toBe('<b>otra</b> cosa');
    });
  });

  describe('unmarkMatches', () => {
    it('restores the line exactly as it was drawn', () => {
      const html = '<span style="color:red">Successfully</span> compiled';
      const node = body(html);
      markMatches(node, compilePattern('fully comp'));
      unmarkMatches(node);
      expect(node.innerHTML).toBe(html);
    });

    it('leaves marks it did not paint alone', () => {
      const node = body('<mark>ajeno</mark>');
      unmarkMatches(node);
      expect(marked(node)).toEqual(['ajeno']);
    });
  });
});
