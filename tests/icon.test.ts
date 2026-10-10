// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  hydrateIcons,
  icon,
  iconButton,
  customIconsVersion,
  isIconName,
  setCustomIcons,
  userIcon,
} from '../renderer/icon.js';
import { ICON_CODEPOINTS } from '../renderer/icon-codepoints.js';

/**
 * `renderer/icon.ts` is the only place a glyph is created: every icon is a
 * `<span class="icon">` holding the Lucide codepoint, decorative
 * (aria-hidden) so the control around it carries the accessible name.
 */

const glyph = (name: string): string =>
  String.fromCodePoint(ICON_CODEPOINTS[name] ?? 0);

describe('renderer/icon.ts', () => {
  it('builds a decorative span that paints the named glyph', () => {
    const el = icon('play');
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toBe('icon');
    expect(el.dataset.icon).toBe('play');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe(glyph('play'));
  });

  it('builds an icon-only button named by its label', () => {
    const btn = iconButton('trash-2', 'Borrar', 'small-btn danger');
    expect(btn.type).toBe('button');
    expect(btn.className).toBe('small-btn danger');
    expect(btn.title).toBe('Borrar');
    expect(btn.getAttribute('aria-label')).toBe('Borrar');
    expect(btn.querySelector<HTMLElement>('.icon')?.dataset.icon).toBe(
      'trash-2',
    );
  });

  it('tells Lucide names apart from anything else', () => {
    expect(isIconName('package')).toBe(true);
    expect(isIconName('📦')).toBe(false);
    expect(isIconName('')).toBe(false);
    expect(isIconName(null)).toBe(false);
    // Object.prototype members are not icons.
    expect(isIconName('constructor')).toBe(false);
  });

  describe('userIcon', () => {
    it('paints a stored Lucide name', () => {
      const el = userIcon('rocket', 'package');
      expect(el.dataset.icon).toBe('rocket');
      expect(el.textContent).toBe(glyph('rocket'));
    });

    it('falls back to the default icon when nothing is stored', () => {
      expect(userIcon(null, 'package').dataset.icon).toBe('package');
      expect(userIcon('', 'terminal').dataset.icon).toBe('terminal');
    });

    it('renders a leftover raw value (an unmigrated emoji) as text', () => {
      const el = userIcon('🦄', 'package');
      expect(el.className).toBe('icon icon-text');
      expect(el.dataset.icon).toBeUndefined();
      expect(el.textContent).toBe('🦄');
    });

    it('paints a glyph in the chosen colour, and a bad colour as none', () => {
      expect(userIcon('rocket', 'package', '#22c55e').style.color).toBe(
        'rgb(34, 197, 94)',
      );
      expect(userIcon('rocket', 'package', 'javascript:x').style.color).toBe(
        '',
      );
      expect(userIcon('rocket', 'package', null).style.color).toBe('');
      // The fallback glyph wears the colour too: it is the entity's icon.
      expect(userIcon(null, 'package', '#ef4444').style.color).toBe(
        'rgb(239, 68, 68)',
      );
    });

    describe('uploaded images', () => {
      const PNG = 'data:image/png;base64,iVBORw0KGgo=';

      it('paints a known img:<id> as an image in the icon box', () => {
        setCustomIcons([{ id: 'abc123', name: 'logo', dataUrl: PNG }]);
        const el = userIcon('img:abc123', 'package', '#22c55e');
        expect(el.className).toBe('icon icon-img');
        expect(el.dataset.icon).toBe('img:abc123');
        expect(el.getAttribute('aria-hidden')).toBe('true');
        const img = el.querySelector('img');
        expect(img?.getAttribute('src')).toBe(PNG);
        expect(img?.alt).toBe('');
        // Colour does not apply to images.
        expect(el.style.color).toBe('');
      });

      it('falls back to the default glyph for an unknown or deleted id', () => {
        setCustomIcons([]);
        const el = userIcon('img:gone12', 'terminal');
        expect(el.dataset.icon).toBe('terminal');
        expect(el.textContent).toBe(glyph('terminal'));
      });

      it('bumps a version on every library change, so painters repaint', () => {
        const before = customIconsVersion();
        setCustomIcons([{ id: 'abc123', name: 'logo', dataUrl: PNG }]);
        expect(customIconsVersion()).toBe(before + 1);
      });
    });
  });

  it('hydrates the static markup placeholders of a window', () => {
    document.body.innerHTML =
      '<button><span class="icon" data-icon="settings"></span></button>' +
      '<span class="icon" data-icon="not-an-icon"></span>';
    hydrateIcons(document);
    const [known, unknown] = document.querySelectorAll<HTMLElement>('.icon');
    expect(known?.textContent).toBe(glyph('settings'));
    expect(known?.getAttribute('aria-hidden')).toBe('true');
    // A typo in markup must not paint a random codepoint.
    expect(unknown?.textContent).toBe('');
  });
});
