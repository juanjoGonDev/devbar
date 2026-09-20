import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundled Noto Color Emoji face is a last-resort FALLBACK, and its
 * reach has to stay narrow: without a unicode-range it also claimed text
 * symbols its cmap carries (▶ above all), repainting the monospace log
 * font's glyphs as big color emoji — the logs became unreadable. These
 * assertions pin the CSS contract the fix depends on.
 */

const rendererDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer',
);

const emojiCss = readFileSync(path.join(rendererDir, 'emoji.css'), 'utf8');

describe('renderer/emoji.css', () => {
  it('restricts the bundled face with a unicode-range', () => {
    expect(emojiCss).toMatch(/@font-face\s*{[^}]*unicode-range:/s);
  });

  it('covers the real emoji blocks (symbols, dingbats, SMP)', () => {
    expect(emojiCss).toContain('U+2600-27bf');
    expect(emojiCss).toContain('U+1f000-1faff');
    // The variation selector: without it, emoji-presentation sequences
    // cannot compose.
    expect(emojiCss).toContain('U+fe0f');
  });

  /** The declared range, and only it: comments in the file may mention
   *  excluded codepoints (they do, when explaining the trade), so the
   *  exclusions below must scan the property value, not the whole file.
   *  The file writes hex lowercase after an uppercase 'U+' — the patterns
   *  used to be lowercase and could never match anything. */
  function declaredRange(): string {
    const match = emojiCss.match(/unicode-range:\s*([^;]+);/s);
    expect(match, 'unicode-range declared').not.toBeNull();
    return (match?.[1] ?? '').replace(/\s+/g, '');
  }

  it('keeps text symbols out of the emoji face', () => {
    const range = declaredRange();
    // ▶ (start lines in every service log), ⇄, ■ and friends must keep
    // resolving in the text font: the whole geometric-shapes block
    // (25xx) stays out. 26xx is NOT excluded — it holds real emoji
    // (☀ ⚡ …) — so the check pins the block, not the neighborhood.
    expect(range).not.toMatch(/U\+25[0-9a-f]{2}/);
    // ⏻ (U+23FB) is not an emoji and not even in the font — it must never
    // be listed as covered.
    expect(range).not.toContain('U+23fb');
    // Digits and latin-1 punctuation stay in the text font too.
    expect(range).not.toMatch(/U\+00[0-9a-f]{2}/);
  });

  it('is loaded after every window stylesheets', () => {
    // The face is a last resort: its link must come after the window's own
    // stylesheet so earlier families win per glyph.
    for (const html of [
      'config.html',
      'logs.html',
      'notification.html',
      'prescript-confirm.html',
      'silenced.html',
      'tray.html',
    ]) {
      const source = readFileSync(path.join(rendererDir, html), 'utf8');
      // The face link must come after EVERY stylesheet: its tag offset
      // must equal the max offset across all stylesheet links (its own
      // included, so the equality can only hold when nothing follows it).
      // The old fallback compared the face's offset with itself whenever
      // emoji.css was present — which was always.
      const faceLink = source.lastIndexOf(
        '<link rel="stylesheet" href="emoji.css',
      );
      const sheetOffsets = [...source.matchAll(/<link rel="stylesheet"/g)].map(
        (m) => m.index ?? -1,
      );
      expect(faceLink, html).toBeGreaterThanOrEqual(0);
      expect(sheetOffsets, html).toContain(faceLink);
      expect(faceLink, html).toBe(Math.max(...sheetOffsets));
    }
  });
});

describe('tray quit button glyph', () => {
  it('does not use ⏻ — no installed or bundled font carries it', () => {
    // Raspberry Pi OS has no font for U+23FB POWER SYMBOL and Noto Color
    // Emoji does not cover it either: the button rendered as tofu. ⏹
    // (U+23F9, an emoji codepoint) is covered everywhere.
    const tray = readFileSync(path.join(rendererDir, 'tray.html'), 'utf8');
    expect(tray).not.toContain('⏻');
    expect(tray).toMatch(/id="quit-app"[^>]*>\s*⏹\s*<\/button>/s);
  });
});
