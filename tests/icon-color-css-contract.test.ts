import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The colour swatches are <button>s, so the base `button` rule reaches them:
 * its `background: var(--btn-bg)` is a linear-gradient, i.e. a
 * background-image, which paints OVER the swatch's background-color — every
 * swatch rendered as the same grey bezel. Its padding and min-width stretched
 * them into pills. The swatch rule must undo all of it; a static-source
 * contract over the shipped CSS, like tray-row-css-contract.test.ts.
 */

const css = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../renderer/styles.css',
  ),
  'utf8',
);

/** Declarations of the LAST rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...css.matchAll(new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*{([^}]*)}`, 'g')),
  ];
  const body = matches.at(-1)?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((decl) => decl.split(':').map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length >= 2)
      .map(([prop, ...value]) => [prop, value.join(':')]),
  );
}

describe('icon colour split button CSS contract', () => {
  it('resets every piece of button chrome on a palette cell', () => {
    const cell = rule(
      '.icon-color-popover .icon-color-swatch,\n.icon-color-popover .icon-color-reset,\n.icon-color-popover .icon-color-custom-btn',
    );
    expect(cell).toMatchObject({
      width: '18px',
      height: '18px',
      'min-width': '0',
      'min-height': '0',
      padding: '0',
      'box-shadow': 'none',
      'border-radius': '50%',
      'background-image': 'none',
      flex: 'none',
    });
  });

  it('lays the palette out as a 6-column grid of 18px cells', () => {
    expect(rule('.icon-color-popover')).toMatchObject({
      display: 'grid',
      'grid-template-columns': 'repeat(6, 18px)',
      position: 'absolute',
    });
  });

  it('joins the icon button and the colour segment under one border', () => {
    expect(rule('.icon-split')).toMatchObject({
      position: 'relative',
      display: 'inline-flex',
      'border-radius': '8px',
    });
    expect(rule('.icon-color-trigger')).toMatchObject({
      'min-width': '0',
      padding: '0',
      'box-shadow': 'none',
      'background-image': 'none',
    });
    expect(rule('.icon-color-dot')).toMatchObject({
      width: '10px',
      height: '10px',
      'border-radius': '50%',
    });
  });

  it('drops the old always-visible swatch rows', () => {
    expect(css).not.toContain('.icon-color-control');
  });
});
