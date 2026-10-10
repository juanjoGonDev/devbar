import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICON_CODEPOINTS } from '../renderer/icon-codepoints.js';

/**
 * Every glyph of the UI comes from the bundled Lucide font. An emoji or a
 * pictographic symbol typed straight into the markup depends on the host's
 * fonts again: tofu on a Raspberry Pi, a different width per platform (the
 * row buttons that moved on Windows when ▶ became ■).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'renderer');
const iconsCss = readFileSync(path.join(rendererDir, 'icons.css'), 'utf8');

function rendererSources(dir: string = rendererDir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return rendererSources(full);
    return /\.(ts|html|css)$/.test(name) && name !== 'icon-codepoints.ts'
      ? [full]
      : [];
  });
}

/** Comments may name the glyphs they replaced; only code and markup count. */
function stripComments(source: string): string {
  let html = source;
  for (let prev = ''; prev !== html;) {
    prev = html;
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  }
  return html
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// Emoji and pictographic blocks, the arrows/shapes/dingbats the chrome used
// to type as glyphs (▶ ■ ▾ ✓ ✕ ✎ ⋮ ∥ ⇉ ↗ ↓ ◧ ⧉ ⏹ ⏱), and the emoji
// presentation selector. "→" inside Spanish prose is typography, not an
// icon, and stays allowed.
const GLYPH =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2190}-\u{2191}\u{2193}-\u{21FF}\u{2139}\u{2225}\u{22EE}\u{29C9}\u{FE0F}]/u;

describe('renderer/icons.css', () => {
  it('serves the bundled Lucide face from build/assets/fonts', () => {
    expect(iconsCss).toMatch(
      /@font-face\s*{[^}]*font-family:\s*'lucide'[^}]*url\(\.\.\/assets\/fonts\/lucide\.woff2\)\s*format\('woff2'\)/s,
    );
    // A local file: `swap` would only ever flash raw codepoints.
    expect(iconsCss).toMatch(/@font-face\s*{[^}]*font-display:\s*block/s);
  });

  it('gives every icon the same fixed square box', () => {
    const base = /\n\.icon\s*{([^}]*)}/.exec(iconsCss)?.[1] ?? '';
    expect(base).toMatch(/font-family:\s*'lucide'/);
    expect(base).toMatch(/width:\s*1em/);
    expect(base).toMatch(/height:\s*1em/);
    expect(base).toMatch(/flex:\s*0 0 auto/);
  });

  it('is linked by every window, before the emoji fallback face', () => {
    // remote.html is not a window: it is the «Control remoto» page phones
    // load over HTTP, which serves no font and draws no Lucide glyph.
    for (const html of readdirSync(rendererDir).filter(
      (n) => n.endsWith('.html') && n !== 'remote.html',
    )) {
      const source = readFileSync(path.join(rendererDir, html), 'utf8');
      const iconsLink = source.indexOf(
        '<link rel="stylesheet" href="icons.css',
      );
      expect(iconsLink, html).toBeGreaterThanOrEqual(0);
      expect(iconsLink, html).toBeLessThan(
        source.indexOf('<link rel="stylesheet" href="emoji.css'),
      );
    }
  });
});

describe('renderer glyphs', () => {
  it('keeps Lucide glyphs off the phone page, which has no icon font', () => {
    const page = readFileSync(path.join(rendererDir, 'remote.html'), 'utf8');
    expect(page).not.toMatch(/class="[^"]*\bicon\b/);
    expect(page).not.toContain('icons.css');
  });

  it('types no emoji or symbol glyph into code or markup', () => {
    const offenders = rendererSources().flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .filter((line) => GLYPH.test(line))
        .map((line) => `${path.relative(root, file)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('paints the CSS disclosure chevrons with the chevron-right glyph', () => {
    const css = readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    const hex = (ICON_CODEPOINTS['chevron-right'] ?? 0).toString(16);
    for (const selector of [
      '.logs-group > summary::before',
      '.cl-rel-summary::before',
    ]) {
      const at = css.indexOf(`${selector} {`);
      const rule = css.slice(at, css.indexOf('}', at));
      expect(rule, selector).toMatch(/font-family:\s*'lucide'/);
      expect(rule, selector).toContain(`content: '\\${hex}'`);
    }
  });

  it('paints the silenced-line mark with the bell-off glyph', () => {
    const logsCss = readFileSync(path.join(rendererDir, 'logs.css'), 'utf8');
    const rule = /\.line\.silenced::before\s*{([^}]*)}/.exec(logsCss)?.[1];
    const hex = (ICON_CODEPOINTS['bell-off'] ?? 0).toString(16);
    expect(rule).toMatch(/font-family:\s*'lucide'/);
    expect(rule).toContain(`content: '\\${hex}'`);
  });
});
