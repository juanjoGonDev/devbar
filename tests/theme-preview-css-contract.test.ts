import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The theme cards in Settings › General draw each theme as it looks, whatever
 * the window's own theme: every preview, and each half of «Automático», has
 * the border of the theme it shows — never the current theme's
 * `--border-strong`, which drew a light line beside the dark half in dark
 * mode and a dark one beside the light half in light mode. A static-source
 * contract over the shipped CSS, like mcp-confirm-css-contract.test.ts.
 */

const css = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../renderer/styles.css',
  ),
  'utf8',
);

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*{([^}]*)}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1] ?? '';
}

const LIGHT_BORDER = '#d3d3d4';
const DARK_BORDER = '#525254';

describe('theme previews (renderer/styles.css)', () => {
  it('never borrows the current theme for a preview border', () => {
    for (const selector of [
      '.theme-preview',
      '.theme-preview-light',
      '.theme-preview-dark',
      '.theme-preview-auto',
    ])
      expect(declarations(selector), selector).not.toMatch(/var\(--border/);
  });

  it('borders the light and dark previews with their own theme colour', () => {
    expect(declarations('.theme-preview-light')).toContain(LIGHT_BORDER);
    expect(declarations('.theme-preview-dark')).toContain(DARK_BORDER);
  });

  it('splits the auto border exactly where its background splits', () => {
    const auto = declarations('.theme-preview-auto');

    expect(auto).toContain(
      `linear-gradient(90deg, #f5f5f7 50%, #2c2c2e 50%) padding-box`,
    );
    expect(auto).toContain(
      `linear-gradient(90deg, ${LIGHT_BORDER} 50%, ${DARK_BORDER} 50%) border-box`,
    );
  });
});
